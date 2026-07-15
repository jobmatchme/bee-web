#!/usr/bin/env node
import { type BeeResolvedTurn, type BeeRunEvent, NatsBeeClient, newTurnId } from "@jobmatchme/bee-gate";
import { connect } from "nats";
import { loadConfig } from "./config.js";
import {
	createErrorEvent,
	createUserMessageEvent,
	mapBeeEventToDashboardEvents,
	sanitizeRunError,
} from "./event-mapper.js";
import { HistoryClient } from "./history-client.js";
import { findRoute, getRouteHistoryAgentId } from "./router.js";
import { createWebGatewayServer } from "./server.js";
import { SessionApiError, SharedDeskSessionApiClient } from "./session-api-client.js";
import { SseFanout } from "./sse.js";

interface ActiveRun {
	turnId: string;
	routeId: string;
	route: BeeResolvedTurn["worker"];
	threadId?: string;
	controller: AbortController;
	actorEmail: string;
}

export async function startWebGatewayFromEnv(configPath?: string): Promise<void> {
	const config = loadConfig(configPath);
	const connection = await connect(config.nats);
	const workerClient = new NatsBeeClient(connection);
	const historyClient =
		config.history?.baseUrl && config.history?.bearerToken
			? new HistoryClient({
					baseUrl: config.history.baseUrl,
					bearerToken: config.history.bearerToken,
				})
			: undefined;
	const sessionApi = config.sessionApi?.baseUrl
		? new SharedDeskSessionApiClient({
				baseUrl: config.sessionApi.baseUrl,
				bearerToken: config.sessionApi.bearerToken,
			})
		: undefined;
	const fanout = new SseFanout();
	const sessionQueues = new Map<string, { tail: Promise<void>; waiting: number }>();
	const activeRuns = new Map<string, ActiveRun>();

	const gateway = createWebGatewayServer(config, {
		fanout,
		sessionApi,
		history: historyClient
			? {
					listSessions: async ({ user, routeId, limit }) => {
						const routes = routeId
							? [findRoute(config, routeId)].filter((route): route is NonNullable<typeof route> =>
									Boolean(route),
								)
							: config.routes;
						const sessions = await Promise.all(
							routes.flatMap((route) => {
								const agentId = getRouteHistoryAgentId(route);
								if (!agentId) return [];
								return [
									historyClient
										.listSessions(agentId, user.userKey, limit)
										.then((items) => items.map((item) => ({ ...item, routeId: route.id, agentId }))),
								];
							}),
						);
						return sessions
							.flat()
							.sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""))
							.slice(0, limit);
					},
					getSession: async ({ user, sessionId }) => historyClient.getSession(sessionId, user.userKey),
					getSessionRuns: async ({ user, sessionId }) => historyClient.getSessionRuns(sessionId, user.userKey),
				}
			: undefined,
		handleMessage: ({ sessionId, conversationId, route, routeId, operatorId, text, user, reauthorize }) => {
			const input: BeeResolvedTurn = {
				sessionId,
				worker: route.worker,
				conversation: {
					conversationId,
					transport: "web",
				},
				actor: {
					userId: `web:${user.userKey}`,
					displayName: operatorId,
					email: user.email,
				} as BeeResolvedTurn["actor"],
				message: {
					text,
				},
				output: {},
			};
			const turnId = newTurnId();
			const queue = sessionQueues.get(sessionId) ?? { tail: Promise.resolve(), waiting: 0 };
			const queued = activeRuns.has(sessionId) || queue.waiting > 0;
			if (queue.waiting >= 10) throw new Error("Session queue is full");
			const controller = new AbortController();
			let leftQueue = false;
			const runTask = async () => {
				try {
					await reauthorize();
				} catch {
					queue.waiting -= 1;
					leftQueue = true;
					fanout.finish(sessionId, turnId, "cancelled", "access-revoked");
					return;
				}
				queue.waiting -= 1;
				leftQueue = true;
				fanout.start(sessionId, turnId);
				activeRuns.set(sessionId, { turnId, routeId, route: route.worker, controller, actorEmail: user.email });
				try {
					await workerClient.streamTurn(
						route.worker,
						{
							sessionId: input.sessionId,
							threadId: input.threadId,
							turnId,
							conversation: input.conversation,
							actor: input.actor,
							message: input.message,
							attachments: input.attachments,
						},
						(event: BeeRunEvent) => {
							for (const dashboardEvent of mapBeeEventToDashboardEvents(event)) {
								if (dashboardEvent.type === "artifact.created") {
									gateway.registerArtifact(sessionId, dashboardEvent.artifact);
									fanout.addArtifact(sessionId, dashboardEvent.artifact);
								}
								fanout.broadcast(sessionId, dashboardEvent.type, dashboardEvent);
							}
						},
						{ signal: controller.signal },
					);
					fanout.finish(sessionId, turnId, "completed");
				} catch (error) {
					const dashboardEvent = createErrorEvent(sessionId, error, turnId);
					fanout.broadcast(sessionId, dashboardEvent.type, dashboardEvent);
					fanout.finish(
						sessionId,
						turnId,
						controller.signal.aborted ? "cancelled" : "failed",
						sanitizeRunError(error),
					);
				} finally {
					activeRuns.delete(sessionId);
				}
			};
			fanout.enqueue(sessionId, { turnId, actorEmail: user.email, text });
			queue.waiting += 1;
			const next = queue.tail
				.catch(() => undefined)
				.then(runTask)
				.finally(() => {
					if (!leftQueue) queue.waiting -= 1;
					if (sessionQueues.get(sessionId)?.tail === next && queue.waiting === 0) {
						sessionQueues.delete(sessionId);
					}
				});
			queue.tail = next;
			sessionQueues.set(sessionId, queue);

			const userMessageEvent = createUserMessageEvent({
				sessionId,
				routeId,
				operatorId,
				actorEmail: user.email,
				text,
				turnId,
			});
			fanout.broadcast(sessionId, userMessageEvent.type, userMessageEvent);
			return { accepted: true, queued, turnId };
		},
		canArchive: (sessionId) => !activeRuns.has(sessionId) && !sessionQueues.has(sessionId),
		handleCancel: async ({ sessionId, turnId, user }) => {
			const active = activeRuns.get(sessionId);
			if (!active || active.turnId !== turnId) return { cancelled: false };
			if (sessionApi && active.routeId === "fabee") {
				const capabilities = await sessionApi.getCapabilities(sessionId, user.email, active.actorEmail);
				if (capabilities.role !== "owner" && active.actorEmail !== user.email) {
					throw new SessionApiError("Session not found", 404);
				}
			} else if (active.actorEmail !== user.email) {
				return { cancelled: false };
			}
			active.controller.abort();
			return { cancelled: true };
		},
	});
	const { server } = gateway;

	server.once("close", () => {
		void workerClient.close?.();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	console.error(`bee-web listening on http://${config.host}:${config.port}`);
}

const configPath = process.argv[2];
startWebGatewayFromEnv(configPath).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});

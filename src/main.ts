#!/usr/bin/env node
import { type BeeResolvedTurn, type BeeRunEvent, NatsBeeClient, newTurnId } from "@jobmatchme/bee-gate";
import { connect } from "nats";
import { loadConfig } from "./config.js";
import { createErrorEvent, createUserMessageEvent, mapBeeEventToDashboardEvents } from "./event-mapper.js";
import { HistoryClient } from "./history-client.js";
import { findRoute, getConversationIdForSession, getRouteHistoryAgentId } from "./router.js";
import { createWebGatewayServer } from "./server.js";
import { SseFanout } from "./sse.js";

interface ActiveRun {
	turnId: string;
	route: BeeResolvedTurn["worker"];
	threadId?: string;
	controller: AbortController;
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
	const fanout = new SseFanout();
	const sessionQueues = new Map<string, Promise<void>>();
	const activeRuns = new Map<string, ActiveRun>();

	const gateway = createWebGatewayServer(config, {
		fanout,
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
		handleMessage: ({ sessionId, route, routeId, operatorId, text, user }) => {
			const input: BeeResolvedTurn = {
				sessionId,
				worker: route.worker,
				conversation: {
					conversationId: getConversationIdForSession(route, sessionId),
					transport: "web",
				},
				actor: {
					userId: user ? `web:${user.userKey}` : `web:${operatorId}`,
					displayName: operatorId,
				},
				message: {
					text,
				},
				output: {},
			};
			const turnId = newTurnId();
			const queued = sessionQueues.has(sessionId);
			const controller = new AbortController();
			const runTask = async () => {
				activeRuns.set(sessionId, { turnId, route: route.worker, controller });
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
								}
								fanout.broadcast(sessionId, dashboardEvent.type, dashboardEvent);
							}
						},
						{ signal: controller.signal },
					);
				} catch (error) {
					const dashboardEvent = createErrorEvent(sessionId, error, turnId);
					fanout.broadcast(sessionId, dashboardEvent.type, dashboardEvent);
				} finally {
					activeRuns.delete(sessionId);
				}
			};
			const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
			const next = previous
				.catch(() => undefined)
				.then(runTask)
				.finally(() => {
					if (sessionQueues.get(sessionId) === next) {
						sessionQueues.delete(sessionId);
					}
				});
			sessionQueues.set(sessionId, next);

			const userMessageEvent = createUserMessageEvent({
				sessionId,
				routeId,
				operatorId,
				text,
				turnId,
			});
			fanout.broadcast(sessionId, userMessageEvent.type, userMessageEvent);
			return { accepted: true, queued, turnId };
		},
		handleCancel: async ({ sessionId }) => {
			const active = activeRuns.get(sessionId);
			if (!active) return { cancelled: false };
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

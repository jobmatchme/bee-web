import { createReadStream } from "fs";
import { stat } from "fs/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";
import { basename, extname, join, resolve } from "path";
import { DEFAULT_EMAIL_HEADERS, deriveUserKeyFromEmail, getAuthenticatedWebUser } from "./auth.js";
import { createWebSession, findRoute, toPublicRoute } from "./router.js";
import { SessionApiError, type SharedDeskSessionApi } from "./session-api-client.js";
import { SseFanout } from "./sse.js";
import type {
	HistoryRunRecord,
	HistorySessionDetailRecord,
	HistorySessionSummaryRecord,
	WebGatewayConfig,
	WebRouteConfig,
	WebSessionRecord,
} from "./types.js";

interface MessageBody {
	text?: string;
}

interface CollaboratorsBody {
	collaborators?: string[];
}

export interface RegisteredArtifact {
	id: string;
	blobKey?: string;
	name?: string;
	title?: string;
	mimeType?: string;
	uri?: string;
	sizeBytes?: number;
	createdAt?: string;
}

export interface WebMessageRequest {
	sessionId: string;
	conversationId: string;
	route: WebRouteConfig;
	routeId: string;
	operatorId: string;
	text: string;
	user: {
		email: string;
		userKey: string;
		operatorId: string;
	};
	reauthorize: () => Promise<void>;
}

export interface WebMessageDispatchResult {
	accepted?: boolean;
	queued?: boolean;
	turnId?: string;
}

export interface WebCancelRequest {
	sessionId: string;
	turnId: string;
	user: { email: string; userKey: string; operatorId: string };
}

export interface WebCancelResult {
	cancelled: boolean;
}

export interface WebHistoryListRequest {
	user: {
		email: string;
		userKey: string;
		operatorId: string;
	};
	routeId?: string;
	limit: number;
}

export interface WebHistorySessionRequest {
	user: {
		email: string;
		userKey: string;
		operatorId: string;
	};
	sessionId: string;
}

export interface CreateWebGatewayServerOptions {
	fanout?: SseFanout;
	sessionApi?: SharedDeskSessionApi;
	handleMessage?: (request: WebMessageRequest) => Promise<WebMessageDispatchResult> | WebMessageDispatchResult;
	handleCancel?: (request: WebCancelRequest) => Promise<WebCancelResult | boolean> | WebCancelResult | boolean;
	canArchive?: (sessionId: string) => boolean;
	history?: {
		listSessions?: (
			request: WebHistoryListRequest,
		) => Promise<HistorySessionSummaryRecord[]> | HistorySessionSummaryRecord[];
		getSession?: (
			request: WebHistorySessionRequest,
		) => Promise<HistorySessionDetailRecord> | HistorySessionDetailRecord;
		getSessionRuns?: (request: WebHistorySessionRequest) => Promise<HistoryRunRecord[]> | HistoryRunRecord[];
	};
}

function getPathname(url: string | undefined): string {
	return new URL(url ?? "/", "http://localhost").pathname;
}

function getSearchParams(url: string | undefined): URLSearchParams {
	return new URL(url ?? "/", "http://localhost").searchParams;
}

function applyCors(config: WebGatewayConfig, req: IncomingMessage, res: ServerResponse): void {
	const origin = req.headers.origin;
	const allowedOrigins = config.cors?.origins ?? ["*"];
	const allowOrigin =
		allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin)) ? origin || "*" : allowedOrigins[0];

	res.setHeader("access-control-allow-origin", allowOrigin ?? "*");
	res.setHeader("vary", "Origin");
	res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
	res.setHeader(
		"access-control-allow-headers",
		"Content-Type, Last-Event-ID, X-Forwarded-Email, X-Auth-Request-Email",
	);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	if (chunks.length === 0) return null;
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return null;
	return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function errorStatus(error: unknown, fallback = 400): number {
	return error instanceof SessionApiError ? error.status : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseDataUri(uri: string): { mimeType?: string; data: Buffer } | undefined {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
	if (!match) return undefined;
	return {
		mimeType: match[1] || undefined,
		data: match[2] ? Buffer.from(match[3] || "", "base64") : Buffer.from(decodeURIComponent(match[3] || ""), "utf8"),
	};
}

function extensionForMimeType(mimeType?: string): string {
	if (mimeType === "text/csv") return ".csv";
	if (mimeType === "application/json") return ".json";
	if (mimeType === "text/html") return ".html";
	if (mimeType === "application/pdf") return ".pdf";
	return "";
}

function artifactFilename(artifact: RegisteredArtifact): string {
	const raw = artifact.name || artifact.title || artifact.id;
	const filename = basename(raw).replace(/[^a-zA-Z0-9._-]+/g, "_") || artifact.id;
	return extname(filename) ? filename : `${filename}${extensionForMimeType(artifact.mimeType)}`;
}

function attachmentHeaders(artifact: RegisteredArtifact, contentLength?: number): Record<string, string | number> {
	return {
		"content-type": artifact.mimeType || "application/octet-stream",
		"content-disposition": `attachment; filename="${artifactFilename(artifact).replace(/"/g, "")}"`,
		...(contentLength !== undefined ? { "content-length": contentLength } : {}),
	};
}

function matchSessionEndpoint(
	pathname: string,
): { sessionId: string; action: "detail" | "events" | "messages" | "collaborators" | "archive" } | null {
	const detail = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
	if (detail) return { sessionId: decodeURIComponent(detail[1]!), action: "detail" };
	const match = /^\/api\/sessions\/([^/]+)\/(events|messages|collaborators|archive)$/.exec(pathname);
	if (!match) return null;
	return {
		sessionId: decodeURIComponent(match[1]!),
		action: match[2] as "events" | "messages" | "collaborators" | "archive",
	};
}

function matchCancelEndpoint(pathname: string): { sessionId: string; turnId: string } | null {
	const match = /^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(pathname);
	if (!match) return null;
	return { sessionId: decodeURIComponent(match[1]!), turnId: decodeURIComponent(match[2]!) };
}

function matchArtifactEndpoint(pathname: string): { sessionId: string; artifactId: string } | null {
	const match = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)\/download$/.exec(pathname);
	if (!match) return null;
	return {
		sessionId: decodeURIComponent(match[1]!),
		artifactId: decodeURIComponent(match[2]!),
	};
}

function matchHistoryEndpoint(pathname: string): { sessionId?: string; action: "list" | "detail" | "runs" } | null {
	if (pathname === "/api/history/sessions") return { action: "list" };
	const runsMatch = /^\/api\/history\/sessions\/([^/]+)\/runs$/.exec(pathname);
	if (runsMatch) return { action: "runs", sessionId: decodeURIComponent(runsMatch[1]!) };
	const detailMatch = /^\/api\/history\/sessions\/([^/]+)$/.exec(pathname);
	if (detailMatch) return { action: "detail", sessionId: decodeURIComponent(detailMatch[1]!) };
	return null;
}

function getRequiredString(value: string | undefined, field: string): { value: string } | { error: string } {
	const normalized = value?.trim();
	if (!normalized) return { error: `${field} is required` };
	return { value: normalized };
}

function getHistoryLimit(config: WebGatewayConfig, req: IncomingMessage): number {
	const raw = getSearchParams(req.url).get("limit")?.trim();
	if (!raw) return config.history?.defaultLimit ?? 50;
	const limit = Number.parseInt(raw, 10);
	if (!Number.isFinite(limit) || limit <= 0) {
		throw new Error("limit must be a positive integer");
	}
	return Math.min(limit, 50);
}

function requireAuthenticatedUser(config: WebGatewayConfig, req: IncomingMessage) {
	const user = getAuthenticatedWebUser(req, config.auth?.emailHeaders ?? DEFAULT_EMAIL_HEADERS);
	if (!user) {
		throw new Error("Authenticated user email header is required");
	}
	return user;
}

function firstRoute(config: WebGatewayConfig): WebRouteConfig {
	const route = config.routes[0];
	if (!route) throw new Error("No routes configured");
	return route;
}

async function sendArtifact(
	config: WebGatewayConfig,
	artifact: RegisteredArtifact,
	res: ServerResponse,
): Promise<void> {
	if (artifact.uri) {
		if (!artifact.uri.startsWith("data:")) {
			res.writeHead(302, { location: artifact.uri });
			res.end();
			return;
		}

		const parsed = parseDataUri(artifact.uri);
		if (!parsed) {
			sendJson(res, 404, { error: "Artifact payload not available" });
			return;
		}
		const withMime = { ...artifact, mimeType: artifact.mimeType || parsed.mimeType };
		res.writeHead(200, attachmentHeaders(withMime, parsed.data.byteLength));
		res.end(parsed.data);
		return;
	}

	if (!artifact.blobKey || !config.artifactStore?.rootDir) {
		sendJson(res, 404, { error: "Artifact payload not available" });
		return;
	}

	const root = resolve(config.artifactStore.rootDir);
	const path = resolve(join(root, artifact.blobKey));
	if (!path.startsWith(`${root}/`) && path !== root) {
		sendJson(res, 400, { error: "Invalid artifact path" });
		return;
	}

	const details = await stat(path);
	res.writeHead(200, attachmentHeaders(artifact, details.size));
	createReadStream(path).pipe(res);
}

export function createWebGatewayServer(config: WebGatewayConfig, options: CreateWebGatewayServerOptions = {}) {
	const fanout = options.fanout ?? new SseFanout();
	const sessions = new Map<string, { session: WebSessionRecord; userKey: string }>();
	const artifacts = new Map<string, RegisteredArtifact>();
	const artifactKey = (sessionId: string, artifactId: string) => `${sessionId}\0${artifactId}`;
	const registerArtifact = (sessionId: string, artifact: RegisteredArtifact): void => {
		const key = artifactKey(sessionId, artifact.id);
		artifacts.set(key, { ...artifacts.get(key), ...artifact });
	};
	const requireSession = async (sessionId: string, req: IncomingMessage) => {
		const user = requireAuthenticatedUser(config, req);
		const session = options.sessionApi
			? await options.sessionApi.requireSessionAccess(sessionId, user.email)
			: sessions.get(sessionId)?.session;
		if (!session || (!options.sessionApi && sessions.get(sessionId)?.userKey !== user.userKey)) {
			throw new SessionApiError("Session not found", 404);
		}
		const route = findRoute(config, session.routeId);
		if (!route) throw new SessionApiError("Session not found", 404);
		return { session, route, user };
	};
	const server = createServer(async (req, res) => {
		applyCors(config, req, res);

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const method = req.method ?? "GET";
		const pathname = getPathname(req.url);

		if (method === "GET" && pathname === "/health") {
			sendJson(res, 200, {
				ok: true,
				service: "bee-web",
				routes: config.routes.length,
				sseClients: fanout.clientCount(),
			});
			return;
		}

		if (method === "GET" && pathname === "/api/routes") {
			const routes = options.sessionApi ? config.routes.filter((route) => route.id === "fabee") : config.routes;
			sendJson(res, 200, { routes: routes.map(toPublicRoute) });
			return;
		}

		if (method === "GET" && pathname === "/api/sessions") {
			try {
				const user = requireAuthenticatedUser(config, req);
				const limit = getHistoryLimit(config, req);
				if (options.sessionApi) {
					sendJson(res, 200, await options.sessionApi.listSessions(user.email, limit));
					return;
				}
				const owned = [...sessions.values()]
					.filter((item) => item.userKey === user.userKey)
					.map((item) => ({
						sessionId: item.session.id,
						routeId: item.session.routeId,
						metadata: { routeId: item.session.routeId, createdAt: item.session.createdAt },
					}));
				sendJson(res, 200, { owned, shared: [] });
			} catch (error) {
				sendJson(res, errorStatus(error), { error: errorMessage(error) });
			}
			return;
		}

		if (method === "POST" && pathname === "/api/sessions") {
			try {
				const user = requireAuthenticatedUser(config, req);
				const route = options.sessionApi ? findRoute(config, "fabee") : firstRoute(config);
				if (!route) throw new Error("Fabee route is not configured");
				const session = options.sessionApi
					? await options.sessionApi.createSession(user.email)
					: createWebSession(route, user);
				sessions.set(session.id, { session, userKey: user.userKey });
				sendJson(res, 201, { session });
			} catch (error) {
				sendJson(res, errorStatus(error, 401), { error: errorMessage(error) });
			}
			return;
		}

		const historyEndpoint = matchHistoryEndpoint(pathname);
		if (method === "GET" && historyEndpoint) {
			if (!options.history) {
				sendJson(res, 503, { error: "History API is not configured" });
				return;
			}

			try {
				const user = requireAuthenticatedUser(config, req);
				if (historyEndpoint.action === "list") {
					const limit = getHistoryLimit(config, req);
					const sessions = (await options.history.listSessions?.({ user, limit })) ?? [];
					sendJson(res, 200, { sessions });
					return;
				}

				const sessionId = historyEndpoint.sessionId!;
				await requireSession(sessionId, req);

				if (historyEndpoint.action === "detail") {
					const session = await options.history.getSession?.({ user, sessionId });
					sendJson(res, 200, { session });
					return;
				}

				const runs = (await options.history.getSessionRuns?.({ user, sessionId })) ?? [];
				sendJson(res, 200, { sessionId, runs });
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}

		const artifactEndpoint = matchArtifactEndpoint(pathname);
		if (method === "GET" && artifactEndpoint) {
			let access: Awaited<ReturnType<typeof requireSession>>;
			try {
				access = await requireSession(artifactEndpoint.sessionId, req);
			} catch (error) {
				sendJson(res, 404, { error: errorMessage(error) });
				return;
			}

			if (options.sessionApi) {
				try {
					const upstream = await options.sessionApi.fetchArtifact(
						artifactEndpoint.sessionId,
						artifactEndpoint.artifactId,
						access.user.email,
					);
					res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
					if (upstream.body) {
						for await (const chunk of upstream.body as any) res.write(chunk);
					}
					res.end();
				} catch (error) {
					sendJson(res, errorStatus(error, 404), { error: errorMessage(error) });
				}
				return;
			}

			const artifact = artifacts.get(artifactKey(artifactEndpoint.sessionId, artifactEndpoint.artifactId));
			if (!artifact) {
				sendJson(res, 404, { error: "Artifact not found" });
				return;
			}

			try {
				await sendArtifact(config, artifact, res);
			} catch (error) {
				sendJson(res, 404, { error: errorMessage(error) });
			}
			return;
		}

		const cancelEndpoint = matchCancelEndpoint(pathname);
		if (method === "POST" && cancelEndpoint) {
			let access: Awaited<ReturnType<typeof requireSession>>;
			try {
				access = await requireSession(cancelEndpoint.sessionId, req);
			} catch (error) {
				sendJson(res, 404, { error: errorMessage(error) });
				return;
			}
			try {
				const rawResult =
					(await options.handleCancel?.({
						sessionId: cancelEndpoint.sessionId,
						turnId: cancelEndpoint.turnId,
						user: access.user,
					})) ?? false;
				const result = typeof rawResult === "boolean" ? { cancelled: rawResult } : rawResult;
				sendJson(res, 202, result);
			} catch (error) {
				sendJson(res, errorStatus(error, 404), { error: errorMessage(error) });
			}
			return;
		}

		const sessionEndpoint = matchSessionEndpoint(pathname);
		if (sessionEndpoint) {
			let access: Awaited<ReturnType<typeof requireSession>>;
			try {
				access = await requireSession(sessionEndpoint.sessionId, req);
			} catch (error) {
				sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
				return;
			}

			if (method === "GET" && sessionEndpoint.action === "detail") {
				if (options.sessionApi) {
					try {
						const session = await options.sessionApi.getSession(sessionEndpoint.sessionId, access.user.email);
						sendJson(res, 200, { session });
					} catch (error) {
						sendJson(res, errorStatus(error, 404), { error: errorMessage(error) });
					}
					return;
				}
				sendJson(res, 200, { session: access.session });
				return;
			}

			if (method === "GET" && sessionEndpoint.action === "events") {
				fanout.addClient(sessionEndpoint.sessionId, access.user.userKey, req, res);
				return;
			}

			if (method === "POST" && sessionEndpoint.action === "messages") {
				let body: MessageBody | null;
				try {
					body = await readJsonBody<MessageBody>(req);
				} catch {
					sendJson(res, 400, { error: "Invalid JSON body" });
					return;
				}

				const text = getRequiredString(body?.text, "text");
				if ("error" in text) {
					sendJson(res, 400, { error: text.error });
					return;
				}

				try {
					const result = (await options.handleMessage?.({
						sessionId: sessionEndpoint.sessionId,
						conversationId: access.session.conversationId,
						route: access.route,
						routeId: access.route.id,
						operatorId: access.user.email,
						text: text.value,
						user: access.user,
						reauthorize: async () => {
							await requireSession(sessionEndpoint.sessionId, req);
						},
					})) ?? { accepted: true };
					sendJson(res, 202, {
						accepted: result.accepted ?? true,
						queued: result.queued ?? false,
						turnId: result.turnId,
					});
				} catch (error) {
					sendJson(res, 429, { error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}

			if (method === "PUT" && sessionEndpoint.action === "collaborators") {
				if (!options.sessionApi) {
					sendJson(res, 404, { error: "Session not found" });
					return;
				}
				let body: CollaboratorsBody | null;
				try {
					body = await readJsonBody<CollaboratorsBody>(req);
				} catch {
					sendJson(res, 400, { error: "Invalid JSON body" });
					return;
				}
				const collaborators = body?.collaborators;
				if (!Array.isArray(collaborators)) {
					sendJson(res, 400, { error: "collaborators is required" });
					return;
				}
				try {
					const before = await options.sessionApi.getSession(sessionEndpoint.sessionId, access.user.email);
					const session = await options.sessionApi.putCollaborators(
						sessionEndpoint.sessionId,
						access.user.email,
						collaborators,
					);
					for (const email of before.collaborators ?? []) {
						if (!collaborators.includes(email))
							fanout.closeUserSession(sessionEndpoint.sessionId, deriveUserKeyFromEmail(email));
					}
					sendJson(res, 200, { session });
				} catch (error) {
					sendJson(res, errorStatus(error, 404), { error: errorMessage(error) });
				}
				return;
			}

			if (method === "POST" && sessionEndpoint.action === "archive") {
				if (!options.sessionApi || options.canArchive?.(sessionEndpoint.sessionId) === false) {
					sendJson(res, options.sessionApi ? 409 : 404, {
						error: options.sessionApi ? "Session has active or queued runs" : "Session not found",
					});
					return;
				}
				try {
					await options.sessionApi.archiveSession(sessionEndpoint.sessionId, access.user.email);
					fanout.closeSession(sessionEndpoint.sessionId);
					sendJson(res, 202, { archived: true });
				} catch (error) {
					sendJson(res, errorStatus(error, 404), { error: errorMessage(error) });
				}
				return;
			}
		}

		sendJson(res, 404, { error: "Not found" });
	});

	return { server, config, fanout, registerArtifact };
}

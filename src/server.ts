import type { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";
import { DEFAULT_EMAIL_HEADERS, getAuthenticatedWebUser } from "./auth.js";
import { createWebSession, findRoute, getRouteHistoryAgentId, isUserScopedRoute, toPublicRoute } from "./router.js";
import { SseFanout } from "./sse.js";
import type {
	HistoryRunRecord,
	HistorySessionDetailRecord,
	HistorySessionSummaryRecord,
	WebGatewayConfig,
	WebRouteConfig,
} from "./types.js";

interface CreateSessionBody {
	routeId?: string;
	operatorId?: string;
}

interface MessageBody {
	routeId?: string;
	operatorId?: string;
	text?: string;
}

export interface WebMessageRequest {
	sessionId: string;
	route: WebRouteConfig;
	routeId: string;
	operatorId: string;
	text: string;
	user?: {
		email: string;
		userKey: string;
		operatorId: string;
	};
}

export interface WebMessageDispatchResult {
	accepted?: boolean;
	queued?: boolean;
	turnId?: string;
}

export interface WebCancelRequest {
	sessionId: string;
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
	handleMessage?: (request: WebMessageRequest) => Promise<WebMessageDispatchResult> | WebMessageDispatchResult;
	handleCancel?: (request: WebCancelRequest) => Promise<WebCancelResult | boolean> | WebCancelResult | boolean;
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
	res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
	res.setHeader("access-control-allow-headers", "Content-Type, Last-Event-ID");
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

function matchSessionEndpoint(
	pathname: string,
): { sessionId: string; action: "events" | "messages" | "cancel" } | null {
	const match = /^\/api\/sessions\/([^/]+)\/(events|messages|cancel)$/.exec(pathname);
	if (!match) return null;
	return {
		sessionId: decodeURIComponent(match[1]!),
		action: match[2] as "events" | "messages" | "cancel",
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
	return Math.min(limit, 200);
}

function requireAuthenticatedUser(config: WebGatewayConfig, req: IncomingMessage) {
	const user = getAuthenticatedWebUser(req, config.auth?.emailHeaders ?? DEFAULT_EMAIL_HEADERS);
	if (!user) {
		throw new Error("Authenticated user email header is required");
	}
	return user;
}

function resolveMessageOperatorId(req: IncomingMessage, body: MessageBody | null, config: WebGatewayConfig): string {
	const user = getAuthenticatedWebUser(req, config.auth?.emailHeaders ?? DEFAULT_EMAIL_HEADERS);
	return user?.operatorId || body?.operatorId?.trim() || "web-user";
}

function findRouteBySessionId(config: WebGatewayConfig, sessionId: string): WebRouteConfig | undefined {
	return config.routes.find((route) => {
		const agentId = getRouteHistoryAgentId(route);
		if (agentId && sessionId.startsWith(`${agentId}:web:`)) return true;
		return sessionId.startsWith(`${route.session?.prefix || route.id}:`);
	});
}

function assertSessionAccess(
	config: WebGatewayConfig,
	req: IncomingMessage,
	route: WebRouteConfig,
	sessionId: string,
): void {
	if (!isUserScopedRoute(route)) return;
	const user = requireAuthenticatedUser(config, req);
	const agentId = getRouteHistoryAgentId(route);
	if (!agentId || !sessionId.startsWith(`${agentId}:web:${user.userKey}:`)) {
		throw new Error("Session not found");
	}
}

export function createWebGatewayServer(config: WebGatewayConfig, options: CreateWebGatewayServerOptions = {}) {
	const fanout = options.fanout ?? new SseFanout();
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
			sendJson(res, 200, { routes: config.routes.map(toPublicRoute) });
			return;
		}

		if (method === "POST" && pathname === "/api/sessions") {
			let body: CreateSessionBody | null;
			try {
				body = await readJsonBody<CreateSessionBody>(req);
			} catch {
				sendJson(res, 400, { error: "Invalid JSON body" });
				return;
			}

			const routeId = body?.routeId?.trim();
			if (!routeId) {
				sendJson(res, 400, { error: "routeId is required" });
				return;
			}

			const route = findRoute(config, routeId);
			if (!route) {
				sendJson(res, 400, { error: "Unknown routeId" });
				return;
			}

			try {
				const user = isUserScopedRoute(route) ? requireAuthenticatedUser(config, req) : undefined;
				sendJson(res, 201, { session: createWebSession(route, user) });
			} catch (error) {
				sendJson(res, 401, { error: error instanceof Error ? error.message : String(error) });
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
					const routeId = getSearchParams(req.url).get("routeId")?.trim() || undefined;
					const limit = getHistoryLimit(config, req);
					const sessions = (await options.history.listSessions?.({ user, routeId, limit })) ?? [];
					sendJson(res, 200, { sessions });
					return;
				}

				const sessionId = historyEndpoint.sessionId!;
				if (!findRouteBySessionId(config, sessionId)) {
					sendJson(res, 404, { error: "Session not found" });
					return;
				}

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

		const sessionEndpoint = matchSessionEndpoint(pathname);
		if (sessionEndpoint) {
			const sessionRoute = findRouteBySessionId(config, sessionEndpoint.sessionId);
			if (sessionRoute) {
				try {
					assertSessionAccess(config, req, sessionRoute, sessionEndpoint.sessionId);
				} catch (error) {
					sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
					return;
				}
			}

			if (method === "GET" && sessionEndpoint.action === "events") {
				fanout.addClient(sessionEndpoint.sessionId, req, res);
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

				const routeId = getRequiredString(body?.routeId, "routeId");
				if ("error" in routeId) {
					sendJson(res, 400, { error: routeId.error });
					return;
				}

				const text = getRequiredString(body?.text, "text");
				if ("error" in text) {
					sendJson(res, 400, { error: text.error });
					return;
				}

				const route = findRoute(config, routeId.value);
				if (!route) {
					sendJson(res, 400, { error: "Unknown routeId" });
					return;
				}

				try {
					assertSessionAccess(config, req, route, sessionEndpoint.sessionId);
				} catch (error) {
					sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
					return;
				}

				const user = getAuthenticatedWebUser(req, config.auth?.emailHeaders ?? DEFAULT_EMAIL_HEADERS);
				const result = (await options.handleMessage?.({
					sessionId: sessionEndpoint.sessionId,
					route,
					routeId: routeId.value,
					operatorId: resolveMessageOperatorId(req, body, config),
					text: text.value,
					user,
				})) ?? { accepted: true };
				sendJson(res, 202, {
					accepted: result.accepted ?? true,
					queued: result.queued ?? false,
					turnId: result.turnId,
				});
				return;
			}

			if (method === "POST" && sessionEndpoint.action === "cancel") {
				const rawResult = (await options.handleCancel?.({ sessionId: sessionEndpoint.sessionId })) ?? false;
				const result = typeof rawResult === "boolean" ? { cancelled: rawResult } : rawResult;
				sendJson(res, 202, result);
				return;
			}
		}

		sendJson(res, 404, { error: "Not found" });
	});

	return { server, config, fanout };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveUserKeyFromEmail, getAuthenticatedWebUser } from "./auth.js";
import { createErrorEvent, mapBeeEventToDashboardEvents } from "./event-mapper.js";
import { createWebSession, getConversationIdForSession } from "./router.js";
import { createWebGatewayServer } from "./server.js";
import { SseFanout } from "./sse.js";
import type { SharedDeskSessionApi } from "./session-api-client.js";
import type { WebGatewayConfig, WebRouteConfig } from "./types.js";

const fabeeRoute: WebRouteConfig = {
	id: "fabee",
	label: "Fabee",
	worker: { subject: "fabee.agent.pi.default" },
	session: { agentId: "fabee-pi-agent", userScoped: true },
};

const companyBriefingRoute: WebRouteConfig = {
	id: "company-briefing",
	label: "Company Briefing",
	worker: { subject: "company.agent" },
	session: { agentId: "company-agent", userScoped: true },
};

const marketInsightsRoute: WebRouteConfig = {
	id: "market-insights",
	label: "Market Insights",
	worker: { subject: "market.agent" },
	session: { agentId: "market-agent", userScoped: true },
};

function fakeSessionApi(overrides: Partial<SharedDeskSessionApi> = {}): SharedDeskSessionApi {
	return {
		async createSession() {
			return { id: "ses_1", conversationId: "conv_1", routeId: "fabee", createdAt: "now" };
		},
		async listSessions() {
			return { owned: [], shared: [] };
		},
		async getSession() {
			return {
				sessionId: "ses_1",
				conversationId: "conv_1",
				metadata: { routeId: "fabee", createdAt: "now" },
				owner: "alice@jobmatch.me",
			};
		},
		async getCapabilities() {
			return {};
		},
		async putCollaborators() {
			throw new Error("unused");
		},
		async archiveSession() {},
		async fetchArtifact() {
			throw new Error("unused");
		},
		...overrides,
	};
}

test("completed run events remain available for SSE reconnects", () => {
	const fanout = new SseFanout();
	fanout.enqueue("session-1", { turnId: "turn-1", actorEmail: "alice@jobmatch.me", text: "hello" });
	fanout.start("session-1", "turn-1");
	fanout.broadcast("session-1", "message.created", { type: "message.created", content: "answer" });
	fanout.finish("session-1", "turn-1", "completed");

	assert.equal(fanout.getSnapshot("session-1").events.length, 1);
});

test("enqueue does not replay the previous run snapshot", () => {
	class RecordingFanout extends SseFanout {
		readonly broadcasts: string[] = [];
		override broadcast(sessionId: string, type: string, data: unknown): number {
			this.broadcasts.push(type);
			return super.broadcast(sessionId, type, data);
		}
	}
	const fanout = new RecordingFanout();
	fanout.broadcast("session-1", "message.created", { type: "message.created", content: "old answer" });
	fanout.broadcasts.length = 0;

	fanout.enqueue("session-1", { turnId: "turn-2", actorEmail: "alice@jobmatch.me", text: "follow-up" });

	assert.deepEqual(fanout.broadcasts, ["status"]);
});

test("deriveUserKeyFromEmail strips @jobmatch.me and sanitizes the rest", () => {
	assert.equal(deriveUserKeyFromEmail("alice@jobmatch.me"), "alice");
	assert.equal(deriveUserKeyFromEmail("alice+ops@jobmatch.me"), "alice_ops");
	assert.equal(deriveUserKeyFromEmail("bob@example.com"), "bob_example_com");
});

test("getAuthenticatedWebUser reads oauth headers", () => {
	const user = getAuthenticatedWebUser({ headers: { "x-forwarded-email": "alice@jobmatch.me" } } as any);
	assert.deepEqual(user, {
		email: "alice@jobmatch.me",
		userKey: "alice",
		operatorId: "alice@jobmatch.me",
	});
});

test("createWebSession uses opaque web session ids", () => {
	const session = createWebSession(fabeeRoute, { userKey: "alice" });
	assert.match(session.id, /^web_[0-9a-f-]+$/);
	assert.equal(session.conversationId, getConversationIdForSession(fabeeRoute, session.id));
	assert.equal(session.routeId, "fabee");
});

test("run failures are sanitized before dashboard delivery", () => {
	const auth = createErrorEvent("s1", new Error("auth-expired: /Users/alice/.config/provider/token.json"), "t1");
	const generic = mapBeeEventToDashboardEvents({
		name: "run.failed",
		sessionId: "s1",
		turnId: "t2",
		time: "now",
		payload: { error: "provider stack /tmp/key" },
	} as any)[0];

	assert.equal(auth.type, "run.failed");
	assert.match(auth.error, /neu an/);
	assert.doesNotMatch(auth.error, /Users|provider|token/);
	assert.equal(generic?.type, "run.failed");
	if (generic?.type === "run.failed") assert.equal(generic.error, "Fabee konnte diesen Run nicht abschließen.");
});

test("maps private runtime items to dashboard usage events", () => {
	const [event] = mapBeeEventToDashboardEvents({
		name: "item.appended",
		sessionId: "s1",
		turnId: "t1",
		time: "now",
		payload: { item: { id: "t1:runtime", role: "system", parts: [{ kind: "json", value: { type: "runtime", usage: { contextTokens: 4116, contextWindow: 372000, reasoning: 25 }, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, thinkingLevel: "medium" } }] } },
	} as any);

	assert.deepEqual(event, { type: "runtime.updated", sessionId: "s1", turnId: "t1", at: "now", runtime: { contextTokens: 4116, contextWindow: 372000, reasoningTokens: 25, reasoningLevel: "medium", model: { provider: "openai-codex", id: "gpt-5.6-sol" } } });
});

test("artifact download returns registered data URI payload", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [{ id: "fabee", label: "Fabee", worker: { subject: "fabee.agent" }, session: { prefix: "fabee" } }],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	const { server, registerArtifact } = createWebGatewayServer(config);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	const createResponse = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const created = (await createResponse.json()) as { session: { id: string } };

	registerArtifact(created.session.id, {
		id: "artifact-1",
		name: "briefing.csv",
		mimeType: "text/csv",
		uri: "data:text/csv;base64,Y29tcGFueSx2YWx1ZQo=",
	});

	const response = await fetch(
		`http://127.0.0.1:${address.port}/api/sessions/${encodeURIComponent(created.session.id)}/artifacts/artifact-1/download`,
		{ headers: { "x-forwarded-email": "alice@jobmatch.me" } },
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/csv");
	assert.match(response.headers.get("content-disposition") ?? "", /briefing\.csv/);
	assert.equal(await response.text(), "company,value\n");

	registerArtifact(created.session.id, {
		id: "artifact-external",
		name: "external.csv",
		mimeType: "text/csv",
		uri: "https://example.com/external.csv",
	});
	const externalResponse = await fetch(
		`http://127.0.0.1:${address.port}/api/sessions/${encodeURIComponent(created.session.id)}/artifacts/artifact-external/download`,
		{ headers: { "x-forwarded-email": "alice@jobmatch.me" }, redirect: "manual" },
	);
	assert.equal(externalResponse.status, 404);
	assert.equal(externalResponse.headers.get("location"), null);
});

test("message enqueue uses server-owned route and authenticated actor", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	let seen: { routeId: string; operatorId: string; userKey: string; text: string; conversationId: string } | undefined;
	const { server } = createWebGatewayServer(config, {
		handleMessage: ({ routeId, operatorId, user, text, conversationId }) => {
			seen = { routeId, operatorId, userKey: user.userKey, text, conversationId };
			return { accepted: true, turnId: "turn-1" };
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	const createResponse = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const created = (await createResponse.json()) as { session: { id: string } };
	const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${created.session.id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-email": "alice@jobmatch.me" },
		body: JSON.stringify({ text: "hello", routeId: "evil", operatorId: "mallory" }),
	});

	assert.equal(response.status, 202);
	assert.equal(seen?.routeId, "fabee");
	assert.equal(seen?.operatorId, "alice@jobmatch.me");
	assert.equal(seen?.userKey, "alice");
	assert.equal(seen?.text, "hello");
	assert.match(seen?.conversationId ?? "", /^web:web_/);
});

test("local session list uses the public session summary contract", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	const { server } = createWebGatewayServer(config);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const body = (await response.json()) as { owned: Array<{ sessionId?: string; id?: string }> };

	assert.equal(response.status, 200);
	assert.match(body.owned[0]?.sessionId ?? "", /^web_/);
	assert.equal(body.owned[0]?.id, undefined);
});

test("session API mode still returns every configured route", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute, companyBriefingRoute, marketInsightsRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	const { server } = createWebGatewayServer(config, { sessionApi: fakeSessionApi() });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	const response = await fetch(`http://127.0.0.1:${address.port}/api/routes`);
	const body = (await response.json()) as { routes: Array<{ id: string }> };

	assert.deepEqual(
		body.routes.map((route) => route.id),
		["fabee", "company-briefing", "market-insights"],
	);
});

test("session API mode creates non-fabee sessions locally and fabee sessions upstream", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute, companyBriefingRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	let createdUpstream = 0;
	let seen: { routeId: string; conversationId: string } | undefined;
	const { server } = createWebGatewayServer(config, {
		sessionApi: fakeSessionApi({
			createSession: async () => {
				createdUpstream += 1;
				return { id: "ses_fabee", conversationId: "conv_fabee", routeId: "fabee", createdAt: "now" };
			},
		}),
		handleMessage: ({ routeId, conversationId }) => {
			seen = { routeId, conversationId };
			return { accepted: true, turnId: "turn-local" };
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	const localCreate = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-email": "alice@jobmatch.me" },
		body: JSON.stringify({ routeId: "company-briefing" }),
	});
	const local = (await localCreate.json()) as { session: { id: string; routeId: string; conversationId: string } };
	const message = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${local.session.id}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-email": "alice@jobmatch.me" },
		body: JSON.stringify({ text: "hello" }),
	});
	const fabeeCreate = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-email": "alice@jobmatch.me" },
		body: JSON.stringify({ routeId: "fabee" }),
	});
	const fabee = (await fabeeCreate.json()) as { session: { id: string; routeId: string; conversationId: string } };
	const archived = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${local.session.id}/archive`, {
		method: "POST",
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const sessionsAfterArchive = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const afterArchive = (await sessionsAfterArchive.json()) as { owned: Array<{ sessionId?: string }> };

	assert.equal(local.session.routeId, "company-briefing");
	assert.match(local.session.id, /^web_/);
	assert.equal(message.status, 202);
	assert.equal(archived.status, 202);
	assert.equal(afterArchive.owned.some((session) => session.sessionId === local.session.id), false);
	assert.deepEqual(seen, { routeId: "company-briefing", conversationId: local.session.conversationId });
	assert.equal(createdUpstream, 1);
	assert.deepEqual(fabee.session, {
		id: "ses_fabee",
		conversationId: "conv_fabee",
		routeId: "fabee",
		createdAt: "now",
	});
});

test("create session rejects unknown route ids", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	const { server } = createWebGatewayServer(config);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-email": "alice@jobmatch.me" },
		body: JSON.stringify({ routeId: "evil" }),
	});

	assert.equal(response.status, 404);
});

test("session API conversation id is authoritative for messages", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	let conversationId = "";
	const { server } = createWebGatewayServer(config, {
		sessionApi: {
			async createSession() {
				return { id: "ses_1", conversationId: "conv_authoritative", routeId: "fabee", createdAt: "now" };
			},
			async listSessions() {
				return { owned: [], shared: [] };
			},
			async getSession() {
				return {
					sessionId: "ses_1",
					conversationId: "conv_authoritative",
					metadata: { routeId: "fabee", createdAt: "now" },
					owner: "alice@jobmatch.me",
				};
			},
			async getCapabilities() {
				return {};
			},
			async putCollaborators() {
				throw new Error("unused");
			},
			async archiveSession() {},
			async fetchArtifact() {
				throw new Error("unused");
			},
		},
		handleMessage: (request) => {
			conversationId = request.conversationId;
			return { accepted: true };
		},
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/ses_1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-email": "alice@jobmatch.me" },
		body: JSON.stringify({ text: "hello" }),
	});

	assert.equal(response.status, 202);
	assert.equal(conversationId, "conv_authoritative");
});

test("cancel requires the exact turn id", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [fabeeRoute],
		auth: { emailHeaders: ["x-forwarded-email"] },
	};
	const { server } = createWebGatewayServer(config, {
		handleCancel: ({ turnId }) => ({ cancelled: turnId === "turn-ok" }),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

	const createResponse = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
		method: "POST",
		headers: { "x-forwarded-email": "alice@jobmatch.me" },
	});
	const created = (await createResponse.json()) as { session: { id: string } };
	const response = await fetch(
		`http://127.0.0.1:${address.port}/api/sessions/${created.session.id}/runs/turn-ok/cancel`,
		{
			method: "POST",
			headers: { "x-forwarded-email": "alice@jobmatch.me" },
		},
	);

	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { cancelled: true });
});

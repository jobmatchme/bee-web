import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveUserKeyFromEmail, getAuthenticatedWebUser } from "./auth.js";
import { createWebSession, getConversationIdForSession } from "./router.js";
import { createWebGatewayServer } from "./server.js";
import type { WebGatewayConfig, WebRouteConfig } from "./types.js";

const fabeeRoute: WebRouteConfig = {
	id: "fabee",
	label: "Fabee",
	worker: { subject: "fabee.agent.pi.default" },
	session: { agentId: "fabee-pi-agent", userScoped: true },
};

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

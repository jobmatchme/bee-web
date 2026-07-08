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

test("createWebSession uses auth-scoped fabee session ids", () => {
	const session = createWebSession(fabeeRoute, { userKey: "alice" });
	assert.match(session.id, /^fabee-pi-agent:web:alice:[0-9a-f-]+$/);
	assert.equal(session.conversationId, session.id);
	assert.equal(getConversationIdForSession(fabeeRoute, session.id), session.id);
});

test("artifact download returns registered data URI payload", async (t) => {
	const config: WebGatewayConfig = {
		port: 0,
		host: "127.0.0.1",
		nats: { servers: "nats://unused:4222" },
		routes: [{ id: "fabee", label: "Fabee", worker: { subject: "fabee.agent" }, session: { prefix: "fabee" } }],
	};
	const { server, registerArtifact } = createWebGatewayServer(config);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());

	registerArtifact("fabee:test", {
		id: "artifact-1",
		name: "briefing.csv",
		mimeType: "text/csv",
		uri: "data:text/csv;base64,Y29tcGFueSx2YWx1ZQo=",
	});

	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
	const response = await fetch(
		`http://127.0.0.1:${address.port}/api/sessions/fabee%3Atest/artifacts/artifact-1/download`,
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/csv");
	assert.match(response.headers.get("content-disposition") ?? "", /briefing\.csv/);
	assert.equal(await response.text(), "company,value\n");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveUserKeyFromEmail, getAuthenticatedWebUser } from "./auth.js";
import { createWebSession, getConversationIdForSession } from "./router.js";
import type { WebRouteConfig } from "./types.js";

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

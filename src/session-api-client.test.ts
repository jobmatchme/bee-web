import assert from "node:assert/strict";
import { test } from "node:test";
import { SharedDeskSessionApiClient } from "./session-api-client.js";

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const original = globalThis.fetch;
	globalThis.fetch = ((url, init) => handler(String(url), init)) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

test("SharedDeskSessionApiClient uses fabee-session-api create/list/capabilities contract", async (t) => {
	const calls: Array<{ url: string; body?: string }> = [];
	const restore = mockFetch((url, init) => {
		calls.push({ url, body: init?.body as string | undefined });
		if (url.endsWith("/sessions") && init?.method === "POST") {
			return Response.json({
				session: { sessionId: "s1", metadata: { routeId: "fabee", createdAt: "now" }, owner: "alice@jobmatch.me" },
			});
		}
		if (url.includes("/capabilities")) return Response.json({ role: "owner", permissions: { cancel: true } });
		return Response.json({ owned: [{ sessionId: "s1", owner: "alice@jobmatch.me" }], shared: [] });
	});
	t.after(restore);

	const client = new SharedDeskSessionApiClient({ baseUrl: "http://session-api" });
	assert.deepEqual(await client.createSession("alice@jobmatch.me"), {
		id: "s1",
		conversationId: "s1",
		routeId: "fabee",
		createdAt: "now",
	});
	await client.listSessions("alice@jobmatch.me", 10);
	await client.getCapabilities("s1", "bob@jobmatch.me", "alice@jobmatch.me");

	assert.equal(calls[0]?.body, JSON.stringify({ owner: "alice@jobmatch.me" }));
	assert.equal(calls[1]?.url, "http://session-api/sessions?actorEmail=alice%40jobmatch.me&limit=10");
	assert.equal(
		calls[2]?.url,
		"http://session-api/sessions/s1/capabilities?actorEmail=bob%40jobmatch.me&runActorEmail=alice%40jobmatch.me",
	);
});

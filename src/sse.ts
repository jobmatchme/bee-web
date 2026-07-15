import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

export interface SseClient {
	id: string;
	sessionId: string;
	userKey: string;
	connectedAt: string;
	res: ServerResponse;
}

export interface LiveSnapshot {
	type: "snapshot";
	sessionId: string;
	activeTurn?: { turnId: string; actorEmail: string; text: string; startedAt: string };
	queuedMessages: Array<{ turnId: string; actorEmail: string; text: string }>;
	events: unknown[];
	artifacts: unknown[];
}

export interface SseFanoutOptions {
	heartbeatMs?: number;
}

export function openSse(_req: IncomingMessage, res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.write("retry: 1000\n\n");
}

export function writeSseEvent(res: ServerResponse, type: string, data: unknown): void {
	res.write(`event: ${type}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeSseComment(res: ServerResponse, comment: string): void {
	res.write(`: ${comment}\n\n`);
}

export class SseFanout {
	private clientsByUserSession = new Map<string, Set<SseClient>>();
	private snapshots = new Map<string, LiveSnapshot>();
	private heartbeatMs: number;

	constructor(options: SseFanoutOptions = {}) {
		this.heartbeatMs = options.heartbeatMs ?? 25_000;
	}

	addClient(sessionId: string, userKey: string, req: IncomingMessage, res: ServerResponse): SseClient {
		openSse(req, res);

		const client: SseClient = {
			id: `sse_${randomUUID()}`,
			sessionId,
			userKey,
			connectedAt: new Date().toISOString(),
			res,
		};

		const key = this.clientKey(sessionId, userKey);
		let clients = this.clientsByUserSession.get(key);
		if (!clients) {
			clients = new Set<SseClient>();
			this.clientsByUserSession.set(key, clients);
		}
		clients.add(client);

		writeSseEvent(res, "connected", {
			type: "connected",
			sessionId,
			clientId: client.id,
			connectedAt: client.connectedAt,
		});
		writeSseEvent(res, "snapshot", this.getSnapshot(sessionId));

		const heartbeat = setInterval(() => {
			if (res.writableEnded || res.destroyed) {
				this.removeClient(client);
				clearInterval(heartbeat);
				return;
			}
			writeSseComment(res, "heartbeat");
		}, this.heartbeatMs);

		const cleanup = () => {
			clearInterval(heartbeat);
			this.removeClient(client);
		};
		req.once("close", cleanup);
		res.once("close", cleanup);
		res.once("finish", cleanup);

		return client;
	}

	getSnapshot(sessionId: string): LiveSnapshot {
		let snapshot = this.snapshots.get(sessionId);
		if (!snapshot) {
			snapshot = { type: "snapshot", sessionId, queuedMessages: [], events: [], artifacts: [] };
			this.snapshots.set(sessionId, snapshot);
		}
		return snapshot;
	}

	enqueue(sessionId: string, message: { turnId: string; actorEmail: string; text: string }): void {
		const snapshot = this.getSnapshot(sessionId);
		snapshot.queuedMessages.push(message);
		this.broadcast(sessionId, "status", { type: "status", status: "waiting", sessionId, ...message });
		this.broadcastSnapshot(sessionId);
	}

	start(sessionId: string, turnId: string): void {
		const snapshot = this.getSnapshot(sessionId);
		const queued = snapshot.queuedMessages.find((item) => item.turnId === turnId);
		if (queued) snapshot.activeTurn = { ...queued, startedAt: new Date().toISOString() };
		snapshot.queuedMessages = snapshot.queuedMessages.filter((item) => item.turnId !== turnId);
		this.broadcast(sessionId, "status", { type: "status", status: "running", sessionId, turnId });
		this.broadcastSnapshot(sessionId);
	}

	finish(sessionId: string, turnId: string, status: "completed" | "failed" | "cancelled", reason?: string): void {
		const snapshot = this.getSnapshot(sessionId);
		if (snapshot.activeTurn?.turnId === turnId) snapshot.activeTurn = undefined;
		snapshot.queuedMessages = snapshot.queuedMessages.filter((item) => item.turnId !== turnId);
		this.broadcast(sessionId, "status", { type: "status", status, reason, sessionId, turnId });
		snapshot.events = [];
		snapshot.artifacts = [];
		this.broadcastSnapshot(sessionId);
	}

	addArtifact(sessionId: string, artifact: unknown): void {
		const snapshot = this.getSnapshot(sessionId);
		snapshot.artifacts.push(artifact);
		this.broadcastSnapshot(sessionId);
	}

	broadcast(sessionId: string, type: string, data: unknown): number {
		if (type !== "snapshot" && type !== "status") {
			const snapshot = this.getSnapshot(sessionId);
			snapshot.events.push(data);
		}

		let delivered = 0;
		for (const [key, clients] of this.clientsByUserSession) {
			if (!key.startsWith(`${sessionId}\0`)) continue;
			for (const client of [...clients]) {
				if (client.res.writableEnded || client.res.destroyed) {
					this.removeClient(client);
					continue;
				}
				writeSseEvent(client.res, type, data);
				delivered += 1;
			}
		}
		return delivered;
	}

	broadcastSnapshot(sessionId: string): number {
		return this.broadcast(sessionId, "snapshot", this.getSnapshot(sessionId));
	}

	clientCount(sessionId?: string): number {
		let count = 0;
		for (const [key, clients] of this.clientsByUserSession) {
			if (!sessionId || key.startsWith(`${sessionId}\0`)) count += clients.size;
		}
		return count;
	}

	closeUserSession(sessionId: string, userKey: string): number {
		const clients = this.clientsByUserSession.get(this.clientKey(sessionId, userKey));
		if (!clients) return 0;
		let closed = 0;
		for (const client of [...clients]) {
			client.res.end();
			this.removeClient(client);
			closed += 1;
		}
		return closed;
	}

	closeSession(sessionId: string): number {
		let closed = 0;
		for (const [key, clients] of [...this.clientsByUserSession]) {
			if (!key.startsWith(`${sessionId}\0`)) continue;
			for (const client of [...clients]) {
				client.res.end();
				this.removeClient(client);
				closed += 1;
			}
		}
		return closed;
	}

	private clientKey(sessionId: string, userKey: string): string {
		return `${sessionId}\0${userKey}`;
	}

	private removeClient(client: SseClient): void {
		const key = this.clientKey(client.sessionId, client.userKey);
		const clients = this.clientsByUserSession.get(key);
		if (!clients) return;
		clients.delete(client);
		if (clients.size === 0) this.clientsByUserSession.delete(key);
	}
}

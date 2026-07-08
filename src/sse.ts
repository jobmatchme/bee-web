import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

export interface SseClient {
	id: string;
	sessionId: string;
	connectedAt: string;
	res: ServerResponse;
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
	private clientsBySession = new Map<string, Set<SseClient>>();
	private heartbeatMs: number;

	constructor(options: SseFanoutOptions = {}) {
		this.heartbeatMs = options.heartbeatMs ?? 25_000;
	}

	addClient(sessionId: string, req: IncomingMessage, res: ServerResponse): SseClient {
		openSse(req, res);

		const client: SseClient = {
			id: `sse_${randomUUID()}`,
			sessionId,
			connectedAt: new Date().toISOString(),
			res,
		};

		let clients = this.clientsBySession.get(sessionId);
		if (!clients) {
			clients = new Set<SseClient>();
			this.clientsBySession.set(sessionId, clients);
		}
		clients.add(client);

		writeSseEvent(res, "connected", {
			type: "connected",
			sessionId,
			clientId: client.id,
			connectedAt: client.connectedAt,
		});

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

	broadcast(sessionId: string, type: string, data: unknown): number {
		const clients = this.clientsBySession.get(sessionId);
		if (!clients || clients.size === 0) return 0;

		let delivered = 0;
		for (const client of [...clients]) {
			if (client.res.writableEnded || client.res.destroyed) {
				this.removeClient(client);
				continue;
			}
			writeSseEvent(client.res, type, data);
			delivered += 1;
		}

		return delivered;
	}

	clientCount(sessionId?: string): number {
		if (sessionId) return this.clientsBySession.get(sessionId)?.size ?? 0;
		let count = 0;
		for (const clients of this.clientsBySession.values()) {
			count += clients.size;
		}
		return count;
	}

	closeSession(sessionId: string): number {
		const clients = this.clientsBySession.get(sessionId);
		if (!clients) return 0;

		let closed = 0;
		for (const client of [...clients]) {
			client.res.end();
			this.removeClient(client);
			closed += 1;
		}
		return closed;
	}

	private removeClient(client: SseClient): void {
		const clients = this.clientsBySession.get(client.sessionId);
		if (!clients) return;
		clients.delete(client);
		if (clients.size === 0) {
			this.clientsBySession.delete(client.sessionId);
		}
	}
}

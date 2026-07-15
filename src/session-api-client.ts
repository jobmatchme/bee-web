import type { AuthenticatedWebUser } from "./auth.js";
import type { WebSessionRecord } from "./types.js";

export class SessionApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface SharedDeskSessionApiOptions {
	baseUrl: string;
	bearerToken?: string;
}

export interface SharedDeskSessionDetail {
	sessionId: string;
	metadata?: { routeId?: string; createdAt?: string };
	owner: string;
	collaborators?: string[];
	role?: string;
	permissions?: Record<string, boolean>;
}

export interface SharedDeskSessionCapabilities {
	role?: string;
	permissions?: Record<string, boolean>;
}

export interface SharedDeskSessionList {
	owned: SharedDeskSessionDetail[];
	shared: SharedDeskSessionDetail[];
}

export interface SharedDeskSessionApi {
	createSession(owner: string): Promise<WebSessionRecord>;
	listSessions(actorEmail: string, limit: number): Promise<SharedDeskSessionList>;
	getSession(sessionId: string, actorEmail: string): Promise<SharedDeskSessionDetail>;
	requireSessionAccess(sessionId: string, actorEmail: string): Promise<WebSessionRecord>;
	getCapabilities(
		sessionId: string,
		actorEmail: string,
		runActorEmail?: string,
	): Promise<SharedDeskSessionCapabilities>;
	putCollaborators(sessionId: string, actorEmail: string, collaborators: string[]): Promise<SharedDeskSessionDetail>;
	archiveSession(sessionId: string, actorEmail: string): Promise<void>;
	fetchArtifact(sessionId: string, artifactId: string, actorEmail: string): Promise<Response>;
}

export function toWebSessionRecord(session: SharedDeskSessionDetail): WebSessionRecord {
	return {
		id: session.sessionId,
		conversationId: session.sessionId,
		routeId: session.metadata?.routeId || "fabee",
		createdAt: session.metadata?.createdAt || new Date().toISOString(),
	};
}

export class SharedDeskSessionApiClient implements SharedDeskSessionApi {
	private baseUrl: string;
	private bearerToken?: string;

	constructor(options: SharedDeskSessionApiOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.bearerToken = options.bearerToken;
	}

	async createSession(owner: string): Promise<WebSessionRecord> {
		const body = await this.request<{ session: SharedDeskSessionDetail }>(`${this.baseUrl}/sessions`, {
			method: "POST",
			body: JSON.stringify({ owner }),
		});
		return toWebSessionRecord(body.session);
	}

	async listSessions(actorEmail: string, limit = 50): Promise<SharedDeskSessionList> {
		const url = new URL(`${this.baseUrl}/sessions`);
		url.searchParams.set("actorEmail", actorEmail);
		url.searchParams.set("limit", String(limit));
		return this.request<SharedDeskSessionList>(url);
	}

	async getSession(sessionId: string, actorEmail: string): Promise<SharedDeskSessionDetail> {
		const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`);
		url.searchParams.set("actorEmail", actorEmail);
		const body = await this.request<{ session: SharedDeskSessionDetail }>(url);
		return body.session;
	}

	async requireSessionAccess(sessionId: string, actorEmail: string): Promise<WebSessionRecord> {
		return toWebSessionRecord(await this.getSession(sessionId, actorEmail));
	}

	async getCapabilities(
		sessionId: string,
		actorEmail: string,
		runActorEmail?: string,
	): Promise<SharedDeskSessionCapabilities> {
		const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/capabilities`);
		url.searchParams.set("actorEmail", actorEmail);
		if (runActorEmail) url.searchParams.set("runActorEmail", runActorEmail);
		return this.request<SharedDeskSessionCapabilities>(url);
	}

	async putCollaborators(
		sessionId: string,
		actorEmail: string,
		collaborators: string[],
	): Promise<SharedDeskSessionDetail> {
		const body = await this.request<{ session: SharedDeskSessionDetail }>(
			`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/collaborators`,
			{ method: "PUT", body: JSON.stringify({ actorEmail, collaborators }) },
		);
		return body.session;
	}

	async archiveSession(sessionId: string, actorEmail: string): Promise<void> {
		await this.request(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/archive`, {
			method: "POST",
			body: JSON.stringify({ actorEmail }),
		});
	}

	async fetchArtifact(sessionId: string, artifactId: string, actorEmail: string): Promise<Response> {
		const url = new URL(
			`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
		);
		url.searchParams.set("actorEmail", actorEmail);
		const response = await fetch(url, { headers: this.headers() });
		if (!response.ok) throw await this.toError(response);
		return response;
	}

	private headers(init?: Record<string, string>): Record<string, string> {
		return {
			accept: "application/json",
			...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
			...init,
		};
	}

	private async request<T>(url: string | URL, init: RequestInit = {}): Promise<T> {
		const response = await fetch(url, {
			...init,
			headers: this.headers(init.body ? { "content-type": "application/json" } : undefined),
		});
		if (!response.ok) throw await this.toError(response);
		return ((await response.json().catch(() => ({}))) ?? {}) as T;
	}

	private async toError(response: Response): Promise<SessionApiError> {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		return new SessionApiError(body?.error || `Session API request failed (${response.status})`, response.status);
	}
}

export function actorFromUser(user: AuthenticatedWebUser): string {
	return user.email;
}

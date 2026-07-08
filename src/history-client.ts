export interface HistorySessionSummary {
	sessionId: string;
	contextUpdatedAt?: string;
	lastPromptUpdatedAt?: string;
	lastRunAt?: string;
	lastActivityAt?: string;
	runCount: number;
	routeId?: string;
	agentId?: string;
}

export interface HistorySessionDetail extends HistorySessionSummary {
	context: unknown[];
	lastPrompt?: unknown;
}

export interface HistoryRunSummary {
	runId: string;
	sessionId?: string;
	filePath: string;
	fileMtimeIso: string;
	status: "completed" | "failed" | "incomplete" | "unknown";
	requestedAt?: string;
	completedAt?: string;
	failedAt?: string;
	parseWarnings: Array<{ line: number; message: string }>;
}

export interface HistoryClientOptions {
	baseUrl: string;
	bearerToken: string;
}

export class HistoryClient {
	private baseUrl: string;
	private bearerToken: string;

	constructor(options: HistoryClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.bearerToken = options.bearerToken;
	}

	async listSessions(agentId: string, userKey: string, limit = 50): Promise<HistorySessionSummary[]> {
		const url = new URL(`${this.baseUrl}/sessions`);
		url.searchParams.set("agentId", agentId);
		url.searchParams.set("userKey", userKey);
		url.searchParams.set("limit", String(limit));
		const body = await this.request<{ sessions?: HistorySessionSummary[] }>(url);
		return body.sessions ?? [];
	}

	async getSession(sessionId: string, userKey: string): Promise<HistorySessionDetail> {
		const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`);
		url.searchParams.set("userKey", userKey);
		const body = await this.request<{ session: HistorySessionDetail }>(url);
		return body.session;
	}

	async getSessionRuns(sessionId: string, userKey: string): Promise<HistoryRunSummary[]> {
		const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/runs`);
		url.searchParams.set("userKey", userKey);
		const body = await this.request<{ runs?: HistoryRunSummary[] }>(url);
		return body.runs ?? [];
	}

	private async request<T>(url: URL): Promise<T> {
		const response = await fetch(url, {
			headers: {
				authorization: `Bearer ${this.bearerToken}`,
				accept: "application/json",
			},
		});
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		if (!response.ok) {
			throw new Error(body?.error || `History API request failed (${response.status})`);
		}
		return (body ?? {}) as T;
	}
}

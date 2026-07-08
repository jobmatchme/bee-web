import type { BeeWorkerTargetConfig, NatsConnectionOptions } from "@jobmatchme/bee-gate";
import type { HistoryRunSummary, HistorySessionDetail, HistorySessionSummary } from "./history-client.js";

export interface WebRouteSessionConfig {
	prefix?: string;
	agentId?: string;
	userScoped?: boolean;
}

export interface WebRouteConfig {
	id: string;
	label: string;
	description?: string;
	worker: BeeWorkerTargetConfig;
	session?: WebRouteSessionConfig;
}

export interface WebCorsConfig {
	origins?: string[];
}

export interface WebAuthConfig {
	emailHeaders?: string[];
}

export interface WebHistoryConfig {
	baseUrl?: string;
	bearerToken?: string;
	defaultLimit?: number;
}

export interface WebArtifactStoreConfig {
	rootDir?: string;
}

export interface WebGatewayConfig {
	port: number;
	host: string;
	nats: NatsConnectionOptions;
	routes: WebRouteConfig[];
	cors?: WebCorsConfig;
	auth?: WebAuthConfig;
	history?: WebHistoryConfig;
	artifactStore?: WebArtifactStoreConfig;
}

export interface PublicWebRoute {
	id: string;
	label: string;
	description?: string;
	worker: {
		subject: string;
	};
}

export interface WebSessionRecord {
	id: string;
	conversationId: string;
	routeId: string;
	createdAt: string;
}

export interface HistoryListRequest {
	user: {
		email: string;
		userKey: string;
		operatorId: string;
	};
	routeId?: string;
	limit: number;
}

export interface HistorySessionSummaryRecord extends HistorySessionSummary {}
export interface HistorySessionDetailRecord extends HistorySessionDetail {}
export interface HistoryRunRecord extends HistoryRunSummary {}

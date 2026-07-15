import { readFileSync } from "fs";
import { resolve } from "path";
import type { WebGatewayConfig } from "./types.js";

function readStringEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
	const raw = readStringEnv(name);
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

export function loadConfig(configPath?: string): WebGatewayConfig {
	const path = configPath || process.env.BEE_WEB_CONFIG;
	if (!path) {
		throw new Error("Missing config path. Pass one as first argument or set BEE_WEB_CONFIG.");
	}

	const fullPath = resolve(path);
	const config = JSON.parse(readFileSync(fullPath, "utf-8")) as Partial<WebGatewayConfig>;

	if (!config.nats?.servers || (Array.isArray(config.nats.servers) && config.nats.servers.length === 0)) {
		throw new Error(`Missing nats.servers in ${fullPath}`);
	}
	if (!Array.isArray(config.routes) || config.routes.length === 0) {
		throw new Error(`Missing routes in ${fullPath}`);
	}

	for (const route of config.routes) {
		if (!route.id) throw new Error(`Route in ${fullPath} is missing id`);
		if (!route.label) throw new Error(`Route ${route.id} in ${fullPath} is missing label`);
		if (!route.worker?.subject) throw new Error(`Route ${route.id} in ${fullPath} is missing worker.subject`);
	}

	return {
		port: config.port ?? 4322,
		host: config.host ?? "127.0.0.1",
		nats: config.nats,
		routes: config.routes,
		cors: config.cors,
		auth: {
			emailHeaders: config.auth?.emailHeaders,
		},
		history: {
			baseUrl: readStringEnv("BEE_WEB_HISTORY_API_BASE_URL") ?? config.history?.baseUrl,
			bearerToken: readStringEnv("BEE_WEB_HISTORY_API_BEARER_TOKEN") ?? config.history?.bearerToken,
			defaultLimit: readPositiveIntEnv("BEE_WEB_HISTORY_API_DEFAULT_LIMIT") ?? config.history?.defaultLimit ?? 50,
		},
		sessionApi: {
			baseUrl: readStringEnv("BEE_WEB_SESSION_API_BASE_URL") ?? config.sessionApi?.baseUrl,
			bearerToken: readStringEnv("BEE_WEB_SESSION_API_BEARER_TOKEN") ?? config.sessionApi?.bearerToken,
		},
		artifactStore: {
			rootDir: readStringEnv("BEE_WEB_ARTIFACT_STORE_ROOT") ?? config.artifactStore?.rootDir,
		},
	};
}

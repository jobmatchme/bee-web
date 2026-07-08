import { buildConversationId, buildSessionKey } from "@jobmatchme/bee-gate";
import { randomUUID } from "crypto";
import type { WebGatewayConfig, WebRouteConfig, WebSessionRecord } from "./types.js";

export function findRoute(config: WebGatewayConfig, routeId: string): WebRouteConfig | undefined {
	return config.routes.find((route) => route.id === routeId);
}

export function toPublicRoute(route: WebRouteConfig) {
	return {
		id: route.id,
		label: route.label,
		description: route.description,
		worker: {
			subject: route.worker.subject,
		},
	};
}

export function getRouteSessionPrefix(route: WebRouteConfig): string {
	return route.session?.prefix || route.id;
}

export function getRouteHistoryAgentId(route: WebRouteConfig): string | undefined {
	return route.session?.agentId;
}

export function isUserScopedRoute(route: WebRouteConfig): boolean {
	return route.session?.userScoped === true;
}

export function getConversationIdForSession(route: WebRouteConfig, sessionId: string): string {
	if (isUserScopedRoute(route) && getRouteHistoryAgentId(route)) {
		return sessionId;
	}

	const prefix = `${getRouteSessionPrefix(route)}:`;
	if (sessionId.startsWith(prefix)) {
		return sessionId.slice(prefix.length);
	}
	return buildConversationId(["web", route.id, sessionId]);
}

export function createWebSession(route: WebRouteConfig, user?: { userKey: string }): WebSessionRecord {
	const id = randomUUID();
	const createdAt = new Date().toISOString();

	if (isUserScopedRoute(route)) {
		const agentId = getRouteHistoryAgentId(route);
		if (!agentId) {
			throw new Error(`Route ${route.id} is userScoped but missing session.agentId`);
		}
		if (!user?.userKey) {
			throw new Error(`Route ${route.id} requires an authenticated user`);
		}
		const sessionId = buildSessionKey(`${agentId}:web:${user.userKey}`, id);
		return {
			id: sessionId,
			conversationId: sessionId,
			routeId: route.id,
			createdAt,
		};
	}

	const conversationId = buildConversationId(["web", route.id, `conv_${id}`]);
	const sessionId = buildSessionKey(getRouteSessionPrefix(route), conversationId);

	return {
		id: sessionId,
		conversationId,
		routeId: route.id,
		createdAt,
	};
}

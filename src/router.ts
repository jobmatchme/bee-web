import { buildConversationId } from "@jobmatchme/bee-gate";
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

export function getConversationIdForSession(_route: WebRouteConfig, sessionId: string): string {
	return buildConversationId(["web", sessionId]);
}

export function createWebSession(route: WebRouteConfig, _user?: { userKey: string }): WebSessionRecord {
	const id = `web_${randomUUID()}`;
	return {
		id,
		conversationId: getConversationIdForSession(route, id),
		routeId: route.id,
		createdAt: new Date().toISOString(),
	};
}

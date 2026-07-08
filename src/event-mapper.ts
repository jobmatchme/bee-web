import type { BeeRunEvent } from "@jobmatchme/bee-gate";

type DashboardItemPart =
	| { kind: "text"; text: string }
	| { kind: "status"; status: string; level?: "info" | "warning" | "error" }
	| {
			kind: "artifactRef";
			artifactId: string;
			blobKey?: string;
			name?: string;
			title?: string;
			mimeType?: string;
			uri?: string;
			sizeBytes?: number;
	  }
	| { kind: "log"; text: string; stream?: "stdout" | "stderr" | "combined" };

export interface ArtifactMeta {
	id: string;
	blobKey?: string;
	name?: string;
	title?: string;
	mimeType?: string;
	uri?: string;
	sizeBytes?: number;
}

export type DashboardEvent =
	| { type: "run.started"; sessionId: string; turnId: string; at: string }
	| { type: "run.completed"; sessionId: string; turnId: string; at: string; stopReason?: string }
	| { type: "run.failed"; sessionId: string; turnId: string; at: string; error: string }
	| {
			type: "message.created";
			sessionId: string;
			turnId?: string;
			messageId: string;
			role: "user" | "assistant";
			content: string;
			at: string;
	  }
	| { type: "message.delta"; sessionId: string; turnId?: string; messageId: string; delta: string; at: string }
	| { type: "message.completed"; sessionId: string; turnId?: string; messageId: string; at: string }
	| { type: "artifact.created"; sessionId: string; turnId?: string; artifact: ArtifactMeta; at: string }
	| {
			type: "activity.created";
			sessionId: string;
			turnId?: string;
			level: "info" | "warning" | "error";
			text: string;
			at: string;
	  };

export interface CreateUserMessageEventInput {
	sessionId: string;
	routeId: string;
	operatorId: string;
	text: string;
	turnId?: string;
}

export function createUserMessageEvent(input: CreateUserMessageEventInput): DashboardEvent {
	return {
		type: "message.created",
		sessionId: input.sessionId,
		turnId: input.turnId,
		messageId: input.turnId ? `${input.turnId}:user` : `${input.routeId}:${input.operatorId}:${Date.now()}`,
		role: "user",
		content: input.text,
		at: new Date().toISOString(),
	};
}

export function createErrorEvent(sessionId: string, error: unknown, turnId?: string): DashboardEvent {
	return {
		type: "run.failed",
		sessionId,
		turnId: turnId ?? "",
		at: new Date().toISOString(),
		error: error instanceof Error ? error.message : String(error),
	};
}

export function mapBeeEventToDashboardEvents(event: BeeRunEvent): DashboardEvent[] {
	switch (event.name) {
		case "run.started":
			return [{ type: "run.started", sessionId: event.sessionId, turnId: event.turnId ?? "", at: event.time }];
		case "run.completed":
			return [
				{
					type: "run.completed",
					sessionId: event.sessionId,
					turnId: event.turnId ?? "",
					at: event.time,
					stopReason: getStringPayloadValue(event.payload, "stopReason"),
				},
			];
		case "run.failed":
			return [
				{
					type: "run.failed",
					sessionId: event.sessionId,
					turnId: event.turnId ?? "",
					at: event.time,
					error: getStringPayloadValue(event.payload, "error") ?? "Run failed",
				},
			];
		case "item.appended": {
			const item = getPayloadObject(event.payload, "item");
			if (!item) return [];
			const itemId = getStringObjectValue(item, "id");
			const role = getStringObjectValue(item, "role");
			const parts = getItemParts(item.parts);
			return mapPartsToDashboardEvents({
				parts,
				event,
				messageId: itemId,
				role,
				mode: "created",
			});
		}
		case "item.updated": {
			const messageId = getStringPayloadValue(event.payload, "itemId");
			const parts = getItemParts(getPayloadValue(event.payload, "appendParts"));
			return mapPartsToDashboardEvents({
				parts,
				event,
				messageId,
				role: "assistant",
				mode: "delta",
			});
		}
		case "item.completed": {
			const messageId = getStringPayloadValue(event.payload, "itemId");
			if (!messageId) return [];
			return [
				{ type: "message.completed", sessionId: event.sessionId, turnId: event.turnId, messageId, at: event.time },
			];
		}
		default:
			return [];
	}
}

function mapPartsToDashboardEvents(input: {
	parts: DashboardItemPart[];
	event: BeeRunEvent;
	messageId?: string;
	role?: string;
	mode: "created" | "delta";
}): DashboardEvent[] {
	const events: DashboardEvent[] = [];
	const text = input.parts
		.filter((part): part is Extract<DashboardItemPart, { kind: "text" }> => part.kind === "text")
		.map((part) => part.text)
		.join("");

	if (text && input.messageId) {
		events.push(
			input.mode === "created"
				? {
						type: "message.created",
						sessionId: input.event.sessionId,
						turnId: input.event.turnId,
						messageId: input.messageId,
						role: input.role === "user" ? "user" : "assistant",
						content: text,
						at: input.event.time,
					}
				: {
						type: "message.delta",
						sessionId: input.event.sessionId,
						turnId: input.event.turnId,
						messageId: input.messageId,
						delta: text,
						at: input.event.time,
					},
		);
	}

	for (const part of input.parts) {
		if (part.kind === "artifactRef") {
			events.push({
				type: "artifact.created",
				sessionId: input.event.sessionId,
				turnId: input.event.turnId,
				artifact: {
					id: part.artifactId,
					blobKey: part.blobKey,
					name: part.name,
					title: part.title,
					mimeType: part.mimeType,
					uri: part.uri,
					sizeBytes: part.sizeBytes,
				},
				at: input.event.time,
			});
		}

		if (part.kind === "status") {
			events.push({
				type: "activity.created",
				sessionId: input.event.sessionId,
				turnId: input.event.turnId,
				level: part.level ?? "info",
				text: part.status,
				at: input.event.time,
			});
		}

		if (part.kind === "log") {
			events.push({
				type: "activity.created",
				sessionId: input.event.sessionId,
				turnId: input.event.turnId,
				level: part.stream === "stderr" ? "warning" : "info",
				text: part.text,
				at: input.event.time,
			});
		}
	}

	return events;
}

function getPayloadObject(payload: unknown, key: string): Record<string, unknown> | undefined {
	const value = getPayloadValue(payload, key);
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function getPayloadValue(payload: unknown, key: string): unknown {
	if (!payload || typeof payload !== "object") return undefined;
	return (payload as Record<string, unknown>)[key];
}

function getStringPayloadValue(payload: unknown, key: string): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	return getStringObjectValue(payload as Record<string, unknown>, key);
}

function getStringObjectValue(object: Record<string, unknown>, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

function getItemParts(value: unknown): DashboardItemPart[] {
	if (!Array.isArray(value)) return [];
	const parts: DashboardItemPart[] = [];

	for (const rawPart of value) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as Record<string, unknown>;
		const kind = getStringObjectValue(part, "kind");

		if (kind === "text") {
			const text = getStringObjectValue(part, "text");
			if (text !== undefined) parts.push({ kind, text });
		}

		if (kind === "status") {
			const status = getStringObjectValue(part, "status");
			if (status !== undefined) parts.push({ kind, status, level: getLevelValue(part.level) });
		}

		if (kind === "artifactRef") {
			const artifactId = getStringObjectValue(part, "artifactId");
			if (artifactId !== undefined) {
				parts.push({
					kind,
					artifactId,
					blobKey: getStringObjectValue(part, "blobKey"),
					name: getStringObjectValue(part, "name"),
					title: getStringObjectValue(part, "title"),
					mimeType: getStringObjectValue(part, "mimeType"),
					uri: getStringObjectValue(part, "uri"),
					sizeBytes: getNumberObjectValue(part, "sizeBytes"),
				});
			}
		}

		if (kind === "log") {
			const text = getStringObjectValue(part, "text");
			if (text !== undefined) parts.push({ kind, text, stream: getLogStreamValue(part.stream) });
		}
	}

	return parts;
}

function getNumberObjectValue(object: Record<string, unknown>, key: string): number | undefined {
	const value = object[key];
	return typeof value === "number" ? value : undefined;
}

function getLevelValue(value: unknown): "info" | "warning" | "error" | undefined {
	return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

function getLogStreamValue(value: unknown): "stdout" | "stderr" | "combined" | undefined {
	return value === "stdout" || value === "stderr" || value === "combined" ? value : undefined;
}

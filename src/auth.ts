import type { IncomingMessage } from "http";

const DEFAULT_EMAIL_HEADERS = [
	"x-forwarded-email",
	"x-auth-request-email",
	"x-forwarded-user",
	"x-auth-request-user",
	"remote-email",
	"remote-user",
] as const;

export interface AuthenticatedWebUser {
	email: string;
	userKey: string;
	operatorId: string;
}

export function deriveUserKeyFromEmail(email: string): string {
	const normalized = email.trim();
	const withoutDomain = normalized.endsWith("@jobmatch.me")
		? normalized.slice(0, normalized.length - "@jobmatch.me".length)
		: normalized;
	return withoutDomain.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return firstHeaderValue(value[0]);
	const first = value?.split(",")[0]?.trim();
	return first || undefined;
}

export function getAuthenticatedWebUser(
	req: IncomingMessage,
	headerNames: readonly string[] = DEFAULT_EMAIL_HEADERS,
): AuthenticatedWebUser | undefined {
	for (const headerName of headerNames) {
		const email = firstHeaderValue(req.headers[headerName]);
		if (!email) continue;
		return {
			email,
			userKey: deriveUserKeyFromEmail(email),
			operatorId: email,
		};
	}
	return undefined;
}

export { DEFAULT_EMAIL_HEADERS };

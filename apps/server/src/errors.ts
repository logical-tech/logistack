import type { Hook } from "@hono/zod-openapi";
import {
	type ApiError,
	type ErrorCode,
	isReservedEnvKey,
	reservedEnvKeyMessage,
} from "@logistack/contracts";
import {
	DatabaseError,
	type DatabaseFailure,
	StorageError,
} from "@logistack/providers";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

const statusOf: Record<ErrorCode, ContentfulStatusCode> = {
	bad_request: 400,
	validation_failed: 400,
	unprocessable: 422,
	unauthorized: 401,
	forbidden: 403,
	two_factor_required: 403,
	not_found: 404,
	conflict: 409,
	rate_limited: 429,
	internal: 500,
};

/** Throw from anywhere in a request; the error handler renders it as `{error:{code,message,details?}}`. */
export class Failure extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
	get status() {
		return statusOf[this.code];
	}
}

export const notFound = (what = "resource") =>
	new Failure("not_found", `${what} not found`);

/** Parses input read before the route validators run (permission resolvers). */
export function parseInput<T>(
	schema: {
		safeParse(
			v: unknown,
		):
			| { success: true; data: T }
			| { success: false; error: { issues: unknown } };
	},
	value: unknown,
): T {
	const r = schema.safeParse(value);
	if (!r.success)
		throw new Failure(
			"validation_failed",
			"request validation failed",
			r.error.issues,
		);
	return r.data;
}

/** User-defined variables may not shadow the ones every deployment injects. */
export function rejectReservedEnvKeys(keys: readonly string[]) {
	const reserved = keys.filter(isReservedEnvKey);
	const [first] = reserved;
	if (first)
		throw new Failure("unprocessable", reservedEnvKeyMessage(first), {
			keys: reserved,
		});
}

/** The single row of a `returning()` or keyed select; 404 when there is none. */
export function one<T>(rows: T[], what?: string): T {
	const [row] = rows;
	if (row === undefined) throw notFound(what);
	return row;
}

function body(code: ErrorCode, message: string, details?: unknown): ApiError {
	return {
		error:
			details === undefined ? { code, message } : { code, message, details },
	};
}

// Postgres SQLSTATEs we translate; everything else is a 500.
const pgCodes: Record<string, ErrorCode> = {
	"23505": "conflict", // unique_violation
	"23503": "conflict", // foreign_key_violation
	"23514": "bad_request", // check_violation (incl. folder_depth trigger)
};

function pgError(err: unknown): { code: string; message: string } | undefined {
	for (let e = err; e instanceof Error; e = e.cause) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string" && code in pgCodes)
			return { code, message: e.message };
	}
	return undefined;
}

const storageCodes: Record<number, ErrorCode> = {
	400: "bad_request",
	404: "not_found",
	409: "conflict",
};

const databaseCodes: Record<DatabaseFailure, ErrorCode> = {
	unreachable: "conflict",
	auth: "conflict",
	stale: "conflict",
	query: "bad_request",
	unsupported: "bad_request",
	missing: "not_found",
};

export function onError(err: Error, c: Context<Env>) {
	if (err instanceof Failure)
		return c.json(body(err.code, err.message, err.details), err.status);
	if (err instanceof StorageError) {
		// The engine's own 403 means our root credentials were refused, not the caller.
		const code = storageCodes[err.status ?? 0] ?? "conflict";
		return c.json(
			body(code, err.message, err.code ? { engineCode: err.code } : undefined),
			statusOf[code],
		);
	}
	if (err instanceof DatabaseError) {
		// The service's own database, not ours: never let its SQLSTATE map through pgCodes.
		const code = databaseCodes[err.reason];
		const hint =
			err.reason === "unreachable"
				? " (a database deployed before the explorer existed needs a redeploy to join its network)"
				: "";
		return c.json(
			body(code, err.message + hint, {
				reason: err.reason,
				...(err.code ? { engineCode: err.code } : {}),
			}),
			statusOf[code],
		);
	}
	const pg = pgError(err);
	if (pg) {
		const code = pgCodes[pg.code] ?? "internal";
		return c.json(body(code, pg.message), statusOf[code]);
	}
	const status = (err as { status?: unknown }).status;
	if (typeof status === "number" && status >= 400 && status < 500)
		return c.json(
			body("bad_request", err.message),
			status as ContentfulStatusCode,
		);
	log("error", "unhandled error", {
		requestId: c.get("requestId"),
		error: err.stack ?? String(err),
	});
	return c.json(body("internal", "internal server error"), 500);
}

/** zod-openapi validation hook: invalid input becomes a 400 `validation_failed`. */
export const validationHook: Hook<unknown, Env, string, unknown> = (
	result,
	c,
) => {
	if (!result.success)
		return c.json(
			body(
				"validation_failed",
				"request validation failed",
				result.error.issues,
			),
			400,
		);
};

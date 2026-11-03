import type { MiddlewareHandler } from "hono";
import type { Env } from "./env.ts";

let silent = false;
export const setLogLevel = (level: "info" | "silent") => {
	silent = level === "silent";
};

/** One JSON object per line on stdout. */
export function log(
	level: "info" | "warn" | "error",
	msg: string,
	fields: Record<string, unknown> = {},
) {
	if (silent) return;
	console.log(
		JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields }),
	);
}

export const requestLogger: MiddlewareHandler<Env> = async (c, next) => {
	const start = performance.now();
	await next();
	const actor = c.get("actor");
	log(c.res.status >= 500 ? "error" : "info", "request", {
		requestId: c.get("requestId"),
		method: c.req.method,
		path: c.req.path,
		status: c.res.status,
		ms: Math.round(performance.now() - start),
		actor: actor ? `${actor.kind}:${actor.id}` : undefined,
	});
};

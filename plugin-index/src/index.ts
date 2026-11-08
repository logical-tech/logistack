import * as admin from "./admin.ts";
import {
	createApiToken,
	deleteApiToken,
	finishLogin,
	logout,
	requireAdmin,
	requireWho,
	sessionCookie,
	startLogin,
	who,
} from "./auth.ts";
import {
	type Env,
	HttpError,
	isForm,
	readBody,
	redirect,
	str,
} from "./http.ts";
import {
	adminPage,
	confirmPage,
	dashboardPage,
	page,
	signInPage,
	tokenPage,
} from "./pages.ts";
import { buildDetail, buildIndex, ping, report } from "./public.ts";
import {
	listOwn,
	registerPlugin,
	setPublisherName,
	submitVersion,
} from "./publish.ts";
import { signPayload } from "./sign.ts";

export type { Env } from "./http.ts";

// The plugin index API (README.md). Paths below are relative to BASE_PATH.

type Ctx = {
	req: Request;
	env: Env;
	url: URL;
	base: string;
	params: string[];
	fetchFn: typeof fetch;
};
type Handler = (c: Ctx) => Promise<Response>;

async function signed(env: Env, value: unknown) {
	const res = Response.json(await signPayload(value, env.SIGNING_KEY));
	res.headers.set("Cache-Control", "public, max-age=60");
	res.headers.set("Access-Control-Allow-Origin", "*");
	return res;
}

/** A form gets sent back to `to` with a message; an API client gets JSON. */
const done = (c: Ctx, to: string, msg: string, data: unknown = { ok: true }) =>
	isForm(c.req)
		? redirect(`${c.base}${to}?msg=${encodeURIComponent(msg)}`)
		: Response.json(data);

const PLUGIN = "([a-z0-9.-]+)";
const ID = "([A-Za-z0-9_-]+)";

const routes: [string, RegExp, Handler][] = [
	["GET", /^\/v1\/index$/, async (c) => signed(c.env, await buildIndex(c.env))],
	[
		"GET",
		new RegExp(`^/v1/plugins/${PLUGIN}$`),
		async (c) => {
			const d = await buildDetail(c.env, c.params[0] ?? "");
			if (!d) throw new HttpError(404, "no such plugin");
			return signed(c.env, d);
		},
	],
	[
		"POST",
		/^\/v1\/ping$/,
		async (c) => {
			await ping(c.env, await readBody(c.req));
			return new Response(null, { status: 204 });
		},
	],
	[
		"POST",
		/^\/v1\/reports$/,
		async (c) =>
			Response.json(await report(c.env, await readBody(c.req)), {
				status: 201,
			}),
	],

	[
		"GET",
		/^\/?$/,
		async (c) =>
			(await who(c.env, c.req))
				? redirect(`${c.base}/dashboard`)
				: signInPage(c.base, c.url.searchParams.get("msg")),
	],
	[
		"POST",
		/^\/auth\/login$/,
		async (c) => {
			await startLogin(c.env, str((await readBody(c.req)).email, 254));
			return done(c, "/", "Check your inbox for a sign-in link.");
		},
	],
	// The emailed link opens a confirm page, so a mail scanner fetching it cannot spend the token.
	[
		"GET",
		/^\/auth\/callback$/,
		async (c) => confirmPage(c.base, c.url.searchParams.get("token") ?? ""),
	],
	[
		"POST",
		/^\/auth\/callback$/,
		async (c) => {
			const session = await finishLogin(
				c.env,
				str((await readBody(c.req)).token, 100),
			);
			return redirect(`${c.base}/dashboard`, {
				"set-cookie": sessionCookie(c.env, session),
			});
		},
	],
	[
		"POST",
		/^\/auth\/logout$/,
		async (c) => {
			await logout(c.env, c.req);
			return redirect(`${c.base}/`, {
				"set-cookie": sessionCookie(c.env, "", 0),
			});
		},
	],

	[
		"GET",
		/^\/dashboard$/,
		async (c) => {
			const w = await who(c.env, c.req);
			if (!w) return redirect(`${c.base}/`);
			const tokens = await c.env.PLUGIN_INDEX.prepare(
				"SELECT hash, name, created_at, last_used_at FROM api_tokens WHERE publisher_id = ? ORDER BY created_at",
			)
				.bind(w.publisher.id)
				.all<{
					hash: string;
					name: string;
					created_at: number;
					last_used_at: number | null;
				}>();
			return dashboardPage(
				c.base,
				w,
				await listOwn(c.env, w),
				tokens.results,
				c.url.searchParams.get("msg"),
			);
		},
	],
	[
		"POST",
		/^\/me$/,
		async (c) => {
			await setPublisherName(
				c.env,
				await requireWho(c.env, c.req),
				(await readBody(c.req)).name,
			);
			return done(c, "/dashboard", "Saved.");
		},
	],
	[
		"GET",
		/^\/me\/plugins$/,
		async (c) =>
			Response.json({
				plugins: await listOwn(c.env, await requireWho(c.env, c.req)),
			}),
	],
	[
		"POST",
		/^\/me\/plugins$/,
		async (c) => {
			const w = await requireWho(c.env, c.req);
			const r = await registerPlugin(c.env, w, (await readBody(c.req)).id);
			return done(c, "/dashboard", `Registered ${r.id}.`, r);
		},
	],
	[
		"POST",
		new RegExp(`^/me/plugins/${PLUGIN}/versions$`),
		async (c) => {
			const w = await requireWho(c.env, c.req);
			const r = await submitVersion(
				c.env,
				w,
				c.params[0] ?? "",
				await readBody(c.req),
				c.fetchFn,
			);
			return done(
				c,
				"/dashboard",
				r.status === "rejected"
					? `${r.version} was rejected: ${r.notes}`
					: `${r.version} is listed as unverified.`,
				r,
			);
		},
	],
	[
		"POST",
		/^\/me\/tokens$/,
		async (c) => {
			const w = await requireWho(c.env, c.req);
			const token = await createApiToken(
				c.env,
				w.publisher.id,
				str((await readBody(c.req)).name, 40),
			);
			return isForm(c.req)
				? tokenPage(c.base, token)
				: Response.json({ token });
		},
	],
	[
		"POST",
		/^\/me\/tokens\/([a-f0-9]{64})\/delete$/,
		async (c) => {
			const w = await requireWho(c.env, c.req);
			await deleteApiToken(c.env, w.publisher.id, c.params[0] ?? "");
			return done(c, "/dashboard", "Token revoked.");
		},
	],

	[
		"GET",
		/^\/admin$/,
		async (c) => {
			await requireAdmin(c.env, c.req);
			const q = await admin.queue(c.env);
			return adminPage(
				c.base,
				q.versions,
				q.reports,
				c.url.searchParams.get("msg"),
			);
		},
	],
	[
		"GET",
		/^\/admin\/queue$/,
		async (c) => {
			await requireAdmin(c.env, c.req);
			return Response.json(await admin.queue(c.env));
		},
	],
	[
		"POST",
		new RegExp(`^/admin/versions/${ID}/(verify|reject|yank|checks)$`),
		async (c) => {
			const w = await requireAdmin(c.env, c.req);
			const [id = "", action] = c.params;
			const body = await readBody(c.req);
			if (action === "verify") await admin.verify(c.env, w, id, body);
			else if (action === "reject") await admin.reject(c.env, w, id, body);
			else if (action === "yank") await admin.yank(c.env, w, id, body);
			else await admin.attachChecks(c.env, id, body);
			return done(c, "/admin", `Done: ${action}.`);
		},
	],
	[
		"POST",
		new RegExp(`^/admin/publishers/${ID}/suspend$`),
		async (c) => {
			await requireAdmin(c.env, c.req);
			await admin.suspend(c.env, c.params[0] ?? "", await readBody(c.req));
			return done(
				c,
				"/admin",
				"Publisher suspended; their versions are yanked.",
			);
		},
	],
	[
		"POST",
		new RegExp(`^/admin/reports/${ID}/resolve$`),
		async (c) => {
			await requireAdmin(c.env, c.req);
			await admin.resolveReport(
				c.env,
				c.params[0] ?? "",
				await readBody(c.req),
			);
			return done(c, "/admin", "Report resolved.");
		},
	],
];

/** `fetchFn` reaches registries during the submit check; tests pass a fake. */
export async function handle(
	req: Request,
	env: Env,
	fetchFn: typeof fetch = fetch,
): Promise<Response> {
	const url = new URL(req.url);
	const base = env.BASE_PATH ?? "";
	if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`))
		return new Response("not found", { status: 404 });
	const path = url.pathname.slice(base.length);
	const c: Ctx = { req, env, url, base, params: [], fetchFn };
	try {
		// A browser request from another site never changes state here.
		const origin = req.headers.get("origin");
		if (
			req.method !== "GET" &&
			origin &&
			origin !== url.origin &&
			!path.startsWith("/v1/")
		)
			throw new HttpError(403, "cross-site request refused");
		for (const [method, re, h] of routes) {
			const m = re.exec(path);
			if (m && req.method === method) {
				c.params = m.slice(1);
				return await h(c);
			}
		}
		return new Response("not found", { status: 404 });
	} catch (e) {
		if (!(e instanceof HttpError)) console.error(e);
		const err =
			e instanceof HttpError ? e : new HttpError(500, "internal error");
		if (
			isForm(req) ||
			(req.method === "GET" &&
				!path.startsWith("/v1/") &&
				!path.startsWith("/me/") &&
				path !== "/admin/queue")
		)
			return new Response(
				await page(
					"Error",
					`<h1>Something went wrong</h1><p><a href="${base}/dashboard">Back</a></p>`,
					err.message,
				).text(),
				{
					status: err.status,
					headers: { "content-type": "text/html; charset=utf-8" },
				},
			);
		return Response.json(
			{ error: err.message, ...(err.issues ? { issues: err.issues } : {}) },
			{ status: err.status },
		);
	}
}

export default {
	fetch: (req, env) => handle(req, env),
} satisfies ExportedHandler<Env>;

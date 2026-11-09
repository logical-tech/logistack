import {
	type EventEnvelope,
	PLUGIN_HEADERS,
	PluginManifest,
} from "@logistack/contracts";
import { sign } from "./index.ts";

// The contract test: what `logistack-plugin test` runs and what the marketplace review runs
// against every submitted version.

export type Check = { name: string; ok: boolean; detail?: string };

async function signedInit(
	secret: string,
	installId: string,
	path: string,
	body: string,
	method = "POST",
	user?: string,
): Promise<RequestInit> {
	const ts = Math.floor(Date.now() / 1000);
	return {
		method,
		...(method === "GET" ? {} : { body }),
		headers: {
			"content-type": "application/json",
			[PLUGIN_HEADERS.install]: installId,
			[PLUGIN_HEADERS.timestamp]: String(ts),
			[PLUGIN_HEADERS.signatureV2]: await sign(
				secret,
				ts,
				{ method, path },
				body,
				user,
			),
			...(user ? { [PLUGIN_HEADERS.user]: user } : {}),
		},
	};
}

export const testEvent = (organizationId = "org_test"): EventEnvelope => ({
	id: `evt_test_${crypto.randomUUID()}`,
	type: "deployment.failed",
	organizationId,
	resource: { type: "service", id: "svc_test" },
	payload: { message: "contract test" },
	at: new Date(),
});

/** Runs the contract against a plugin at `baseUrl` that was started with `secret`. */
export async function contractTest(
	baseUrl: string,
	secret: string,
	installId = "plg_contracttest",
): Promise<{ manifest?: PluginManifest; checks: Check[] }> {
	const base = baseUrl.replace(/\/+$/, "");
	const checks: Check[] = [];
	const run = async (name: string, fn: () => Promise<string | undefined>) => {
		try {
			const detail = await fn();
			checks.push({ name, ok: !detail, ...(detail ? { detail } : {}) });
		} catch (e) {
			checks.push({
				name,
				ok: false,
				detail: e instanceof Error ? e.message : String(e),
			});
		}
	};

	let manifest: PluginManifest | undefined;
	await run("GET /v1/manifest returns a valid manifest", async () => {
		const res = await fetch(`${base}/v1/manifest`);
		if (!res.ok) return `answered ${res.status}`;
		const parsed = PluginManifest.safeParse(await res.json());
		if (!parsed.success)
			return parsed.error.issues.map((i) => i.message).join("; ");
		manifest = parsed.data;
	});
	await run("GET /v1/health answers a signed request", async () => {
		const res = await fetch(
			`${base}/v1/health`,
			await signedInit(secret, installId, "/v1/health", "", "GET"),
		);
		return res.ok ? undefined : `answered ${res.status}`;
	});
	await run("GET /v1/health refuses an unsigned request", async () => {
		const res = await fetch(`${base}/v1/health`);
		return res.status === 401 || res.status === 403
			? undefined
			: `answered ${res.status}, expected 401`;
	});
	await run("POST /v1/events refuses a tampered body", async () => {
		const init = await signedInit(
			secret,
			installId,
			"/v1/events",
			JSON.stringify({ event: testEvent() }),
		);
		const res = await fetch(`${base}/v1/events`, {
			...init,
			body: JSON.stringify({ event: testEvent("org_other") }),
		});
		return res.status === 401
			? undefined
			: `answered ${res.status}, expected 401`;
	});
	if (manifest?.contributes.events.length)
		// The handler may need the LogiStack API, which a standalone run lacks: only the signature is judged.
		await run("POST /v1/events accepts a signed event", async () => {
			const res = await fetch(
				`${base}/v1/events`,
				await signedInit(
					secret,
					installId,
					"/v1/events",
					JSON.stringify({ event: testEvent() }),
				),
			);
			return res.status === 401 || res.status === 403 || res.status === 404
				? `answered ${res.status}`
				: undefined;
		});
	for (const p of manifest?.contributes.pages ?? [])
		await run(`GET ${p.path} serves HTML`, async () => {
			const res = await fetch(`${base}${p.path}`);
			if (!res.ok) return `answered ${res.status}`;
			return res.headers.get("content-type")?.includes("text/html")
				? undefined
				: `content-type is ${res.headers.get("content-type")}`;
		});
	return { ...(manifest ? { manifest } : {}), checks };
}

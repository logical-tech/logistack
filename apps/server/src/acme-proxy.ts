import { timingSafeEqual } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { decrypt } from "@logistack/core";
import { auditLog, dnsProvider } from "@logistack/db";
import { findZoneForHostname, normalizeName } from "@logistack/providers";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { managedZones, openProvider } from "./dns.ts";
import type { Env } from "./env.ts";
import { log } from "./log.ts";

// DNS-01 for plugin DNS providers (docs/plans/plugins.md, "Implementation status"). Caddy's
// caddy-dns/acmeproxy module (libdns/acmeproxy) POSTs `{fqdn, value}` to
// `<endpoint>/present` and `<endpoint>/cleanup` with basic auth, and accepts only a 200 whose
// JSON echoes the same fqdn and value. The endpoint is `/acme-proxy/<dnsProviderId>`, reached
// over the control network; the password is the provider row's own random secret.

const Body = z.object({
	fqdn: z.string().min(1).max(253),
	value: z.string().max(512),
});

const CHALLENGE = "_acme-challenge.";

const same = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

/** `user:password` from a Basic header, or undefined. */
function basicAuth(header: string | undefined) {
	const m = /^Basic\s+(.+)$/i.exec(header ?? "");
	if (!m?.[1]) return undefined;
	const raw = Buffer.from(m[1], "base64").toString("utf8");
	const i = raw.indexOf(":");
	return i < 0
		? undefined
		: { user: raw.slice(0, i), password: raw.slice(i + 1) };
}

const unauthorized = () =>
	new Response("unauthorized", {
		status: 401,
		headers: { "www-authenticate": 'Basic realm="acme-proxy"' },
	});

export const acmeProxy = new Hono<Env>().post(
	"/:id/:action{present|cleanup}",
	async (c) => {
		const { db, masterKey } = c.var.deps;
		const id = c.req.param("id");
		const action = c.req.param("action") as "present" | "cleanup";
		const creds = basicAuth(c.req.header("authorization"));
		const [row] = await db
			.select()
			.from(dnsProvider)
			.where(eq(dnsProvider.id, id));
		// One answer for every refusal: no hint whether the id exists.
		if (
			!creds ||
			!row?.acmeSecretEncrypted ||
			row.kind !== "plugin" ||
			creds.user !== row.id ||
			!same(creds.password, await decrypt(masterKey, row.acmeSecretEncrypted))
		)
			return unauthorized();

		const body = Body.safeParse(await c.req.json().catch(() => null));
		if (!body.success) return c.text("expected {fqdn, value}", 400);
		const { fqdn, value } = body.data;
		const name = normalizeName(fqdn);
		// The secret only ever writes ACME challenge records.
		if (!name.startsWith(CHALLENGE))
			return c.text(`only ${CHALLENGE}* records`, 400);
		const zone = findZoneForHostname(name, managedZones(row));
		if (!zone) return c.text(`${row.name} manages no zone for ${name}`, 400);

		try {
			const provider = await openProvider({ db, masterKey }, row);
			if (action === "present") {
				// shortcut: one value per name; a wildcard and its apex validated at the same instant overwrite each other's TXT and Caddy retries. Switch to createRecord/updateRecord sets if that shows up.
				await provider.upsertRecord({
					zoneId: zone.id,
					name,
					type: "TXT",
					content: value,
					ttl: 60,
				});
			} else {
				const stale = (await provider.listRecords(zone.id, name)).filter(
					(r) => r.type === "TXT" && r.content === value,
				);
				for (const r of new Set(stale.map((r) => r.id)))
					await provider.deleteRecord(zone.id, r);
			}
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			log("warn", "acme-proxy failed", { providerId: row.id, action, error });
			return c.text(error, 502);
		}

		await db.insert(auditLog).values({
			organizationId: row.organizationId,
			actorKind: "system",
			actorId: "acme-proxy",
			action: `dns_record.acme_${action}`,
			resourceType: "dns_record",
			resourceId: row.id,
			diff: { name },
			outcome: "success",
		});
		return c.json({ fqdn, value }, 200);
	},
);

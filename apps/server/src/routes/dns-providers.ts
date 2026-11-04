import { createRoute, z } from "@hono/zod-openapi";
import {
	DnsRecordSetInput,
	DnsRecordType,
	dnsRecordSetIssues,
	Hostname,
} from "@logistack/contracts";
import { dnsProvider, domain } from "@logistack/db";
import {
	dohResolvers,
	findZoneForHostname,
	type DnsRecord as ProviderRecord,
	waitForPropagation,
} from "@logistack/providers";
import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { requireActor } from "../actor.ts";
import { mutation } from "../audit.ts";
import {
	connect,
	DnsKindSchema,
	type DnsProviderRow,
	managedZones,
	matchZone,
	openProvider,
	parseCredentials,
	providerRow,
	sealCredentials,
	viaProvider,
	Zone,
} from "../dns.ts";
import { Failure } from "../errors.ts";
import {
	body,
	errors,
	IdParam,
	json,
	Name,
	router,
	security,
} from "../openapi.ts";
import { publicIp } from "../probe.ts";
import { byParam, inOrganization, requirePermission } from "../scope.ts";

const DnsProviderView = z
	.object({
		id: z.string(),
		kind: DnsKindSchema,
		name: z.string(),
		zones: z.array(Zone),
		domains: z.int(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi("DnsProvider");

const Credentials = z.record(z.string(), z.unknown());

const DnsRecord = z
	.object({
		id: z.string(),
		zoneId: z.string(),
		name: z.string(),
		type: DnsRecordType,
		content: z.string(),
		ttl: z.number(),
		proxied: z.boolean().optional(),
	})
	.openapi("DnsRecord");

const RecordInput = z.object({
	hostname: Hostname,
	type: z.enum(["A", "AAAA", "CNAME"]),
	content: z.string().trim().min(1),
	/** Cloudflare only: serve through Cloudflare's proxy. */
	proxied: z.boolean().default(false),
});

const RecordSet = z
	.object({
		/** Pass back to update or delete. Several values can share one id (a Route 53 or Hetzner set). */
		id: z.string(),
		name: z.string(),
		type: DnsRecordType,
		ttl: z.number(),
		values: z.array(z.string()),
		proxied: z.boolean().optional(),
		comment: z.string().optional(),
		/** Why the record can only be viewed here. */
		readOnly: z.string().optional(),
		/** The LogiStack domain that created this record and keeps it pointed at the server. */
		domain: z.object({ id: z.string(), hostname: z.string() }).nullable(),
	})
	.openapi("DnsRecordSet");

const ZoneParam = z.object({ id: z.string(), zoneId: z.string() });
const RecordParam = ZoneParam.extend({ recordId: z.string() });

/** Folds per-value records into sets by id, tagging those a domain manages. */
function recordSets(
	records: ProviderRecord[],
	managed: Map<string, { id: string; hostname: string }>,
): z.infer<typeof RecordSet>[] {
	const sets = new Map<string, z.infer<typeof RecordSet>>();
	for (const r of records) {
		const set = sets.get(r.id);
		if (set) {
			set.values.push(r.content);
			continue;
		}
		sets.set(r.id, {
			id: r.id,
			name: r.name,
			type: r.type,
			ttl: r.ttl,
			values: [r.content],
			...(r.proxied !== undefined ? { proxied: r.proxied } : {}),
			...(r.comment ? { comment: r.comment } : {}),
			...(r.readOnly ? { readOnly: r.readOnly } : {}),
			domain: managed.get(r.id) ?? null,
		});
	}
	return [...sets.values()];
}

async function managedRecords(
	db: Parameters<typeof providerRow>[0],
	providerId: string,
) {
	const rows = await db
		.select({
			id: domain.id,
			hostname: domain.hostname,
			recordId: domain.dnsRecordId,
		})
		.from(domain)
		.where(
			and(eq(domain.dnsProviderId, providerId), isNotNull(domain.dnsRecordId)),
		);
	return new Map(
		rows.map((d) => [d.recordId ?? "", { id: d.id, hostname: d.hostname }]),
	);
}

/** The provider row and one of the zones it manages, or 404. */
async function zoneOf(
	db: Parameters<typeof providerRow>[0],
	organizationId: string,
	id: string,
	zoneId: string,
) {
	const row = await providerRow(db, organizationId, id);
	const zone = managedZones(row).find((z) => z.id === zoneId);
	if (!zone) throw new Failure("not_found", "zone not found");
	return { row, zone, kind: DnsKindSchema.parse(row.kind) };
}

function checkRecordSet(
	kind: string,
	zoneName: string,
	input: DnsRecordSetInput,
) {
	const issues = dnsRecordSetIssues(kind, zoneName, input);
	if (issues.length)
		throw new Failure(
			"validation_failed",
			issues.map(([, m]) => m).join("; "),
			issues.map(([path, message]) => ({ path: path.split("."), message })),
		);
	return {
		...input,
		proxied: kind === "cloudflare" ? input.proxied : undefined,
		comment: kind === "cloudflare" ? input.comment : undefined,
	};
}

const view = (row: DnsProviderRow, domains = 0) => ({
	id: row.id,
	kind: DnsKindSchema.parse(row.kind),
	name: row.name,
	zones: managedZones(row),
	domains,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

const tags = ["dns"];
const admin = [requirePermission("admin", inOrganization)];

export const dnsProviders = router()
	.openapi(
		createRoute({
			method: "get",
			path: "/dns-providers",
			tags,
			security,
			middleware: [requirePermission("read", inOrganization)],
			responses: {
				200: json(z.array(DnsProviderView), "Providers"),
				...errors,
			},
		}),
		async (c) => {
			const { db } = c.var.deps;
			const rows = await db
				.select()
				.from(dnsProvider)
				.where(eq(dnsProvider.organizationId, requireActor(c).organizationId))
				.orderBy(asc(dnsProvider.name));
			const used = rows.length
				? await db
						.select({ id: domain.dnsProviderId, n: count() })
						.from(domain)
						.where(
							inArray(
								domain.dnsProviderId,
								rows.map((r) => r.id),
							),
						)
						.groupBy(domain.dnsProviderId)
				: [];
			const uses = new Map(used.map((u) => [u.id, u.n]));
			return c.json(
				rows.map((r) => view(r, uses.get(r.id) ?? 0)),
				200,
			);
		},
	)
	.openapi(
		mutation(
			"dns_provider.test",
			createRoute({
				method: "post",
				path: "/dns-providers/test",
				tags,
				security,
				summary: "Verify unsaved credentials and list the zones they can edit",
				middleware: admin,
				request: body(
					z.object({ kind: DnsKindSchema, credentials: Credentials }),
				),
				responses: {
					200: json(z.object({ zones: z.array(Zone) }), "Zones"),
					...errors,
				},
			}),
		),
		async (c) => {
			const { kind, credentials } = c.req.valid("json");
			const p = connect(kind, credentials);
			const zones = await viaProvider(async () => {
				await p.verify();
				return p.listZones();
			});
			return c.json({ zones }, 200);
		},
	)
	.openapi(
		mutation(
			"dns_provider.create",
			createRoute({
				method: "post",
				path: "/dns-providers",
				tags,
				security,
				middleware: admin,
				request: body(
					z.object({
						kind: DnsKindSchema,
						name: Name,
						credentials: Credentials,
						zones: z.array(Zone).min(1),
					}),
				),
				responses: { 201: json(DnsProviderView, "Created"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const p = connect(input.kind, input.credentials);
			await viaProvider(() => p.verify());
			const [row] = await db
				.insert(dnsProvider)
				.values({
					organizationId: requireActor(c).organizationId,
					kind: input.kind,
					name: input.name,
					credentialsEncrypted: await sealCredentials(
						masterKey,
						parseCredentials(input.kind, input.credentials),
					),
					zonesCache: input.zones,
				})
				.returning();
			if (!row) throw new Failure("internal", "insert returned nothing");
			c.set("auditResourceId", row.id);
			return c.json(view(row), 201);
		},
	)
	.openapi(
		mutation(
			"dns_provider.update",
			createRoute({
				method: "patch",
				path: "/dns-providers/{id}",
				tags,
				security,
				summary: "Rename, rotate credentials or change the managed zones",
				middleware: admin,
				request: {
					params: IdParam,
					...body(
						z.object({
							name: Name.optional(),
							credentials: Credentials.optional(),
							zones: z.array(Zone).min(1).optional(),
						}),
					),
				},
				responses: { 200: json(DnsProviderView, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const row = await providerRow(db, requireActor(c).organizationId, id);
			const kind = DnsKindSchema.parse(row.kind);
			let credentialsEncrypted: string | undefined;
			if (input.credentials) {
				const p = connect(kind, input.credentials);
				await viaProvider(() => p.verify());
				credentialsEncrypted = await sealCredentials(
					masterKey,
					parseCredentials(kind, input.credentials),
				);
			}
			const [updated] = await db
				.update(dnsProvider)
				.set({
					...(input.name ? { name: input.name } : {}),
					...(input.zones ? { zonesCache: input.zones } : {}),
					...(credentialsEncrypted ? { credentialsEncrypted } : {}),
				})
				.where(eq(dnsProvider.id, id))
				.returning();
			if (!updated) throw new Failure("internal", "update returned nothing");
			c.set("auditResourceId", id);
			return c.json(view(updated), 200);
		},
	)
	.openapi(
		mutation(
			"dns_provider.delete",
			createRoute({
				method: "delete",
				path: "/dns-providers/{id}",
				tags,
				security,
				description: "Refused with 409 while any domain uses the provider.",
				middleware: admin,
				request: { params: IdParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id } = c.req.valid("param");
			const { db } = c.var.deps;
			await providerRow(db, requireActor(c).organizationId, id);
			const inUse = await db.$count(domain, eq(domain.dnsProviderId, id));
			if (inUse > 0)
				throw new Failure(
					"conflict",
					`${inUse} domain${inUse === 1 ? "" : "s"} still use this provider`,
				);
			await db.delete(dnsProvider).where(eq(dnsProvider.id, id));
			c.set("auditResourceId", id);
			return c.body(null, 204);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/dns-providers/{id}/zones",
			tags,
			security,
			summary:
				"Every zone the stored credentials can edit, live from the provider",
			middleware: admin,
			request: { params: IdParam },
			responses: {
				200: json(z.object({ zones: z.array(Zone) }), "Zones"),
				...errors,
			},
		}),
		async (c) => {
			const { db, masterKey } = c.var.deps;
			const row = await providerRow(
				db,
				requireActor(c).organizationId,
				c.req.valid("param").id,
			);
			const p = await openProvider(masterKey, row);
			return c.json({ zones: await viaProvider(() => p.listZones()) }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/services/{id}/dns-match",
			tags,
			security,
			summary:
				"Which connected provider manages a hostname, and what it holds there",
			middleware: [requirePermission("read", byParam("service"))],
			request: { params: IdParam, query: z.object({ hostname: Hostname }) },
			responses: {
				200: json(
					z
						.object({
							publicIp: z.string().nullable(),
							match: z
								.object({
									providerId: z.string(),
									providerName: z.string(),
									kind: DnsKindSchema,
									zone: Zone,
									/** What the provider already has at this exact name. */
									existing: z.array(DnsRecord),
								})
								.nullable(),
						})
						.openapi("DnsMatch"),
					"Match",
				),
				...errors,
			},
		}),
		async (c) => {
			const { hostname } = c.req.valid("query");
			const { db, masterKey, config } = c.var.deps;
			const [m, ip] = await Promise.all([
				matchZone(db, requireActor(c).organizationId, hostname),
				publicIp(config),
			]);
			if (!m) return c.json({ publicIp: ip, match: null }, 200);
			const p = await openProvider(masterKey, m.provider);
			const existing = (
				await viaProvider(() => p.listRecords(m.zone.id, hostname))
			).filter((r) => ["A", "AAAA", "CNAME", "TXT"].includes(r.type)); // what a domain can point with, plus ACME TXT
			return c.json(
				{
					publicIp: ip,
					match: {
						providerId: m.provider.id,
						providerName: m.provider.name,
						kind: DnsKindSchema.parse(m.provider.kind),
						zone: m.zone,
						existing,
					},
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"dns_record.upsert",
			createRoute({
				method: "post",
				path: "/services/{id}/dns-records",
				tags,
				security,
				summary: "Create or replace the record for a service's hostname",
				description:
					"Idempotent: the (name, type) record set ends up holding exactly this value. The provider must manage the hostname's zone.",
				middleware: [requirePermission("write", byParam("service"))],
				request: {
					params: IdParam,
					...body(RecordInput.extend({ dnsProviderId: z.string() })),
				},
				responses: { 200: json(DnsRecord, "Record"), ...errors },
			}),
		),
		async (c) => {
			const input = c.req.valid("json");
			const { db, masterKey } = c.var.deps;
			const row = await providerRow(
				db,
				requireActor(c).organizationId,
				input.dnsProviderId,
			);
			const zone = findZoneForHostname(input.hostname, managedZones(row));
			if (!zone)
				throw new Failure(
					"bad_request",
					`${row.name} does not manage a zone for ${input.hostname}`,
				);
			if (input.proxied && row.kind !== "cloudflare")
				throw new Failure("bad_request", "only Cloudflare can proxy a record");
			const p = await openProvider(masterKey, row);
			const record = await viaProvider(() =>
				p.upsertRecord({
					zoneId: zone.id,
					name: input.hostname,
					type: input.type,
					content: input.content,
					// 1 is Cloudflare's "automatic"; elsewhere 300 s keeps a mistaken first record short-lived.
					ttl: row.kind === "cloudflare" ? 1 : 300,
					...(row.kind === "cloudflare" ? { proxied: input.proxied } : {}),
				}),
			);
			c.set("auditResourceId", record.id);
			return c.json(record, 200);
		},
	)
	.openapi(
		mutation(
			"dns_record.check",
			createRoute({
				method: "post",
				path: "/services/{id}/dns-propagation",
				tags,
				security,
				summary: "Ask each public resolver once whether a record is visible",
				middleware: [requirePermission("read", byParam("service"))],
				request: {
					params: IdParam,
					...body(RecordInput.omit({ proxied: true })),
				},
				responses: {
					200: json(
						z
							.object({
								ok: z.boolean(),
								resolvers: z.array(
									z.object({ name: z.string(), ok: z.boolean() }),
								),
							})
							.openapi("Propagation"),
						"Per-resolver result",
					),
					...errors,
				},
			}),
		),
		async (c) => {
			const { hostname, type, content } = c.req.valid("json");
			const resolvers = await Promise.all(
				Object.entries(dohResolvers).map(async ([name, url]) => ({
					name,
					ok: await waitForPropagation(hostname, { type, content }, [url], {
						timeoutMs: 0,
					}).then(
						() => true,
						() => false,
					),
				})),
			);
			return c.json({ ok: resolvers.every((r) => r.ok), resolvers }, 200);
		},
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/dns-providers/{id}/zones/{zoneId}/records",
			tags,
			security,
			summary: "Every record in a managed zone, live from the provider",
			middleware: [requirePermission("read", inOrganization)],
			request: { params: ZoneParam },
			responses: {
				200: json(
					z
						.object({
							provider: z.object({
								id: z.string(),
								name: z.string(),
								kind: DnsKindSchema,
							}),
							zone: Zone,
							records: z.array(RecordSet),
						})
						.openapi("DnsZoneRecords"),
					"Records",
				),
				...errors,
			},
		}),
		async (c) => {
			const { id, zoneId } = c.req.valid("param");
			const { db, masterKey } = c.var.deps;
			const { row, zone, kind } = await zoneOf(
				db,
				requireActor(c).organizationId,
				id,
				zoneId,
			);
			const p = await openProvider(masterKey, row);
			const [records, managed] = await Promise.all([
				viaProvider(() => p.listRecords(zone.id)),
				managedRecords(db, row.id),
			]);
			return c.json(
				{
					provider: { id: row.id, name: row.name, kind },
					zone,
					records: recordSets(records, managed),
				},
				200,
			);
		},
	)
	.openapi(
		mutation(
			"dns_record.create",
			createRoute({
				method: "post",
				path: "/dns-providers/{id}/zones/{zoneId}/records",
				tags,
				security,
				summary: "Create a record set in a managed zone",
				description:
					"Values use zone-file presentation format (`10 mail.example.com` for MX). Cloudflare takes one value per record; Route 53 and Hetzner refuse a (name, type) that already exists.",
				middleware: admin,
				request: { params: ZoneParam, ...body(DnsRecordSetInput) },
				responses: { 201: json(RecordSet, "Created"), ...errors },
			}),
		),
		async (c) => {
			const { id, zoneId } = c.req.valid("param");
			const { db, masterKey } = c.var.deps;
			const { row, zone, kind } = await zoneOf(
				db,
				requireActor(c).organizationId,
				id,
				zoneId,
			);
			const input = checkRecordSet(kind, zone.name, c.req.valid("json"));
			const p = await openProvider(masterKey, row);
			const saved = await viaProvider(() =>
				p.createRecord({ ...input, zoneId: zone.id }),
			);
			const [set] = recordSets(saved, new Map());
			if (!set) throw new Failure("internal", "provider returned no record");
			c.set("auditResourceId", set.id);
			return c.json(set, 201);
		},
	)
	.openapi(
		mutation(
			"dns_record.update",
			createRoute({
				method: "put",
				path: "/dns-providers/{id}/zones/{zoneId}/records/{recordId}",
				tags,
				security,
				summary: "Replace a record set, renaming it when the name changed",
				description:
					"A domain pointing at the record follows it to its new id. Read-only records (Route 53 aliases, protected sets) are refused by the provider.",
				middleware: admin,
				request: { params: RecordParam, ...body(DnsRecordSetInput) },
				responses: { 200: json(RecordSet, "Updated"), ...errors },
			}),
		),
		async (c) => {
			const { id, zoneId, recordId } = c.req.valid("param");
			const { db, masterKey } = c.var.deps;
			const { row, zone, kind } = await zoneOf(
				db,
				requireActor(c).organizationId,
				id,
				zoneId,
			);
			const input = checkRecordSet(kind, zone.name, c.req.valid("json"));
			const p = await openProvider(masterKey, row);
			const saved = await viaProvider(() =>
				p.updateRecord(recordId, { ...input, zoneId: zone.id }),
			);
			const [set] = recordSets(saved, new Map());
			if (!set) throw new Failure("internal", "provider returned no record");
			if (set.id !== recordId)
				await db
					.update(domain)
					.set({ dnsRecordId: set.id })
					.where(
						and(
							eq(domain.dnsProviderId, row.id),
							eq(domain.dnsRecordId, recordId),
						),
					);
			const managed = await managedRecords(db, row.id);
			c.set("auditResourceId", set.id);
			return c.json({ ...set, domain: managed.get(set.id) ?? null }, 200);
		},
	)
	.openapi(
		mutation(
			"dns_record.delete",
			createRoute({
				method: "delete",
				path: "/dns-providers/{id}/zones/{zoneId}/records/{recordId}",
				tags,
				security,
				summary: "Delete a record set",
				description:
					"A domain that created the record stops tracking it; its traffic stops resolving until a record exists again.",
				middleware: admin,
				request: { params: RecordParam },
				responses: { 204: { description: "Deleted" }, ...errors },
			}),
		),
		async (c) => {
			const { id, zoneId, recordId } = c.req.valid("param");
			const { db, masterKey } = c.var.deps;
			const { row, zone } = await zoneOf(
				db,
				requireActor(c).organizationId,
				id,
				zoneId,
			);
			const p = await openProvider(masterKey, row);
			await viaProvider(() => p.deleteRecord(zone.id, recordId));
			await db
				.update(domain)
				.set({ dnsRecordId: null })
				.where(
					and(
						eq(domain.dnsProviderId, row.id),
						eq(domain.dnsRecordId, recordId),
					),
				);
			c.set("auditResourceId", recordId);
			return c.body(null, 204);
		},
	);

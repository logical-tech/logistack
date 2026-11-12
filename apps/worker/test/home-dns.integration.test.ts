import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Resolver } from "node:dns/promises";
import { connect } from "node:net";
import { HomeDnsSettings, TECHNITIUM_PORT } from "@logistack/contracts";
import { decrypt, encrypt, importMasterKey } from "@logistack/core";
import { createDb, homeNetwork, node, organization } from "@logistack/db";
import {
	createDockerClient,
	DockerError,
	type ServiceSpec,
} from "@logistack/docker";
import { technitium } from "@logistack/providers";
import { eq } from "drizzle-orm";
import type { Ctx } from "../src/ctx.ts";
import {
	HOME_DNS_LABEL,
	type HomeDnsDeps,
	homeDnsNames,
	syncHomeDns,
} from "../src/home-dns.ts";
import { cleanup, hasDocker, startInfra, workerConfig } from "./harness.ts";

// Its own prefix, so cleanup never reaches the api and client suites' `ls-test-homedns-*` objects.
const AREA = "homedns-worker";

type Published = {
	type: string;
	org: string;
	payload: Record<string, unknown>;
};

/** A Technitium that remembers what it was told; `reset()` is a fresh data volume. */
function fakeTechnitium(password: string) {
	const state = {
		up: true,
		tokens: new Set<string>(),
		logins: 0,
		settingsApplied: 0,
		settings: {} as Record<string, string>,
		zones: new Set<string>(),
		installed: false,
		installs: 0,
		/** Resolves the pending install, as the download finishing would. */
		finishInstall: () => {},
	};
	const ok = (response: unknown = {}) =>
		Response.json({ status: "ok", response });
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (!state.up) return new Response("down", { status: 502 });
			const path = new URL(req.url).pathname;
			const form = Object.fromEntries(new URLSearchParams(await req.text()));
			const token = req.headers.get("authorization")?.replace("Bearer ", "");
			if (path === "/api/status") return Response.json({ status: "ok" });
			if (path === "/api/user/login") {
				state.logins++;
				if (form.user !== "admin" || form.pass !== password)
					return Response.json({
						status: "error",
						errorMessage: "Invalid username or password",
					});
				const session = `session-${crypto.randomUUID()}`;
				state.tokens.add(session);
				return Response.json({ status: "ok", token: session });
			}
			if (!token || !state.tokens.has(token))
				return Response.json({
					status: "invalid-token",
					errorMessage: "Invalid token",
				});
			switch (path) {
				case "/api/user/createToken": {
					const t = `api-${crypto.randomUUID()}`;
					state.tokens.add(t);
					return Response.json({ status: "ok", token: t });
				}
				case "/api/settings/get":
					return ok({ version: "15.6.2" });
				case "/api/settings/set":
					state.settingsApplied++;
					state.settings = form;
					return ok();
				case "/api/zones/list":
					return ok({
						zones: [...state.zones].map((name) => ({
							name,
							type: "Primary",
							disabled: false,
						})),
					});
				case "/api/zones/create":
					state.zones.add(form.zone ?? "");
					return ok();
				case "/api/apps/list":
					return ok({
						apps: state.installed
							? [{ name: "Query Logs (Sqlite)", version: "9.1.3" }]
							: [],
					});
				case "/api/apps/listStoreApps":
					return ok({
						storeApps: [
							{
								name: "Query Logs (Sqlite)",
								url: "https://download.example/ql.zip",
							},
						],
					});
				case "/api/apps/downloadAndInstall":
					state.installs++;
					await new Promise<void>((resolve) => {
						state.finishInstall = resolve;
					});
					state.installed = true;
					return ok();
			}
			return Response.json({
				status: "error",
				errorMessage: `unexpected ${path}`,
			});
		},
	});
	return {
		state,
		url: `http://127.0.0.1:${server.port}`,
		reset() {
			state.tokens.clear();
			state.zones.clear();
		},
		stop: () => server.stop(true),
	};
}

type FakeService = {
	ID: string;
	Spec: ServiceSpec;
	Version: { Index: number };
};

/** Enough of the Engine API for the sync: services by label, and volume removal. */
function fakeDocker() {
	const f = {
		services: new Map<string, FakeService>(),
		removedVolumes: [] as string[],
		volumeInUse: false,
		nodeLabels: {} as Record<string, string>,
	};
	const find = (key: string) =>
		[...f.services.values()].find((s) => s.ID === key || s.Spec.Name === key);
	const client = {
		nodes: {
			list: async (filters?: { "node.label"?: string[] }) =>
				(filters?.["node.label"] ?? []).every((l) => {
					const [k, v] = l.split("=");
					return f.nodeLabels[k as string] === v;
				})
					? [
							{
								ID: "swarm-1",
								Version: { Index: 1 },
								Spec: {
									Labels: f.nodeLabels,
									Role: "manager",
									Availability: "active",
								},
							},
						]
					: [],
			update: async (
				_id: string,
				_v: number,
				spec: { Labels?: Record<string, string> },
			) => {
				f.nodeLabels = spec.Labels ?? {};
			},
		},
		services: {
			list: async (filters?: { label?: string[] }) =>
				[...f.services.values()].filter((s) =>
					(filters?.label ?? []).every((l) => {
						const [k, v] = l.split("=");
						return s.Spec.Labels?.[k as string] === v;
					}),
				),
			inspect: async (key: string) => {
				const s = find(key);
				if (!s) throw new DockerError(404, "no such service", "GET", key);
				return s;
			},
			create: async (spec: ServiceSpec) => {
				const ID = crypto.randomUUID();
				f.services.set(ID, { ID, Spec: spec, Version: { Index: 1 } });
				return { ID };
			},
			update: async (id: string, _v: number, spec: ServiceSpec) => {
				const s = find(id);
				if (s)
					f.services.set(s.ID, {
						...s,
						Spec: spec,
						Version: { Index: s.Version.Index + 1 },
					});
				return {};
			},
			remove: async (id: string) => {
				f.services.delete(id);
			},
		},
		volumes: {
			remove: async (name: string) => {
				if (f.volumeInUse)
					throw new DockerError(409, "volume is in use", "DELETE", name);
				f.removedVolumes.push(name);
			},
		},
	};
	return Object.assign(f, { client });
}

describe.skipIf(!hasDocker)("home dns sync against fakes", () => {
	let ctx: Ctx;
	let rowId: string;
	let nodeId: string;
	const password = "fake-admin-password";
	const tech = fakeTechnitium(password);
	const docker = fakeDocker();
	const events: Published[] = [];
	let probeError: Error | undefined;
	const deps: HomeDnsDeps = {
		url: () => tech.url,
		probe: async () => {
			if (probeError) throw probeError;
		},
	};
	const sync = () => syncHomeDns(ctx, deps);
	const row = async () => (await ctx.db.select().from(homeNetwork))[0];

	beforeAll(async () => {
		await cleanup(AREA);
		const infra = await startInfra(AREA);
		const cfg = await workerConfig(infra, AREA);
		ctx = {
			cfg,
			db: createDb(cfg.DATABASE_URL, { onnotice: () => {} }),
			docker: docker.client,
			masterKey: await importMasterKey(cfg.LOGISTACK_MASTER_KEY),
			bus: {
				publish: async (
					type: string,
					org: string,
					_r: unknown,
					payload: Record<string, unknown> = {},
				) => {
					events.push({ type, org, payload });
				},
			},
		} as unknown as Ctx;
		for (const id of ["org-a", "org-b"])
			await ctx.db
				.insert(organization)
				.values({ id, name: id, slug: id, createdAt: new Date() });
		const [n] = await ctx.db
			.insert(node)
			.values({
				organizationId: "org-a",
				swarmNodeId: "swarm-1",
				hostname: "home",
				address: "10.0.0.9",
				role: "manager",
			})
			.returning();
		nodeId = n?.id as string;
		const [r] = await ctx.db
			.insert(homeNetwork)
			.values({
				nodeId,
				lanAddress: "192.168.1.2",
				settings: HomeDnsSettings.parse({ localZone: "home.lan" }),
				adminPasswordEncrypted: await encrypt(ctx.masterKey, password),
			})
			.returning();
		rowId = r?.id as string;
	}, 180_000);

	afterAll(async () => {
		tech.state.finishInstall();
		tech.stop();
		await cleanup(AREA);
	}, 120_000);

	test("first pass: service, token, settings, zone and port 53 make it ready while the extension installs", async () => {
		await sync();
		const [svc] = docker.services.values();
		expect(svc?.Spec.Name).toBe(homeDnsNames(ctx, rowId).service);
		expect(svc?.Spec.Labels).toMatchObject({
			"logistack.managed": "true",
			"logistack.kind": "system",
			"logistack.org": "system",
			"logistack.resource": rowId,
			[HOME_DNS_LABEL]: "true",
			"logistack.test": AREA,
		});
		const r = await row();
		expect(r).toMatchObject({
			status: "ready",
			version: "15.6.2",
			serviceId: svc?.ID,
		});
		expect(r?.statusMessage).toContain("Installing the query log extension");
		expect(
			tech.state.tokens.has(
				await decrypt(ctx.masterKey, r?.tokenEncrypted ?? ""),
			),
		).toBe(true);
		expect(tech.state.settings).toEqual({
			forwarders: "https://cloudflare-dns.com/dns-query (1.1.1.1)",
			forwarderProtocol: "Https",
			dnssecValidation: "true",
			enableBlocking: "true",
			blockListUrls: "false",
		});
		expect([...tech.state.zones]).toEqual(["home.lan"]);
		expect(events).toEqual([]);
	});

	test("a second pass changes nothing; the finished install clears the message", async () => {
		const before = {
			...tech.state,
			version: [...docker.services.values()][0]?.Version.Index,
		};
		await sync();
		expect(tech.state.logins).toBe(before.logins);
		expect(tech.state.settingsApplied).toBe(before.settingsApplied);
		expect(tech.state.installs).toBe(1);
		expect([...docker.services.values()][0]?.Version.Index).toBe(
			before.version,
		);
		tech.state.finishInstall();
		await Bun.sleep(50);
		await sync();
		expect((await row())?.statusMessage).toBeNull();
	});

	test("changed settings are applied once", async () => {
		const applied = tech.state.settingsApplied;
		const r = await row();
		await ctx.db.update(homeNetwork).set({
			settings: {
				...(r?.settings as HomeDnsSettings),
				dnssecValidation: false,
			},
		});
		await sync();
		await sync();
		expect(tech.state.settingsApplied).toBe(applied + 1);
		expect(tech.state.settings.dnssecValidation).toBe("false");
	});

	test("port 53 not answering is an error that fires once to every organization, then resolves", async () => {
		probeError = new Error("queryA ETIMEOUT localhost");
		await sync();
		await sync();
		const r = await row();
		expect(r?.status).toBe("error");
		expect(r?.statusMessage).toContain("port 53 on 192.168.1.2 does not");
		expect(r?.statusMessage).toContain("install.sh --enable-dns");
		expect(events.map((e) => [e.org, e.payload.state])).toEqual([
			["org-a", "firing"],
			["org-b", "firing"],
		]);
		expect(events[0]).toMatchObject({
			type: "network.dns.unhealthy",
			payload: { name: "Home DNS on home", node: "home" },
		});
		probeError = undefined;
		await sync();
		expect((await row())?.status).toBe("ready");
		expect(events.slice(2).map((e) => e.payload.state)).toEqual([
			"resolved",
			"resolved",
		]);
	});

	test("a Technitium that lost its data (a new volume) gets a new token and the settings again", async () => {
		tech.reset();
		const applied = tech.state.settingsApplied;
		const old = (await row())?.tokenEncrypted;
		await sync();
		const r = await row();
		expect(r?.status).toBe("ready");
		expect(r?.tokenEncrypted).not.toBe(old);
		expect(tech.state.settingsApplied).toBe(applied + 1);
		expect([...tech.state.zones]).toEqual(["home.lan"]);
	});

	test("stop removes the service and keeps the data; start brings it back", async () => {
		await ctx.db.update(homeNetwork).set({ desiredState: "stopped" });
		await sync();
		expect(docker.services.size).toBe(0);
		expect(await row()).toMatchObject({ status: "stopped", serviceId: null });
		expect(docker.removedVolumes).toEqual([]);
		await ctx.db.update(homeNetwork).set({ desiredState: "running" });
		await sync();
		expect(docker.services.size).toBe(1);
		expect((await row())?.status).toBe("ready");
	});

	test("an API that stops answering: a fresh start waits, a ready one is an error", async () => {
		tech.state.up = false;
		await sync();
		expect((await row())?.status).toBe("error");
		expect((await row())?.statusMessage).toContain("does not answer");
		tech.state.up = true;
		await sync();
		expect((await row())?.status).toBe("ready");

		// Moving to another node redeploys; until the API answers it is starting, not an error.
		const [other] = await ctx.db
			.insert(node)
			.values({
				organizationId: "org-a",
				swarmNodeId: "swarm-2",
				hostname: "other",
				address: "10.0.0.10",
				role: "worker",
			})
			.returning();
		await ctx.db.update(homeNetwork).set({ nodeId: other?.id as string });
		tech.state.up = false;
		const fired = events.length;
		await sync();
		expect(await row()).toMatchObject({
			status: "starting",
			statusMessage: "Waiting for Technitium to start",
		});
		expect(
			[...docker.services.values()][0]?.Spec.TaskTemplate.Placement
				?.Constraints,
		).toEqual(["node.id==swarm-2"]);
		tech.state.up = true;
		await sync();
		expect((await row())?.status).toBe("ready");
		expect(events.length).toBe(fired);
	});

	test("a purge removes the service, then the volume once free, then the row", async () => {
		await ctx.db.update(homeNetwork).set({ desiredState: "removed" });
		await sync();
		expect(docker.services.size).toBe(0);
		expect(await row()).toBeDefined();
		docker.volumeInUse = true;
		await sync();
		expect(await row()).toBeDefined();
		docker.volumeInUse = false;
		await sync();
		expect(docker.removedVolumes).toEqual([homeDnsNames(ctx, rowId).volume]);
		expect(await row()).toBeUndefined();
	});

	test("a deleted row (turned off without purge) removes the service and leaves the volume", async () => {
		const [r] = await ctx.db
			.insert(homeNetwork)
			.values({
				nodeId,
				lanAddress: "192.168.1.2",
				settings: HomeDnsSettings.parse({}),
				adminPasswordEncrypted: await encrypt(ctx.masterKey, password),
			})
			.returning();
		await sync();
		expect(docker.services.size).toBe(1);
		await ctx.db.delete(homeNetwork).where(eq(homeNetwork.id, r?.id as string));
		await sync();
		expect(docker.services.size).toBe(0);
		expect(docker.removedVolumes).toHaveLength(1);
	});

	test("the installer's node label turns the DNS on once with defaults; turning it off sticks", async () => {
		docker.nodeLabels = { "logistack.dns": "true", "logistack.data": "true" };
		await sync();
		const adopted = await row();
		expect(adopted).toMatchObject({ nodeId, lanAddress: "10.0.0.9" });
		expect(adopted?.settings.blocking.listUrls).toHaveLength(1);
		expect(docker.nodeLabels).toEqual({ "logistack.data": "true" });
		expect(docker.services.size).toBe(1);

		await ctx.db.update(homeNetwork).set({ desiredState: "removed" });
		await sync();
		await sync();
		await sync();
		expect(await row()).toBeUndefined();
		expect(docker.services.size).toBe(0);
	});
});

const portBusy = (port: number) =>
	new Promise<boolean>((resolve) => {
		const s = connect({ host: "127.0.0.1", port });
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});

// Host networking binds 53 and 5380 on the node; the dev machine may run another DNS there.
const busy =
	hasDocker && ((await portBusy(TECHNITIUM_PORT)) || (await portBusy(53)));
if (busy)
	console.warn(
		`home dns swarm test skipped: 127.0.0.1:${TECHNITIUM_PORT} or :53 is already in use on this machine`,
	);

describe.skipIf(!hasDocker || busy)("home dns on the local swarm", () => {
	let ctx: Ctx;
	const AREA_SWARM = "homedns-swarm";
	const docker = createDockerClient();

	beforeAll(async () => {
		await cleanup(AREA_SWARM);
		const infra = await startInfra(AREA_SWARM);
		const cfg = await workerConfig(infra, AREA_SWARM);
		ctx = {
			cfg,
			db: createDb(cfg.DATABASE_URL, { onnotice: () => {} }),
			docker,
			masterKey: await importMasterKey(cfg.LOGISTACK_MASTER_KEY),
			bus: { publish: async () => {} },
		} as unknown as Ctx;
		await ctx.db
			.insert(organization)
			.values({ id: "org-s", name: "S", slug: "s", createdAt: new Date() });
		const swarmNodeId = (await docker.info()).Swarm.NodeID;
		const [n] = await ctx.db
			.insert(node)
			.values({
				organizationId: "org-s",
				swarmNodeId,
				hostname: "dev",
				address: "127.0.0.1",
				role: "manager",
			})
			.returning();
		await ctx.db.insert(homeNetwork).values({
			nodeId: n?.id as string,
			lanAddress: "127.0.0.1",
			settings: HomeDnsSettings.parse({
				upstream: { servers: ["1.1.1.1"], protocol: "Udp" },
				localZone: "home.lan",
			}),
			adminPasswordEncrypted: await encrypt(ctx.masterKey, crypto.randomUUID()),
		});
	}, 180_000);

	afterAll(() => cleanup(AREA_SWARM), 120_000);

	test("Technitium starts on the host network, becomes ready and answers a name on port 53", async () => {
		const row = async () => (await ctx.db.select().from(homeNetwork))[0];
		for (let i = 0; i < 90 && (await row())?.status !== "ready"; i++) {
			await syncHomeDns(ctx);
			if ((await row())?.status === "error") break;
			await Bun.sleep(2_000);
		}
		const r = await row();
		expect(r?.status, r?.statusMessage ?? "").toBe("ready");

		const api = technitium(
			`http://127.0.0.1:${TECHNITIUM_PORT}`,
			await decrypt(ctx.masterKey, r?.tokenEncrypted ?? ""),
		);
		await api.addRecord("home.lan", {
			name: "nas.home.lan",
			type: "A",
			content: "192.168.1.10",
			ttl: 60,
		});
		const resolver = new Resolver({ timeout: 3_000, tries: 2 });
		resolver.setServers(["127.0.0.1"]);
		expect(await resolver.resolve4("nas.home.lan")).toEqual(["192.168.1.10"]);

		await ctx.db.update(homeNetwork).set({ desiredState: "removed" });
		for (let i = 0; i < 30 && (await row()); i++) {
			await syncHomeDns(ctx);
			await Bun.sleep(1_000);
		}
		expect(await row()).toBeUndefined();
		expect(
			await docker.services.list({
				label: [`${HOME_DNS_LABEL}=true`, `logistack.test=${AREA_SWARM}`],
			}),
		).toEqual([]);
		expect(
			await docker.volumes.list({
				name: [homeDnsNames(ctx, r?.id ?? "").volume],
			}),
		).toEqual([]);
	}, 300_000);
});

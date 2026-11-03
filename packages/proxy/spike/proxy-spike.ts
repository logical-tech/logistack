// Reproduces the evidence in docs/spikes/proxy.md against the local Docker engine.
// Usage: bun packages/proxy/spike/proxy-spike.ts <setup|features|shared|zero [reloads]|invalid|timing|deadlock|dns|psl|cleanup|all>
// Creates only ls-test-proxy-* objects labelled logistack.test=true; `cleanup` (and `all`) removes them by name.
import {
	CaddyAdmin,
	CaddyAdminError,
	type CaddyConfig,
	compileProxy,
	type ProxyRoute,
} from "../src/index.ts";

const IMAGE = "ls-test-caddy";
const NET = "ls-test-proxy-net";
const LABEL = "logistack.test=true";
const CADDIES = [
	{ name: "ls-test-proxy-caddy1", admin: 20191, http: 18081, https: 18441 },
	{ name: "ls-test-proxy-caddy2", admin: 20192, http: 18082, https: 18442 },
] as const;
const [c1, c2] = CADDIES;
const admin1 = new CaddyAdmin(`http://127.0.0.1:${c1.admin}`, 60_000);
const admin2 = new CaddyAdmin(`http://127.0.0.1:${c2.admin}`, 60_000);
const upstream = { host: "ls-test-proxy-upstream", port: 8080 };

async function run(
	argv: string[],
	stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
	const p = Bun.spawn(argv, {
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out, err };
}

async function docker(...args: string[]): Promise<string> {
	const r = await run(["docker", ...args]);
	if (r.code !== 0) throw new Error(`docker ${args.join(" ")}: ${r.err}`);
	return r.out.trim();
}

const route = (id: string, hostname: string, https = true): ProxyRoute =>
	https
		? { domainId: id, hostname, upstream, https: true, cert: "auto" }
		: { domainId: id, hostname, upstream, https: false, cert: "none" };

/** compileProxy output with every issuer swapped for Caddy's internal CA, so no public ACME is contacted. */
function spikeConfig(routes: ProxyRoute[]): CaddyConfig {
	const cfg = compileProxy({
		settings: {
			adminListen: "0.0.0.0:2019",
			acmeEmail: "spike@example.com",
			storage: {
				redisUrl: "redis://ls-test-proxy-redis:6379/0",
				keyPrefix: "ls-test",
			},
		},
		dashboard: { hostname: "dash.test", upstream },
		routes,
	});
	for (const p of cfg.apps.tls.automation.policies)
		p.issuers = [{ module: "internal" }];
	return {
		...cfg,
		apps: {
			...cfg.apps,
			pki: { certificate_authorities: { local: { install_trust: false } } },
		},
	} as CaddyConfig;
}

async function waitFor(
	check: () => Promise<boolean>,
	what: string,
	ms = 30_000,
) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check().catch(() => false)) return;
		await Bun.sleep(200);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function setup() {
	await docker("network", "create", "--label", LABEL, NET);
	await docker(
		"run",
		"-d",
		"--name",
		"ls-test-proxy-redis",
		"--label",
		LABEL,
		"--network",
		NET,
		"--tmpfs",
		"/data",
		"redis:7-alpine",
	);
	await docker(
		"run",
		"-d",
		"--name",
		"ls-test-proxy-upstream",
		"--label",
		LABEL,
		"--network",
		NET,
		"--tmpfs",
		"/data",
		"--tmpfs",
		"/config",
		IMAGE,
		"caddy",
		"respond",
		"--listen",
		":8080",
		"--body",
		"upstream ok",
	);
	for (const c of CADDIES) {
		await docker(
			"run",
			"-d",
			"--name",
			c.name,
			"--label",
			LABEL,
			"--network",
			NET,
			"--tmpfs",
			"/data",
			"--tmpfs",
			"/config",
			"-p",
			`127.0.0.1:${c.admin}:2019`,
			"-p",
			`127.0.0.1:${c.http}:80`,
			"-p",
			`127.0.0.1:${c.https}:443`,
			IMAGE,
		);
	}
	for (const a of [admin1, admin2])
		await waitFor(
			async () => (await a.getConfig()) !== undefined,
			`${a.endpoint} admin`,
		);
}

// Removes only the objects this script creates, by exact name: other agents share the engine.
const OWNED = [
	...CADDIES.map((c) => c.name),
	"ls-test-proxy-redis",
	"ls-test-proxy-upstream",
	"ls-test-proxy-validate",
];
async function cleanup() {
	for (const name of OWNED) await run(["docker", "rm", "-f", "-v", name]);
	await run(["docker", "network", "rm", NET]);
}

async function curl(port: number, host: string, https: boolean, path = "/") {
	const scheme = https ? "https" : "http";
	const r = await run([
		"curl",
		"-skS",
		"-o",
		"/dev/null",
		"-m",
		"10",
		"-w",
		"%{http_code}",
		"--resolve",
		`${host}:${port}:127.0.0.1`,
		`${scheme}://${host}:${port}${path}`,
	]);
	return r.code === 0
		? r.out
		: `curl-exit-${r.code} ${r.err.trim().slice(0, 90)}`;
}

async function certOf(port: number, host: string) {
	const s = await run(
		[
			"openssl",
			"s_client",
			"-connect",
			`127.0.0.1:${port}`,
			"-servername",
			host,
		],
		"",
	);
	const x = await run(
		[
			"openssl",
			"x509",
			"-noout",
			"-serial",
			"-fingerprint",
			"-sha256",
			"-issuer",
		],
		s.out,
	);
	return x.code === 0 ? x.out.trim().split("\n") : null;
}

const logs = async (name: string) => {
	const r = await run(["docker", "logs", name]);
	return r.out + r.err;
};
const countLines = (text: string, ...needles: string[]) =>
	text.split("\n").filter((l) => needles.every((n) => l.includes(n))).length;

async function shared() {
	const cfg = spikeConfig([route("shared", "shared.test")]);
	await admin1.load(cfg);
	await waitFor(
		async () => (await certOf(c1.https, "shared.test")) !== null,
		"caddy1 cert",
	);
	const cert1 = await certOf(c1.https, "shared.test");
	const keysAfter1 = await docker(
		"exec",
		"ls-test-proxy-redis",
		"redis-cli",
		"--scan",
		"--pattern",
		"ls-test*",
	);

	await admin2.load(cfg);
	await waitFor(
		async () => (await certOf(c2.https, "shared.test")) !== null,
		"caddy2 cert",
	);
	const cert2 = await certOf(c2.https, "shared.test");
	const [l1, l2] = await Promise.all([logs(c1.name), logs(c2.name)]);
	return {
		cert1,
		cert2,
		sameCert: JSON.stringify(cert1) === JSON.stringify(cert2),
		caddy1: {
			obtaining: countLines(l1, "obtaining certificate", "shared.test"),
			obtained: countLines(
				l1,
				"certificate obtained successfully",
				"shared.test",
			),
		},
		caddy2: {
			obtaining: countLines(l2, "obtaining certificate", "shared.test"),
			obtained: countLines(
				l2,
				"certificate obtained successfully",
				"shared.test",
			),
			loadedFromStorage: l2
				.split("\n")
				.filter(
					(l) => l.includes("shared.test") && !l.includes("http.log.access"),
				)
				.slice(0, 5),
		},
		redisKeys: keysAfter1.split("\n").sort(),
		caddy2Https: await curl(c2.https, "shared.test", true),
	};
}

async function zero(reloads = Number(process.argv[3] ?? 20)) {
	const base = [route("app", "app.test"), route("plain", "plain.test", false)];
	await admin1.load(spikeConfig(base));
	await waitFor(
		async () => (await curl(c1.https, "app.test", true)) === "200",
		"app.test 200",
	);

	const codes = new Map<string, number>();
	const tally = (k: string) => codes.set(k, (codes.get(k) ?? 0) + 1);
	let loadsDone = false;
	let total = 0;
	const loadMs: number[] = [];

	const curlWorker = async (https: boolean) => {
		while (!loadsDone || total < 2000) {
			total++;
			tally(
				https
					? `https ${await curl(c1.https, "app.test", true)}`
					: `http ${await curl(c1.http, "plain.test", false)}`,
			);
		}
	};
	// A keep-alive client exercises connections that straddle a config swap.
	let keepAlive = 0;
	const keepAliveWorker = async () => {
		while (!loadsDone || total < 2000) {
			keepAlive++;
			try {
				const res = await fetch(`http://127.0.0.1:${c1.http}/`, {
					headers: { Host: "plain.test" },
				});
				await res.text();
				tally(`keepalive ${res.status}`);
			} catch (e) {
				tally(`keepalive error ${String(e).slice(0, 80)}`);
			}
		}
	};
	const loader = async () => {
		for (let i = 0; i < reloads; i++) {
			const extra = Array.from({ length: i + 1 }, (_, j) =>
				route(`x${i}-${j}`, `r${j}-${i}.test`),
			);
			const t = performance.now();
			await admin1.load(spikeConfig([...base, ...extra]));
			loadMs.push(Math.round(performance.now() - t));
			await Bun.sleep(250);
		}
		loadsDone = true;
	};
	const started = performance.now();
	await Promise.all([
		loader(),
		curlWorker(true),
		curlWorker(true),
		curlWorker(true),
		curlWorker(false),
		keepAliveWorker(),
	]);
	const running = await admin1.getConfig();
	return {
		curlRequests: total,
		keepAliveRequests: keepAlive,
		seconds: Math.round((performance.now() - started) / 100) / 10,
		codes: Object.fromEntries(codes),
		loads: loadMs.length,
		loadMs,
		finalHttpsRouteCount: running?.apps.http.servers.https?.routes.length,
	};
}

async function invalid() {
	const good = spikeConfig([route("app", "app.test")]);
	await admin1.load(good);
	const bad = structuredClone(good) as unknown as {
		apps: { http: { servers: { https: { routes: { handle: unknown[] }[] } } } };
	};
	const target = bad.apps.http.servers.https.routes[1];
	if (target) target.handle = [{ handler: "no_such_handler" }];
	let surfaced: unknown = null;
	try {
		await admin1.load(bad as unknown as CaddyConfig);
	} catch (e) {
		surfaced =
			e instanceof CaddyAdminError
				? { name: e.name, failure: e.failure, message: e.message }
				: String(e);
	}
	const running = await admin1.getConfig();
	return {
		surfaced,
		// Caddy re-marshals the config with sorted keys, so compare structurally.
		runningConfigUnchanged: Bun.deepEquals(
			running,
			JSON.parse(JSON.stringify(good)),
		),
		stillServing: await curl(c1.https, "app.test", true),
	};
}

async function memMiB(name: string) {
	const usage = await docker(
		"stats",
		"--no-stream",
		"--format",
		"{{.MemUsage}}",
		name,
	);
	return usage.split(" / ")[0];
}

async function timing() {
	const out: Record<string, unknown>[] = [];
	for (const https of [false, true]) {
		for (const n of [10, 1000, 5000]) {
			const routes = Array.from({ length: n }, (_, i) =>
				route(`t${i}`, `t${i}.timing.test`, https),
			);
			const before = await memMiB(c2.name);
			const samples: number[] = [];
			for (let i = 0; i < 6; i++) {
				// A changing extra route forces a real reload; Caddy skips identical configs.
				const cfg = spikeConfig([
					...routes,
					route(`toggle${i}`, `toggle${i}.test`, false),
				]);
				const t = performance.now();
				await admin2.load(cfg);
				samples.push(Math.round(performance.now() - t));
				if (i === 0 && https) await Bun.sleep(n >= 1000 ? 20_000 : 2_000);
			}
			const bytes = JSON.stringify(spikeConfig(routes)).length;
			const sorted = samples.slice(1).sort((a, b) => a - b);
			out.push({
				https,
				routes: n,
				configKiB: Math.round(bytes / 1024),
				firstLoadMs: samples[0],
				medianLoadMs: sorted[Math.floor(sorted.length / 2)],
				samplesMs: samples,
				memBefore: before,
				memAfter: await memMiB(c2.name),
			});
			console.error(JSON.stringify(out.at(-1)));
		}
	}
	return out;
}

async function deadlock() {
	const base = [route("app", "app.test")];
	await admin1.load(spikeConfig(base));
	let loadOutcome = "";
	const server = Bun.serve({
		port: 0,
		hostname: "0.0.0.0",
		async fetch() {
			const t = performance.now();
			try {
				await admin1.load(spikeConfig([...base, route("after", "after.test")]));
				loadOutcome = `ok after ${Math.round(performance.now() - t)}ms`;
			} catch (e) {
				loadOutcome = `failed after ${Math.round(performance.now() - t)}ms: ${String(e)}`;
			}
			return new Response("loaded");
		},
	});
	try {
		await admin1.load(
			spikeConfig([
				...base,
				{
					domainId: "dl",
					hostname: "deadlock.test",
					upstream: { host: "host.docker.internal", port: Number(server.port) },
					https: false,
					cert: "none",
				},
			]),
		);
		const r = await run([
			"curl",
			"-s",
			"-m",
			"60",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code} %{time_total}s",
			"-H",
			"Host: deadlock.test",
			`http://127.0.0.1:${c1.http}/`,
		]);
		await waitFor(async () => loadOutcome !== "", "load outcome", 60_000);
		return {
			clientRequest: `${r.out} (curl exit ${r.code})`,
			loadInsideHandler: loadOutcome,
		};
	} finally {
		server.stop(true);
	}
}

async function dns() {
	const providers = [
		{
			provider: "cloudflare",
			credentials: { api_token: "abcdefghijklmnopqrstuvwxyz0123456789ABCD" },
		},
		{
			provider: "route53",
			credentials: {
				access_key_id: "x",
				secret_access_key: "x",
				region: "eu-west-1",
			},
		},
		{ provider: "hetzner", credentials: { api_token: "x" } },
		{ provider: "digitalocean", credentials: { auth_token: "x" } },
		{
			provider: "ovh",
			credentials: {
				endpoint: "ovh-eu",
				application_key: "x",
				application_secret: "x",
				consumer_key: "x",
			},
		},
		{ provider: "porkbun", credentials: { api_key: "x", api_secret_key: "x" } },
	] as const;
	const validate = async (cfg: CaddyConfig) => {
		// File storage and no network: validate provisions every module strictly but cannot reach any CA.
		const json = JSON.stringify({
			...cfg,
			storage: { module: "file_system", root: "/tmp/caddy" },
		});
		const r = await run(
			[
				"docker",
				"run",
				"--rm",
				"-i",
				"--network",
				"none",
				"--label",
				LABEL,
				"--name",
				"ls-test-proxy-validate",
				IMAGE,
				"caddy",
				"validate",
				"--config",
				"/dev/stdin",
			],
			json,
		);
		return r.code === 0
			? "valid"
			: (r.err.split("\n").find((l) => l.startsWith("Error")) ??
					r.err.slice(-300));
	};
	const compiled = (challenge: (typeof providers)[number]) =>
		compileProxy({
			settings: {
				adminListen: "localhost:2019",
				acmeEmail: "spike@example.com",
				storage: { redisUrl: "redis://x:6379", keyPrefix: "k" },
			},
			dashboard: { hostname: "dash.example.com", upstream },
			routes: [
				{
					domainId: "w",
					hostname: "*.wild.example.com",
					upstream,
					https: true,
					cert: "auto",
					dnsChallenge: challenge,
				},
			],
		});
	const results: Record<string, string> = {};
	for (const p of providers) results[p.provider] = await validate(compiled(p));
	const typo = compiled(providers[0]);
	const provider = typo.apps.tls.automation.policies[0]?.issuers[0];
	if (provider?.module === "acme" && provider.challenges)
		provider.challenges.dns.provider = { name: "cloudflare", api_tokn: "x" };
	results["cloudflare with misspelled key (negative control)"] =
		await validate(typo);
	return results;
}

async function psl() {
	const text = await (
		await fetch("https://publicsuffix.org/list/public_suffix_list.dat")
	).text();
	const lines = text.split("\n");
	// Substring match also catches wildcard entries ("*.sslip.io") and comment lines.
	const find = (d: string) => lines.filter((l) => l.toLowerCase().includes(d));
	const version =
		lines.find((l) => l.startsWith("// VERSION:")) ??
		lines.find((l) => l.includes("COMMIT"));
	return {
		fetched: new Date().toISOString(),
		version,
		bytes: text.length,
		"sslip.io": find("sslip.io"),
		"nip.io": find("nip.io"),
		"traefik.me": find("traefik.me"),
		"duckdns.org (positive control)": find("duckdns.org"),
	};
}

/** Loads one config exercising every route feature into real Caddy and probes each behavior. */
async function features() {
	const gen = await run([
		"openssl",
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		"/dev/stdout",
		"-out",
		"/dev/stdout",
		"-subj",
		"/CN=custom.test",
		"-addext",
		"subjectAltName=DNS:custom.test",
		"-days",
		"1",
	]);
	const keyPem =
		gen.out.match(
			/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n/,
		)?.[0] ?? "";
	const certPem =
		gen.out.match(
			/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/,
		)?.[0] ?? "";
	const expectedSerial = (
		await run(["openssl", "x509", "-noout", "-serial"], certPem)
	).out.trim();
	await admin1.load(
		spikeConfig([
			route("app", "app.test"),
			{
				...route("api", "app.test"),
				pathPrefix: "/api",
				upstream: { host: "ls-test-proxy-upstream", port: 8080 },
			},
			{
				domainId: "wild",
				hostname: "*.wild.test",
				upstream,
				https: true,
				cert: "auto",
				dnsChallenge: {
					provider: "cloudflare",
					credentials: { api_token: "unused-internal-issuer" },
				},
			},
			{
				domainId: "custom",
				hostname: "custom.test",
				upstream,
				https: true,
				cert: "custom",
				customCert: { id: "c1", certPem, keyPem },
			},
			{ ...route("www", "www.test"), redirectTo: "https://app.test" },
			route("plain", "plain.test", false),
		]),
	);
	await waitFor(
		async () => (await curl(c1.https, "a.wild.test", true)) === "200",
		"wildcard cert",
	);
	const head = async (url: string, host: string, port: number) => {
		const r = await run([
			"curl",
			"-skS",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code} %{redirect_url}",
			"--resolve",
			`${host}:${port}:127.0.0.1`,
			url,
		]);
		return r.out.trim();
	};
	const wildCert = await run(
		["openssl", "x509", "-noout", "-text"],
		(
			await run(
				[
					"openssl",
					"s_client",
					"-connect",
					`127.0.0.1:${c1.https}`,
					"-servername",
					"a.wild.test",
				],
				"",
			)
		).out,
	);
	const customCert = await certOf(c1.https, "custom.test");
	const log = await logs(c1.name);
	return {
		httpsApp: await curl(c1.https, "app.test", true),
		httpsApiPrefix: await curl(c1.https, "app.test", true, "/api/x"),
		wildcardSubdomain: await curl(c1.https, "a.wild.test", true),
		wildcardCertSan: wildCert.out
			.split("\n")
			.find((l) => l.includes("DNS:"))
			?.trim(),
		customCertServed: customCert?.[0] === expectedSerial,
		customCertSkipLog:
			countLines(
				log,
				"skipping automatic certificate management",
				"custom.test",
			) > 0,
		customCertIssued: countLines(
			log,
			"certificate obtained successfully",
			"custom.test",
		),
		wwwRedirect: await head(
			`https://www.test:${c1.https}/foo?x=1`,
			"www.test",
			c1.https,
		),
		httpToHttps: await head(
			`http://app.test:${c1.http}/p`,
			"app.test",
			c1.http,
		),
		httpOnly: await curl(c1.http, "plain.test", false),
		unknownHttpHost: await curl(c1.http, "nobody.test", false),
		accessLogLine: log
			.split("\n")
			.find((l) => l.includes('"logger":"http.log.access.ls-access"'))
			?.slice(0, 160),
	};
}

const spikes: Record<string, () => Promise<unknown>> = {
	setup,
	features,
	shared,
	zero,
	invalid,
	timing,
	deadlock,
	dns,
	psl,
	cleanup,
};
const which = process.argv[2] ?? "all";
if (which === "all") {
	try {
		await setup();
		for (const name of [
			"shared",
			"zero",
			"invalid",
			"features",
			"deadlock",
			"timing",
			"dns",
			"psl",
		]) {
			console.log(JSON.stringify({ [name]: await spikes[name]?.() }, null, 2));
		}
	} finally {
		await cleanup();
	}
} else {
	const fn = spikes[which];
	if (!fn) throw new Error(`unknown spike ${which}`);
	console.log(JSON.stringify(await fn(), null, 2));
}

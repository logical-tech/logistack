import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	type DeploymentStatus,
	HOME_DNS_DEFAULT_BLOCKLIST,
	type HomeDns,
	Manifest,
	type ManifestChange,
} from "@logistack/contracts";
import { type Api, ApiError, client } from "./api.ts";
import {
	type Credentials,
	loadCredentials,
	saveCredentials,
} from "./config.ts";
import { renderChanges } from "./render.ts";

export type Io = {
	out: (s: string) => void;
	err: (s: string) => void;
	/** Reads one line from the terminal (or the next piped line); `hidden` does not echo. */
	prompt: (question: string, hidden?: boolean) => Promise<string>;
	/** Whether a person can answer prompts. */
	interactive: boolean;
	color: boolean;
	env: Record<string, string | undefined>;
	/** The HTTP client; tests pass the API app's own `request`. */
	fetch?: typeof fetch;
	/** Raw stdin for `exec`. */
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
};

export const VERSION = process.env.LOGISTACK_CLI_VERSION ?? "dev";

const HELP = `logistack ${VERSION}: LogiStack from the terminal and from CI

Usage: logistack <command> [flags]

Commands:
  login                 Save the instance URL and an API key (read from stdin or a prompt)
  diff -f <file>        Show what applying the manifest would change
  apply -f <file>       Show the diff, confirm, apply
  export                Print the project or environment as a manifest
  deploy                Queue a deployment of a service
  logs                  Print a service's logs (-f to follow)
  exec                  Open a shell in a running replica
  network <action>      Home network DNS: status, enable, start, stop, disable

Flags:
  -f, --file <path>       Manifest (YAML or JSON); - reads stdin
  --project <id>          Target project (default: the project named in the manifest)
  --environment <id>      Target environment, for an environment manifest
  --service <id>          deploy, logs, exec
  --prune                 apply/diff: delete what the manifest does not list
  -y, --yes               apply without asking
  --exit-code             diff: exit 2 when there are changes
  --wait                  deploy: wait until the deployment settles
  --follow                logs: keep following (also -F)
  --tail <n>              logs: lines per replica first (default 100)
  --shell <sh|bash>       exec: the shell (default sh)
  -o, --output <path>     export: write to a file
  --format <yaml|json>    export: default yaml
  --node <id|hostname>    network enable: the node that runs the DNS (default: the only node)
  --address <ipv4>        network enable: the address devices use as DNS (default: the node's)
  --zone <name>           network enable: a local zone to create, such as home.lan
  --url <url>             login: the instance URL
  --json                  Machine-readable output
  -h, --help              This help

Environment: LOGISTACK_URL and LOGISTACK_API_KEY override the saved login.`;

class UsageError extends Error {}

const flags = {
	file: { type: "string", short: "f" },
	project: { type: "string" },
	environment: { type: "string" },
	service: { type: "string" },
	prune: { type: "boolean", default: false },
	yes: { type: "boolean", short: "y", default: false },
	"exit-code": { type: "boolean", default: false },
	wait: { type: "boolean", default: false },
	follow: { type: "boolean", short: "F", default: false },
	tail: { type: "string", default: "100" },
	shell: { type: "string", default: "sh" },
	output: { type: "string", short: "o" },
	format: { type: "string", default: "yaml" },
	node: { type: "string" },
	address: { type: "string" },
	zone: { type: "string" },
	url: { type: "string" },
	json: { type: "boolean", default: false },
	help: { type: "boolean", short: "h", default: false },
	version: { type: "boolean", short: "v", default: false },
} as const;

type Flags = ReturnType<typeof parse>["values"];
const parse = (argv: string[]) =>
	parseArgs({ args: argv, options: flags, allowPositionals: true });

/** Runs one command and returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
	let values: Flags;
	let positionals: string[];
	try {
		({ values, positionals } = parse(argv));
	} catch (e) {
		io.err(`${(e as Error).message}\n\n${HELP}`);
		return 64;
	}
	const [command, action] = positionals;
	if (values.version) {
		io.out(VERSION);
		return 0;
	}
	if (values.help || !command) {
		io.out(HELP);
		return command ? 0 : 64;
	}
	try {
		if (command === "login") return await login(values, io);
		const creds = await loadCredentials(io.env);
		if (!creds)
			throw new UsageError(
				"not logged in: run `logistack login`, or set LOGISTACK_URL and LOGISTACK_API_KEY",
			);
		const api = client(creds, io.fetch);
		switch (command) {
			case "diff":
				return await apply(api, values, io, true);
			case "apply":
				return await apply(api, values, io, false);
			case "export":
				return await exportManifest(api, values, io);
			case "deploy":
				return await deploy(api, values, io);
			case "logs":
				return await logs(api, values, io);
			case "exec":
				return await exec(api, values, io);
			case "network":
				return await network(api, action, values, io);
			default:
				throw new UsageError(`unknown command ${command}\n\n${HELP}`);
		}
	} catch (e) {
		if (values.json)
			io.out(
				JSON.stringify({
					error: {
						message: (e as Error).message,
						...(e instanceof ApiError && {
							status: e.status,
							details: e.details,
						}),
					},
				}),
			);
		else {
			io.err(`error: ${(e as Error).message}`);
			if (e instanceof ApiError && e.details)
				io.err(JSON.stringify(e.details, null, 2));
		}
		return e instanceof UsageError ? 64 : 1;
	}
}

const DNS = "/network/dns";

/** Home network DNS. `enable` is the wizard's defaults in one call; the dashboard edits the rest. */
async function network(
	api: Api,
	action: string | undefined,
	values: Flags,
	io: Io,
) {
	const show = (d: HomeDns) => {
		if (values.json) io.out(JSON.stringify(d));
		else if (!d.enabled)
			io.out("Home DNS is off. Turn it on with `logistack network enable`.");
		else
			io.out(
				`Home DNS ${d.status} on ${d.nodeHostname} (${d.lanAddress})${d.version ? `, Technitium ${d.version}` : ""}${d.statusMessage ? `\n${d.statusMessage}` : ""}`,
			);
		return 0;
	};
	switch (action) {
		case undefined:
		case "status":
			return show(await api.get<HomeDns>(DNS));
		case "enable": {
			const nodes =
				await api.get<{ id: string; hostname: string; address: string }[]>(
					"/nodes",
				);
			const node = values.node
				? nodes.find((n) => n.id === values.node || n.hostname === values.node)
				: nodes.length === 1
					? nodes[0]
					: undefined;
			if (!node)
				throw new UsageError(
					values.node
						? `no node ${values.node}; nodes: ${nodes.map((n) => n.hostname).join(", ")}`
						: `pass --node <id|hostname>; nodes: ${nodes.map((n) => n.hostname).join(", ")}`,
				);
			const d = await api.post<HomeDns>(DNS, {
				nodeId: node.id,
				lanAddress: values.address ?? node.address,
				settings: {
					blocking: { enabled: true, listUrls: [HOME_DNS_DEFAULT_BLOCKLIST] },
					...(values.zone && { localZone: values.zone }),
				},
			});
			if (!values.json)
				io.err(
					`Starting. Port 53 on ${node.hostname} must be free (install.sh --enable-dns frees it). Then set ${d.lanAddress} as the DNS server on your router.`,
				);
			return show(d);
		}
		case "start":
		case "stop":
			return show(
				await api.patch<HomeDns>(DNS, {
					desiredState: action === "start" ? "running" : "stopped",
				}),
			);
		case "disable": {
			if (!values.yes) {
				if (!io.interactive)
					throw new UsageError("not a terminal: pass --yes to disable");
				const answer = await io.prompt(
					"This deletes the DNS and all its data (zones, records, lists, logs). Type yes: ",
				);
				if (answer.trim() !== "yes") {
					io.err("Nothing changed.");
					return 1;
				}
			}
			await api.del(DNS);
			if (values.json) io.out(JSON.stringify({ disabled: true }));
			else io.out("Home DNS is being removed.");
			return 0;
		}
		default:
			throw new UsageError(
				`unknown network action ${action}: use status, enable, start, stop or disable`,
			);
	}
}

async function login(values: Flags, io: Io) {
	const url =
		values.url ?? io.env.LOGISTACK_URL ?? (await io.prompt("Instance URL: "));
	const apiKey =
		io.env.LOGISTACK_API_KEY ?? (await io.prompt("API key (lss_...): ", true));
	const creds: Credentials = { url: url.trim(), apiKey: apiKey.trim() };
	const me = await client(creds, io.fetch).get<{
		user?: { email?: string };
		organization?: { name?: string };
	}>("/me");
	const path = await saveCredentials(creds, io.env);
	if (values.json)
		io.out(JSON.stringify({ url: creds.url, configPath: path, me }));
	else
		io.out(
			`Logged in to ${creds.url}${me.organization?.name ? ` (${me.organization.name})` : ""}. Saved to ${path}.`,
		);
	return 0;
}

async function readManifest(path: string | undefined, io: Io) {
	if (!path) throw new UsageError("-f <file> is required");
	const text =
		path === "-"
			? await new Response(Bun.stdin.stream()).text()
			: await readFile(path, "utf8");
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(text);
	} catch (e) {
		throw new UsageError(
			`${path} is not YAML or JSON: ${(e as Error).message}`,
		);
	}
	const parsed = Manifest.safeParse(raw);
	if (!parsed.success)
		throw new UsageError(
			`${path} is not a valid manifest:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
		);
	void io;
	return { manifest: parsed.data, text };
}

/** The apply endpoint for the manifest: the given id, or the project of the manifest's name. */
async function target(api: Api, manifest: Manifest, values: Flags) {
	if (manifest.kind === "environment") {
		if (!values.environment)
			throw new UsageError("an environment manifest needs --environment <id>");
		return `/environments/${values.environment}/apply`;
	}
	if (values.project) return `/projects/${values.project}/apply`;
	const projects = await api.get<{ id: string; name: string }[]>("/projects");
	const found = projects.filter((p) => p.name === manifest.project.name);
	if (found.length === 1) return `/projects/${found[0]?.id}/apply`;
	throw new UsageError(
		found.length
			? `${found.length} projects are named "${manifest.project.name}": pass --project <id>`
			: `no project named "${manifest.project.name}": create it first, or pass --project <id>`,
	);
}

type ApplyResult = {
	applied: boolean;
	changes: ManifestChange[];
	warnings: string[];
	backupKeys: {
		environment: string;
		service: string;
		backup: string;
		key: string;
	}[];
};

async function apply(api: Api, values: Flags, io: Io, dryRunOnly: boolean) {
	const { manifest, text } = await readManifest(values.file, io);
	const path = await target(api, manifest, values);
	const body = { manifest: text, prune: values.prune };
	const plan = await api.post<ApplyResult>(path, { ...body, dryRun: true });
	const changed = plan.changes.length > 0;
	if (dryRunOnly || !changed) {
		if (values.json) io.out(JSON.stringify(plan));
		else {
			io.out(renderChanges(plan.changes, io.color));
			for (const w of plan.warnings) io.err(`warning: ${w}`);
		}
		return dryRunOnly && changed && values["exit-code"] ? 2 : 0;
	}
	if (!values.json) {
		io.out(renderChanges(plan.changes, io.color));
		for (const w of plan.warnings) io.err(`warning: ${w}`);
	}
	if (!values.yes) {
		if (!io.interactive)
			throw new UsageError(
				"not a terminal: pass --yes to apply without asking",
			);
		const answer = await io.prompt("\nApply these changes? Type yes: ");
		if (answer.trim() !== "yes") {
			io.err("Nothing applied.");
			return 1;
		}
	}
	const out = await api.post<ApplyResult>(path, { ...body, dryRun: false });
	if (values.json) io.out(JSON.stringify(out));
	else {
		io.out(
			`Applied ${out.changes.length} change${out.changes.length === 1 ? "" : "s"}. Changed services show a pending diff; deploy them to roll out.`,
		);
		for (const k of out.backupKeys)
			io.out(
				`Backup key for ${k.environment}/${k.service} (${k.backup}), shown once: ${k.key}`,
			);
	}
	return 0;
}

async function exportManifest(api: Api, values: Flags, io: Io) {
	const format = values.format === "json" || values.json ? "json" : "yaml";
	const path = values.environment
		? `/environments/${values.environment}/manifest`
		: values.project
			? `/projects/${values.project}/manifest`
			: null;
	if (!path)
		throw new UsageError("export needs --project <id> or --environment <id>");
	const out =
		format === "json"
			? `${JSON.stringify(await api.get(`${path}?format=json`), null, 2)}\n`
			: await api.text(`${path}?format=yaml`);
	if (values.output) {
		await writeFile(values.output, out);
		if (values.json) io.out(JSON.stringify({ written: values.output }));
		else io.err(`Wrote ${values.output}`);
	} else io.out(out.replace(/\n$/, ""));
	return 0;
}

const settled: DeploymentStatus[] = [
	"healthy",
	"failed",
	"cancelled",
	"superseded",
	"skipped",
];

async function deploy(api: Api, values: Flags, io: Io) {
	if (!values.service) throw new UsageError("deploy needs --service <id>");
	let d = await api.post<{ id: string; status: DeploymentStatus }>(
		`/services/${values.service}/deploy`,
	);
	if (!values.json) io.err(`Queued deployment ${d.id}`);
	while (values.wait && !settled.includes(d.status)) {
		await Bun.sleep(2000);
		const next = await api.get<typeof d>(`/deployments/${d.id}`);
		if (next.status !== d.status && !values.json) io.err(`  ${next.status}`);
		d = next;
	}
	if (values.json) io.out(JSON.stringify(d));
	else if (values.wait) io.out(`${d.id} ${d.status}`);
	return values.wait && d.status !== "healthy" ? 1 : 0;
}

type LogMessage =
	| { type: "subscribed"; channel: string }
	| {
			type: "line";
			line: string;
			taskId?: string;
			stream?: string;
			at?: string;
	  }
	| { type: "end"; reason: string }
	| { type: "error"; message: string };

async function logs(api: Api, values: Flags, io: Io) {
	if (!values.service) throw new UsageError("logs needs --service <id>");
	const tail = Number(values.tail);
	if (!Number.isInteger(tail) || tail < 0)
		throw new UsageError("--tail takes a whole number");
	const ws = api.socket("/ws");
	return new Promise<number>((resolve) => {
		// Without --follow, stop once the backlog has stopped arriving.
		let idle: Timer | undefined;
		const settle = () => {
			if (values.follow) return;
			clearTimeout(idle);
			idle = setTimeout(() => {
				ws.close();
				resolve(0);
			}, 1500);
		};
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					type: "subscribe",
					channel: `service-logs:${values.service}`,
					options: { tail },
				}),
			);
			settle();
		};
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data)) as LogMessage;
			if (m.type === "line") {
				io.out(values.json ? JSON.stringify(m) : m.line);
				settle();
			} else if (m.type === "error") {
				io.err(`error: ${m.message}`);
				ws.close();
				resolve(1);
			}
		};
		ws.onerror = () => {
			io.err("error: the log stream failed");
			resolve(1);
		};
		ws.onclose = () => resolve(0);
	});
}

async function exec(api: Api, values: Flags, io: Io) {
	if (!values.service) throw new UsageError("exec needs --service <id>");
	if (values.shell !== "sh" && values.shell !== "bash")
		throw new UsageError("--shell takes sh or bash");
	const out = io.stdout ?? process.stdout;
	const input = io.stdin ?? process.stdin;
	const tty = io.interactive && !values.json && input.isTTY;
	const ticket = await api.post<{ ticket: string; taskId: string }>(
		`/services/${values.service}/exec`,
		{
			shell: values.shell,
			rows: (tty && out.rows) || 24,
			cols: (tty && out.columns) || 80,
		},
	);
	const ws = api.socket(`/ws/exec?ticket=${encodeURIComponent(ticket.ticket)}`);
	ws.binaryType = "arraybuffer";
	const collected: Uint8Array[] = [];
	return new Promise<number>((resolve) => {
		let code: number | null = null;
		const finish = () => {
			if (tty) input.setRawMode(false);
			input.pause();
			if (values.json)
				io.out(
					JSON.stringify({
						taskId: ticket.taskId,
						exitCode: code,
						output: Buffer.concat(collected).toString("utf8"),
					}),
				);
			resolve(code ?? 1);
		};
		ws.onopen = () => {
			if (tty) {
				input.setRawMode(true);
				out.on("resize", () =>
					ws.send(
						JSON.stringify({
							type: "resize",
							rows: out.rows,
							cols: out.columns,
						}),
					),
				);
			}
			input.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
			// Piped input: the shell exits when it ends.
			input.on("end", () => ws.send(new TextEncoder().encode("\nexit\n")));
			input.resume();
		};
		ws.onmessage = (e) => {
			if (typeof e.data !== "string") {
				const bytes = new Uint8Array(e.data as ArrayBuffer);
				if (values.json) collected.push(bytes);
				else out.write(bytes);
				return;
			}
			const m = JSON.parse(e.data) as
				| { type: "ready" }
				| { type: "exit"; code: number | null }
				| { type: "error"; message: string };
			if (m.type === "exit") code = m.code;
			if (m.type === "error") io.err(`\nerror: ${m.message}`);
		};
		ws.onclose = finish;
		ws.onerror = () => io.err("\nerror: the terminal connection failed");
	});
}

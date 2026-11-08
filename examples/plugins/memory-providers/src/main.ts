import {
	createPlugin,
	type DnsProviderImpl,
	type DnsRecord,
	defineManifest,
	type EventEnvelope,
	type RenderedNotification,
} from "@logistack/plugin-sdk";

// Reference plugin for providers (docs/plans/plugins.md, phase 2): a DNS provider, a notification
// channel and a secret provider that keep everything in memory. It shows the shape of each kind
// and backs the end-to-end tests; a real one calls its service's API in the same methods.

export const manifest = defineManifest({
	id: "dev.logistack.memory-providers",
	version: "0.1.0",
	name: "Memory providers",
	description: "In-memory DNS, notification and secret providers, for tests.",
	author: { name: "LogiStack", url: "https://stack.logicaltech.it" },
	license: "MIT",
	port: 8080,
	resources: { memory: "64Mi", cpu: 0.1 },
	contributes: {
		dnsProviders: [
			{
				name: "memory",
				title: "Memory DNS",
				configSchema: {
					type: "object",
					properties: {
						zone: { type: "string", title: "Zone", minLength: 1 },
						token: { type: "string", title: "Token", secret: true },
					},
					required: ["zone", "token"],
				},
			},
		],
		notificationChannels: [
			{
				name: "log",
				title: "Memory log",
				configSchema: {
					type: "object",
					properties: { prefix: { type: "string", title: "Prefix" } },
				},
			},
		],
		secretProviders: [
			{
				name: "memory",
				title: "Memory secrets",
				configSchema: {
					type: "object",
					properties: { token: { type: "string", secret: true } },
					required: ["token"],
				},
			},
		],
	},
});

/** Everything the providers hold, exported so tests can look. */
export const state = {
	/** Zone name → records. */
	records: new Map<string, DnsRecord[]>(),
	sent: [] as {
		prefix?: string;
		event: EventEnvelope;
		rendered: RenderedNotification;
	}[],
	/** `path/…#key` → value. */
	secrets: new Map<string, string>(),
};

/** The token "wrong" stands for credentials the service refuses. */
function signIn(config: Record<string, unknown>) {
	if (config.token === "wrong") throw new Error("the token was refused");
}

let nextId = 1;

function memoryDns(config: Record<string, unknown>): DnsProviderImpl {
	signIn(config);
	const zone = String(config.zone);
	const all = () => {
		const list = state.records.get(zone) ?? [];
		state.records.set(zone, list);
		return list;
	};
	const remove = (id: string) => {
		const list = all();
		state.records.set(
			zone,
			list.filter((r) => r.id !== id),
		);
	};
	return {
		async verify() {},
		async listZones() {
			return [{ id: zone, name: zone }];
		},
		async listRecords(_zoneId, name) {
			return all().filter((r) => name === undefined || r.name === name);
		},
		async upsertRecord(input) {
			for (const r of all())
				if (r.name === input.name && r.type === input.type) remove(r.id);
			const rec = { ...input, id: `r${nextId++}` };
			all().push(rec);
			return rec;
		},
		async createRecord(input) {
			const id = `r${nextId++}`;
			const recs = input.values.map((content) => ({
				id,
				zoneId: input.zoneId,
				name: input.name,
				type: input.type,
				ttl: input.ttl,
				content,
			}));
			all().push(...recs);
			return recs;
		},
		async updateRecord(recordId, input) {
			remove(recordId);
			return this.createRecord(input);
		},
		async deleteRecord(_zoneId, recordId) {
			remove(recordId);
		},
	};
}

export const app = createPlugin({
	manifest,
	providers: {
		dnsProviders: { memory: memoryDns },
		notificationChannels: {
			log: (config) => ({
				async test() {},
				async send(event, rendered) {
					state.sent.push({
						prefix: config.prefix as string | undefined,
						event,
						rendered,
					});
				},
			}),
		},
		secretProviders: {
			memory: (config) => {
				signIn(config);
				return {
					async test() {},
					async read(path, key) {
						const value = state.secrets.get(`${path.join("/")}#${key}`);
						if (value === undefined)
							throw new Error(`no ${key} at ${path.join("/")}`);
						return value;
					},
				};
			},
		},
	},
});

if (import.meta.main) {
	Bun.serve({
		port: Number(process.env.PORT ?? manifest.port),
		fetch: app.fetch,
	});
	console.log(
		`${manifest.id} listening on ${process.env.PORT ?? manifest.port}`,
	);
}

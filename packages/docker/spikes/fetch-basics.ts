// Spike: Bun fetch over the Docker unix socket for JSON calls and streaming /events.
const unix = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

const ping = await fetch("http://docker/_ping", { unix });
console.log(
	"ping",
	ping.status,
	await ping.text(),
	"api",
	ping.headers.get("api-version"),
);

const v = (await (
	await fetch("http://docker/version", { unix })
).json()) as Record<string, string>;
console.log("version", v.Version, "api", v.ApiVersion, "min", v.MinAPIVersion);

const until = Math.floor(Date.now() / 1000);
const ev = await fetch(
	`http://docker/events?since=${until - 3600}&until=${until}`,
	{ unix },
);
let bytes = 0;
let lines = 0;
for await (const chunk of ev.body as ReadableStream<Uint8Array>) {
	bytes += chunk.length;
	lines += chunk.filter((b) => b === 10).length;
}
console.log(
	"events(last hour, bounded)",
	ev.status,
	ev.headers.get("content-type"),
	{ bytes, lines },
);

const ac = new AbortController();
const t0 = performance.now();
const live = await fetch("http://docker/events", { unix, signal: ac.signal });
setTimeout(() => ac.abort(), 300);
try {
	for await (const _ of live.body as ReadableStream<Uint8Array>) {
	}
} catch (e) {
	console.log(
		"live events aborted after",
		Math.round(performance.now() - t0),
		"ms:",
		(e as Error).name,
	);
}

export {};

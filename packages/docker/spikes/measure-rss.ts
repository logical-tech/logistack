// Spawns a binary and samples its RSS from outside via `ps`, so the number includes everything the OS charges.
// Usage: bun packages/docker/spikes/measure-rss.ts <binary> [minutes=5] [sampleSeconds=30]
const [bin, minutes = "5", every = "30"] = process.argv.slice(2);
if (!bin)
	throw new Error("usage: measure-rss.ts <binary> [minutes] [sampleSeconds]");

const child = Bun.spawn([bin], { stdout: "pipe", stderr: "inherit" });
let lastLine = "";
(async () => {
	const dec = new TextDecoder();
	for await (const chunk of child.stdout)
		lastLine = dec.decode(chunk).trim().split("\n").at(-1) ?? lastLine;
})();

const rssKB = async () => {
	const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(child.pid)], {
		stdout: "pipe",
	});
	return Number((await new Response(ps.stdout).text()).trim());
};

const samples: number[] = [];
const end = Date.now() + Number(minutes) * 60_000;
const t0 = Date.now();
await Bun.sleep(2000);
while (Date.now() < end) {
	const kb = await rssKB();
	if (!kb)
		throw new Error(
			`process exited early (code ${await child.exited}); on macOS re-sign with codesign --force --sign -`,
		);
	samples.push(kb);
	console.log(
		`t=${Math.round((Date.now() - t0) / 1000)}s rss=${(kb / 1024).toFixed(1)}MB agent=${lastLine}`,
	);
	await Bun.sleep(Number(every) * 1000);
}
child.kill();
const mb = samples.map((k) => k / 1024);
console.log(
	JSON.stringify({
		samples: mb.length,
		minMB: +Math.min(...mb).toFixed(1),
		maxMB: +Math.max(...mb).toFixed(1),
		lastMB: +(mb.at(-1) ?? 0).toFixed(1),
	}),
);

export {};

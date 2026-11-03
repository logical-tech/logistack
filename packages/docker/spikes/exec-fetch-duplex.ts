// Spike: is fetch with a streamed body truly duplex for exec? Send input only after reading output.
const unix = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const name = `ls-test-execd-${Date.now().toString(36)}`;
const post = (body: unknown) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
	unix,
});
const c = (await (
	await fetch(
		`http://docker/containers/create?name=${name}`,
		post({
			Image: "debian:stable-slim",
			Cmd: ["sleep", "300"],
			Labels: { "logistack.test": "true" },
		}),
	)
).json()) as { Id: string };
try {
	await fetch(`http://docker/containers/${c.Id}/start`, {
		method: "POST",
		unix,
	});
	const ex = (await (
		await fetch(
			`http://docker/containers/${c.Id}/exec`,
			post({ AttachStdin: true, AttachStdout: true, Tty: true, Cmd: ["sh"] }),
		)
	).json()) as { Id: string };
	const enc = new TextEncoder();
	let ctl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(k) {
			ctl = k;
		},
	});
	const t0 = performance.now();
	const respP = fetch(`http://docker/exec/${ex.Id}/start`, {
		method: "POST",
		unix,
		headers: {
			"content-type": "application/json",
			connection: "Upgrade",
			upgrade: "tcp",
		},
		body,
		signal: AbortSignal.timeout(5000),
	});
	ctl.enqueue(enc.encode(JSON.stringify({ Tty: true })));
	const race = await Promise.race([
		respP.then(() => "response"),
		Bun.sleep(1500).then(() => "timeout"),
	]);
	console.log(
		"response headers before body end?",
		race,
		Math.round(performance.now() - t0),
		"ms",
	);
	if (race === "response") {
		const r = await respP;
		console.log(
			"status",
			r.status,
			r.headers.get("content-type"),
			r.headers.get("transfer-encoding"),
		);
		const reader = (r.body as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		let out = "";
		const readUntil = async (needle: string) => {
			while (!out.includes(needle)) {
				const { value, done } = await reader.read();
				if (done) return false;
				out += dec.decode(value);
			}
			return true;
		};
		ctl.enqueue(enc.encode("echo interactive-$((40+2))\n"));
		console.log(
			"got echo before exit?",
			await readUntil("interactive-42"),
			JSON.stringify(out),
		);
		ctl.enqueue(enc.encode("exit\n"));
		ctl.close();
		await readUntil("\u0000never");
		console.log("final", JSON.stringify(out));
	}
	if (race === "timeout") {
		ctl.close();
		const r = await respP;
		console.log(
			"after close",
			r.status,
			JSON.stringify((await r.text()).slice(0, 120)),
		);
	}
} catch (e) {
	console.log("failed", (e as Error).name, (e as Error).message);
} finally {
	await fetch(`http://docker/containers/${c.Id}?force=true`, {
		method: "DELETE",
		unix,
	});
	console.log("removed", name);
}

export {};

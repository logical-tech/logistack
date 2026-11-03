// Spike: exec with hijacked stdin/stdout. Tries fetch (streamed body) and Bun.connect raw upgrade.
const unix = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const name = `ls-test-exec-${Date.now().toString(36)}`;
const json = (body: unknown) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
	unix,
});

async function api<T>(
	path: string,
	init?: RequestInit & { unix?: string },
): Promise<T> {
	const r = await fetch(`http://docker${path}`, { unix, ...init });
	const text = await r.text();
	if (!r.ok) throw new Error(`${r.status} ${path}: ${text}`);
	return (text ? JSON.parse(text) : undefined) as T;
}

const created = await api<{ Id: string }>(
	`/containers/create?name=${name}`,
	json({
		Image: "debian:stable-slim",
		Cmd: ["sleep", "300"],
		Labels: { "logistack.test": "true" },
	}),
);
const id = created.Id;
try {
	await api(`/containers/${id}/start`, { method: "POST" });

	// A. fetch with a streamed request body
	{
		const ex = await api<{ Id: string }>(
			`/containers/${id}/exec`,
			json({
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: true,
				Cmd: ["sh"],
			}),
		);
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(enc.encode("echo hi-from-fetch\n"));
				await Bun.sleep(300);
				c.enqueue(enc.encode("exit\n"));
				c.close();
			},
		});
		try {
			const r = await fetch(`http://docker/exec/${ex.Id}/start`, {
				method: "POST",
				unix,
				headers: {
					"content-type": "application/json",
					connection: "Upgrade",
					upgrade: "tcp",
				},
				body,
				signal: AbortSignal.timeout(3000),
			});
			console.log("A fetch status", r.status, r.headers.get("content-type"));
			const out = await r.text();
			console.log("A fetch output", JSON.stringify(out.slice(0, 200)));
		} catch (e) {
			console.log("A fetch failed:", (e as Error).name, (e as Error).message);
		}
	}

	// B. Bun.connect raw HTTP/1.1 upgrade
	{
		const ex = await api<{ Id: string }>(
			`/containers/${id}/exec`,
			json({
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: true,
				Cmd: ["sh"],
			}),
		);
		const payload = JSON.stringify({ Detach: false, Tty: true });
		let head = "";
		let headerDone = false;
		let out = "";
		const dec = new TextDecoder();
		const closed = Promise.withResolvers<void>();
		const sock = await Bun.connect({
			unix,
			socket: {
				data(_s, chunk) {
					if (headerDone) {
						out += dec.decode(chunk);
						return;
					}
					head += dec.decode(chunk);
					const i = head.indexOf("\r\n\r\n");
					if (i >= 0) {
						headerDone = true;
						out += head.slice(i + 4);
						head = head.slice(0, i);
					}
				},
				close() {
					closed.resolve();
				},
				error(_s, e) {
					closed.reject(e);
				},
			},
		});
		sock.write(
			`POST /exec/${ex.Id}/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
		);
		await Bun.sleep(150);
		const resize = await fetch(
			`http://docker/exec/${ex.Id}/resize?h=40&w=123`,
			{ method: "POST", unix },
		);
		console.log("B resize status", resize.status);
		sock.write("stty size; echo hi-from-socket\n");
		await Bun.sleep(300);
		sock.write("exit\n");
		await closed.promise;
		const inspect = await api<{ ExitCode: number; Running: boolean }>(
			`/exec/${ex.Id}/json`,
		);
		console.log("B status line", head.split("\r\n")[0]);
		console.log("B output", JSON.stringify(out));
		console.log("B exit", inspect.ExitCode, "running", inspect.Running);
	}
} finally {
	await api(`/containers/${id}?force=true`, { method: "DELETE" });
	console.log("removed", name);
}

export {};

// A deliberately slow S3 stand-in, run as its own process so its pace is not the test's event
// loop. Multipart uploads are read at about 8 MiB/s; GET serves zeros of `?size=` bytes, only as
// fast as the client reads. GET /_stats reports bytes received and bytes handed to the socket.

let received = 0;
let served = 0;
const CHUNK = 64 * 1024;

const xml = (body: string) =>
	new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
		headers: { "content-type": "application/xml" },
	});

const server = Bun.serve({
	port: 0,
	idleTimeout: 120,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/_stats") return Response.json({ received, served });
		if (req.method === "POST" && url.searchParams.has("uploads"))
			return xml(
				"<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>",
			);
		if (req.method === "POST")
			return xml(
				'<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>',
			);
		if (req.method === "PUT") {
			for await (const chunk of req.body ?? []) {
				received += chunk.byteLength;
				await Bun.sleep(8);
			}
			return new Response(null, { headers: { etag: '"part"' } });
		}
		if (req.method === "GET") {
			const size = Number(url.searchParams.get("size") ?? 256 * 1024 * 1024);
			let sent = 0;
			return new Response(
				new ReadableStream({
					pull(c) {
						if (sent >= size) return c.close();
						sent += CHUNK;
						served += CHUNK;
						c.enqueue(new Uint8Array(CHUNK));
					},
				}),
				{ headers: { "content-length": String(size) } },
			);
		}
		return new Response(null, { status: 204 });
	},
});
console.log(server.port);

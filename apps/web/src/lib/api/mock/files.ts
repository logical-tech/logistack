/* In-memory files for VITE_API_MOCK=1: services created with mounts get them here. */
import type { FilesApi, ServiceFiles, VolumeFile } from "../files";

type Entry = { files: ServiceFiles; volumes: Map<string, VolumeFile[]> };
const store = new Map<string, Entry>();
let seq = 0;
const delay = <T>(v: T, ms = 300) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

/** Called by the mock service create. */
export function registerMockMounts(
	serviceId: string,
	mounts: (
		| { kind: "config"; target: string; content: string }
		| { kind: "volume"; target: string; name: string }
	)[],
) {
	const now = new Date().toISOString();
	const entry: Entry = {
		files: { files: [], volumes: [] },
		volumes: new Map(),
	};
	for (const m of mounts) {
		seq += 1;
		const id = `mnt_mock${seq}`;
		if (m.kind === "config")
			entry.files.files.push({
				id,
				target: m.target,
				content: m.content,
				updatedAt: now,
			});
		else {
			entry.files.volumes.push({ id, target: m.target, name: m.name });
			entry.volumes.set(id, [
				{ path: "50x.html", size: 497, modifiedAt: now },
				{ path: "index.html", size: 615, modifiedAt: now },
			]);
		}
	}
	store.set(serviceId, entry);
}

const entry = (id: string) => {
	const e = store.get(id);
	if (!e) throw new Error("This service has no files.");
	return e;
};

type Node =
	| { type: "dir" }
	| { type: "file"; content: string; binary?: boolean; size?: number }
	| { type: "symlink"; target: string };

/** One fake root filesystem, shared by every mock service's replicas. */
const rootfs = new Map<string, Node>([
	["/", { type: "dir" }],
	["/app", { type: "dir" }],
	[
		"/app/server.js",
		{
			type: "file",
			content:
				'import http from "node:http";\n\nhttp\n\t.createServer((_, res) => res.end("ok"))\n\t.listen(process.env.PORT ?? 3000);\n',
		},
	],
	[
		"/app/package.json",
		{
			type: "file",
			content:
				'{\n  "name": "shop",\n  "type": "module",\n  "scripts": { "start": "node server.js" }\n}\n',
		},
	],
	["/app/node_modules", { type: "dir" }],
	["/etc", { type: "dir" }],
	["/etc/hostname", { type: "file", content: "a81f3c2e9d40\n" }],
	[
		"/etc/os-release",
		{
			type: "file",
			content:
				'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n',
		},
	],
	["/etc/mtab", { type: "symlink", target: "/proc/mounts" }],
	["/usr", { type: "dir" }],
	["/usr/bin", { type: "dir" }],
	[
		"/usr/bin/node",
		{ type: "file", content: "", binary: true, size: 98_304_112 },
	],
	["/bin", { type: "symlink", target: "/usr/bin" }],
	["/tmp", { type: "dir" }],
	["/var", { type: "dir" }],
	["/var/log", { type: "dir" }],
	["/var/log/app.log", { type: "file", content: "listening on :3000\n" }],
]);
const MOCK_MTIME = Math.floor(Date.now() / 1000) - 3600;

function resolve(path: string): string {
	for (let i = 0; i < 8; i++) {
		const n = rootfs.get(path);
		if (n?.type !== "symlink") return path;
		path = n.target;
	}
	return path;
}

const sizeOf = (n: Node) =>
	n.type === "file"
		? (n.size ?? new TextEncoder().encode(n.content).length)
		: 0;

function entryOf(path: string, n: Node) {
	return {
		name: path === "/" ? "/" : (path.split("/").at(-1) ?? path),
		type: n.type,
		size: sizeOf(n),
		mode: n.type === "dir" ? 0o755 : 0o644,
		modifiedAt: MOCK_MTIME,
		...(n.type === "symlink" ? { linkTarget: n.target } : {}),
	};
}

function stat(path: string) {
	const real = resolve(path);
	const n = rootfs.get(real);
	if (!n) throw new Error(`${path}: no such file or directory`);
	return { real, n };
}

export const mockFiles: FilesApi = {
	container: {
		list: async (_id, taskId, path) => {
			const { real, n } = stat(path);
			const prefix = real === "/" ? "/" : `${real}/`;
			const entries =
				n.type === "dir"
					? [...rootfs]
							.filter(
								([p]) =>
									p !== real &&
									p.startsWith(prefix) &&
									!p.slice(prefix.length).includes("/"),
							)
							.map(([p, c]) => entryOf(p, c))
							.sort(
								(a, b) =>
									Number(b.type === "dir") - Number(a.type === "dir") ||
									a.name.localeCompare(b.name),
							)
					: null;
			return delay({
				taskId: taskId || "task_mock1",
				path: real,
				entry: entryOf(real, n),
				entries,
				truncated: false,
			});
		},
		read: async (_id, taskId, path) => {
			const { real, n } = stat(path);
			if (n.type !== "file") throw new Error(`${real} is not a regular file`);
			return delay({
				taskId: taskId || "task_mock1",
				path: real,
				size: sizeOf(n),
				truncated: false,
				binary: Boolean(n.binary),
				content: n.binary ? null : n.content,
			});
		},
		upload: (_id, _taskId, path, file, onProgress) => {
			let abortRef = () => {};
			const done = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					onProgress(file.size);
					void file.text().then((content) => {
						rootfs.set(path, { type: "file", content, size: file.size });
						resolve();
					});
				}, 400);
				abortRef = () => {
					clearTimeout(timer);
					reject(new DOMException("Cancelled", "AbortError"));
				};
			});
			return { done, abort: () => abortRef() };
		},
	},
	get: async (id) => delay(entry(id).files),
	save: async (id, mountId, content) => {
		const f = entry(id).files.files.find((x) => x.id === mountId);
		if (!f) throw new Error("config file not found");
		f.content = content;
		f.updatedAt = new Date().toISOString();
		return delay({ deployment: { id: `dep_mock${++seq}` } }, 500);
	},
	list: async (id, mountId) =>
		delay({ files: entry(id).volumes.get(mountId) ?? [], truncated: false }),
	remove: async (id, mountId, path) => {
		const v = entry(id).volumes;
		v.set(
			mountId,
			(v.get(mountId) ?? []).filter(
				(f) => f.path !== path && !f.path.startsWith(`${path}/`),
			),
		);
		await delay(null);
	},
	upload: (id, mountId, key, file, onProgress) => {
		let loaded = 0;
		let timer: ReturnType<typeof setInterval> | undefined;
		let abortRef = () => {};
		const done = new Promise<void>((resolve, reject) => {
			timer = setInterval(() => {
				loaded = Math.min(file.size, loaded + Math.max(file.size / 6, 1));
				onProgress(loaded);
				if (loaded < file.size) return;
				clearInterval(timer);
				const v = entry(id).volumes;
				const rest = (v.get(mountId) ?? []).filter((f) => f.path !== key);
				v.set(
					mountId,
					[
						...rest,
						{
							path: key,
							size: file.size,
							modifiedAt: new Date().toISOString(),
						},
					].sort((a, b) => a.path.localeCompare(b.path)),
				);
				resolve();
			}, 120);
			abortRef = () => {
				clearInterval(timer);
				reject(new DOMException("Cancelled", "AbortError"));
			};
		});
		return { done, abort: () => abortRef() };
	},
};

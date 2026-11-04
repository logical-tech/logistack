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

export const mockFiles: FilesApi = {
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

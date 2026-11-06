import { posix } from "node:path";
import {
	type ArchiveRequest,
	type ArchiveResult,
	type FileEntry,
	MAX_DIR_ENTRIES,
} from "@logistack/contracts";
import { type DockerClient, type PathStat, readTar } from "@logistack/docker";

/** A request the agent turns down; the server sees `bad_request`. */
export class ArchiveRefused extends Error {}

// Go fs.FileMode, as the engine reports it in the path stat: type bits sit beside setuid, setgid
// and sticky (bits 20-23), so each type is tested on its own. Bit 31 needs `>>> 0`: JS bitwise
// results are signed.
const MODE_DIR = 2 ** 31;
const MODE_SYMLINK = 2 ** 27;
/** Device, named pipe, socket, char device, irregular. */
const MODE_OTHER = (1 << 26) | (1 << 25) | (1 << 24) | (1 << 21) | (1 << 19);
const MAX_SYMLINKS = 8;
/** The engine has no depth limit, so a listing walks the whole subtree; this caps that walk. */
export const LIST_BUDGET_MS = 15_000;

const typeOf = (mode: number): FileEntry["type"] =>
	(mode & MODE_DIR) >>> 0
		? "dir"
		: mode & MODE_SYMLINK
			? "symlink"
			: mode & MODE_OTHER
				? "other"
				: "file";

function entryOf(s: PathStat): FileEntry {
	const type = typeOf(s.mode);
	return {
		name: s.name,
		type,
		size: type === "file" ? s.size : 0,
		mode: s.mode & 0o7777,
		modifiedAt: Math.floor(Date.parse(s.mtime) / 1000),
		...(s.linkTarget ? { linkTarget: s.linkTarget.slice(0, 256) } : {}),
	};
}

/** Follows symlinks at `path` itself; the engine resolves the parent components. */
async function resolve(docker: DockerClient, id: string, path: string) {
	for (let i = 0; i <= MAX_SYMLINKS; i++) {
		const stat = await docker.containers.statPath(id, path);
		if (typeOf(stat.mode) !== "symlink") return { path, stat };
		path = posix.resolve(posix.dirname(path), stat.linkTarget);
	}
	throw new ArchiveRefused(`too many levels of symbolic links at ${path}`);
}

const byDirThenName = (a: FileEntry, b: FileEntry) =>
	Number(b.type === "dir") - Number(a.type === "dir") ||
	a.name.localeCompare(b.name);

/** Direct children of the directory `path`, from a tar of `path/.` whose names read `./child`. */
async function list(
	docker: DockerClient,
	id: string,
	path: string,
	signal: AbortSignal,
) {
	const walk = AbortSignal.any([signal, AbortSignal.timeout(LIST_BUDGET_MS)]);
	const entries: FileEntry[] = [];
	// Hard links carry no size; they point back at an earlier entry by name.
	const sizes = new Map<string, number>();
	let truncated = false;
	try {
		const tar = await docker.containers.archiveStream(
			id,
			path === "/" ? "/." : `${path}/.`,
			walk,
		);
		for await (const e of readTar(tar)) {
			if (!("header" in e)) continue;
			const h = e.header;
			if (h.type === "file") sizes.set(h.name, h.size);
			const name = h.name.replace(/^\.\//, "").replace(/\/$/, "");
			if (!name || name.includes("/") || name === ".") continue;
			if (entries.length === MAX_DIR_ENTRIES) {
				truncated = true;
				break;
			}
			const type = h.type === "hardlink" ? "file" : h.type;
			entries.push({
				name,
				type,
				size:
					h.type === "hardlink"
						? (sizes.get(h.linkname) ?? 0)
						: type === "file"
							? h.size
							: 0,
				mode: h.mode,
				modifiedAt: h.mtime,
				...(h.type === "symlink"
					? { linkTarget: h.linkname.slice(0, 256) }
					: {}),
			});
		}
	} catch (e) {
		if (signal.aborted || !walk.aborted) throw e;
		truncated = true;
	}
	return { entries: entries.sort(byDirThenName), truncated };
}

/** The first regular file in a tar of `path`, in chunks, up to `limit` bytes. */
async function read(
	docker: DockerClient,
	id: string,
	path: string,
	limit: number,
	onData: (chunk: Uint8Array) => Promise<void>,
	signal: AbortSignal,
) {
	const stop = new AbortController();
	const tar = await docker.containers.archiveStream(
		id,
		path,
		AbortSignal.any([signal, stop.signal]),
	);
	let sent = 0;
	let started = false;
	try {
		for await (const e of readTar(tar)) {
			if ("header" in e) {
				if (started) break;
				started = e.header.type === "file";
				continue;
			}
			if (!started) continue;
			const part = e.data.subarray(0, limit - sent);
			if (part.length) await onData(part);
			sent += part.length;
			if (sent >= limit) break;
		}
	} finally {
		stop.abort();
	}
}

export async function runArchive(
	docker: DockerClient,
	id: string,
	req: ArchiveRequest,
	io: {
		signal: AbortSignal;
		onData(chunk: Uint8Array): Promise<void>;
		/** The tar a write extracts, once the server sent all of it. */
		upload(): Promise<Uint8Array>;
	},
): Promise<ArchiveResult> {
	const { path, stat } = await resolve(docker, id, req.path);
	const entry = entryOf(stat);
	if (req.op === "stat") {
		if (entry.type !== "dir")
			return { path, entry, entries: null, truncated: false };
		return { path, entry, ...(await list(docker, id, path, io.signal)) };
	}
	if (req.op === "read") {
		if (entry.type !== "file")
			throw new ArchiveRefused(`${path} is not a regular file`);
		await read(docker, id, path, req.limitBytes, io.onData, io.signal);
		return {
			path,
			entry,
			entries: null,
			truncated: entry.size > req.limitBytes,
		};
	}
	if (entry.type !== "dir")
		throw new ArchiveRefused(`${path} is not a directory`);
	await docker.containers.putArchive(id, path, await io.upload());
	return { path, entry, entries: null, truncated: false };
}

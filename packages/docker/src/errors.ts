export class DockerError extends Error {
	override name = "DockerError";

	constructor(
		readonly status: number,
		message: string,
		readonly method: string,
		readonly path: string,
	) {
		super(message);
	}

	get notFound(): boolean {
		return this.status === 404;
	}

	/** Name or state conflict, e.g. creating an object whose name exists, or removing a network in use. */
	get conflict(): boolean {
		return this.status === 409 || this.message.includes(NAME_CONFLICT);
	}
}

/**
 * A versioned swarm object update (service, node, swarm) was sent with a stale `version`.
 * Re-inspect, re-apply the change on the fresh spec, and retry.
 */
export class DockerVersionConflictError extends DockerError {
	override name = "DockerVersionConflictError";
}

// swarmkit's errNameConflict, from two concurrent creates of one name; the engine maps it to a 500, not a 409.
const NAME_CONFLICT = "name conflicts with an existing object";

// swarmkit's errSequenceConflict text; the engine maps it to a 500.
const OUT_OF_SEQUENCE = "update out of sequence";

export function toDockerError(
	status: number,
	body: string,
	method: string,
	path: string,
): DockerError {
	let message = body.trim();
	try {
		const parsed = JSON.parse(body) as { message?: unknown };
		if (typeof parsed.message === "string") message = parsed.message;
	} catch {
		// non-JSON error bodies (proxies, plain text) keep the raw text
	}
	if (!message) message = `HTTP ${status}`;
	const Ctor = message.includes(OUT_OF_SEQUENCE)
		? DockerVersionConflictError
		: DockerError;
	return new Ctor(status, message, method, path);
}

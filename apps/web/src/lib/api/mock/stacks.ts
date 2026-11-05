import { ApiError } from "../adapter";
import type { StacksApi } from "../stacks";
import type { MockDb } from "./fixtures";

function delay<T>(value: T, ms = 200 + Math.random() * 300): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

/** Desired state as compose, roughly as the server writes it; values are not shown in the mock. */
function effective(db: MockDb, stackId: string) {
	const lines = ["services:"];
	for (const s of db.services.filter((x) => x.stackId === stackId)) {
		lines.push(`  ${s.slug}:`);
		const spec = s.spec;
		if (spec.kind === "database")
			lines.push(`    image: ${spec.engine}:${spec.version}`);
		else if (spec.kind === "application" && spec.source.type === "image")
			lines.push(`    image: ${spec.source.image}`);
		if (spec.kind === "application" && spec.ports.length)
			lines.push(
				"    ports:",
				...spec.ports.map((p) => `      - ${p.target}/${p.protocol}`),
			);
		if (s.domains.length)
			lines.push("    x-domains:", ...s.domains.map((d) => `      - ${d}`));
	}
	return `${lines.join("\n")}\n`;
}

export const stacksMock = (db: MockDb): StacksApi => ({
	list: (environmentId) =>
		delay(
			db.stacks
				.filter((s) => s.environmentId === environmentId)
				.map(({ composeYaml: _y, composeHidden: _h, ...s }) => s),
		),
	get: (id) => {
		const stack = db.stacks.find((s) => s.id === id);
		if (!stack) return Promise.reject(new ApiError(404, "stack not found"));
		return delay({
			...stack,
			effectiveCompose: effective(db, id),
			services: db.services.filter((s) => s.stackId === id),
		});
	},
	createFromCompose: () =>
		Promise.reject(
			new ApiError(
				400,
				"the compose file uses features LogiStack cannot run",
				"validation_failed",
				["The mock does not deploy compose files; run the real server."],
			),
		),
	remove: (id) => {
		db.stacks = db.stacks.filter((s) => s.id !== id);
		db.services = db.services.filter((s) => s.stackId !== id);
		return delay(undefined);
	},
});

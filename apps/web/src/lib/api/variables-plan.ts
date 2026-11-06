import type { ServiceVarInput } from "./service-ops";

type Stored = {
	id: string;
	key: string;
	value: string | null;
	isSecret: boolean;
	isBuildTime: boolean;
};

/** The calls that turn the stored set into `next`: deletes, creates, then updates of what changed. */
export function planReplace(current: Stored[], next: ServiceVarInput[]) {
	const keep = new Set(next.map((v) => v.key));
	const byKey = new Map(current.map((c) => [c.key, c]));
	return {
		remove: current.filter((c) => !keep.has(c.key)).map((c) => c.id),
		create: next.filter((v) => !byKey.has(v.key)),
		update: next.flatMap((v) => {
			const have = byKey.get(v.key);
			if (!have) return [];
			const same =
				(v.value === undefined || v.value === have.value) &&
				have.isSecret === v.isSecret &&
				have.isBuildTime === v.isBuildTime;
			return same ? [] : [{ id: have.id, ...v }];
		}),
	};
}

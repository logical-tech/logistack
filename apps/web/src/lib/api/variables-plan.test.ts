import { expect, test } from "bun:test";
import { planReplace } from "./variables-plan";

const stored = (key: string, value: string | null, isSecret = false) => ({
	id: `id_${key}`,
	key,
	value,
	isSecret,
	isBuildTime: false,
});

test("planReplace deletes, creates and updates only what changed", () => {
	const plan = planReplace(
		[
			stored("KEEP", "1"),
			stored("GONE", "x"),
			stored("FLAG", "y"),
			stored("TOKEN", null, true),
		],
		[
			{ key: "KEEP", value: "1", isSecret: false, isBuildTime: false },
			{ key: "FLAG", value: "y", isSecret: true, isBuildTime: false },
			// No value: a secret the user cannot read keeps its stored one.
			{ key: "TOKEN", isSecret: true, isBuildTime: false },
			{ key: "NEW", value: "n", isSecret: false, isBuildTime: true },
		],
	);
	expect(plan.remove).toEqual(["id_GONE"]);
	expect(plan.create.map((v) => v.key)).toEqual(["NEW"]);
	expect(plan.update).toEqual([
		{
			id: "id_FLAG",
			key: "FLAG",
			value: "y",
			isSecret: true,
			isBuildTime: false,
		},
	]);
});

import { expect, test } from "bun:test";
import { migrationItemTransition } from "../src/migration.ts";

const to = (
	from: Parameters<typeof migrationItemTransition>[0],
	type: string,
) => {
	const r = migrationItemTransition(from, { type } as never);
	return r.ok ? r.state : null;
};

test("an item imports, cuts over, and rolls back", () => {
	expect(to("planned", "imported")).toBe("imported");
	expect(to("imported", "cut_over")).toBe("cut_over");
	expect(to("cut_over", "rolled_back")).toBe("rolled_back");
	expect(to("rolled_back", "cut_over")).toBe("cut_over");
});

test("a failed import retries; a skip can be undone until the cutover", () => {
	expect(to("planned", "import_failed")).toBe("failed");
	expect(to("failed", "imported")).toBe("imported");
	expect(to("imported", "skip")).toBe("skipped");
	expect(to("skipped", "unskip")).toBe("planned");
	expect(to("cut_over", "skip")).toBeNull();
});

test("illegal moves name where they came from", () => {
	expect(migrationItemTransition("planned", { type: "cut_over" })).toEqual({
		ok: false,
		error: { code: "illegal_transition", from: "planned", event: "cut_over" },
	});
	expect(to("skipped", "imported")).toBeNull();
	expect(to("cut_over", "imported")).toBeNull();
});

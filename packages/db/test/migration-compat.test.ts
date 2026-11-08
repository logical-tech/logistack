import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * An update migrates before the old api and worker stop, so release N-1 runs on release N's
 * schema for the length of the roll, and again after a rollback. Migrations must only add
 * (CONTRIBUTING.md, "Database migrations"). A statement that breaks old code needs the line
 * `-- logistack:contract <why N-1 no longer uses it>` in its file.
 */
const BREAKING: [RegExp, string][] = [
	[/\bdrop\s+(table|column|type|view|schema)\b/i, "drops what old code reads"],
	[/\brename\b/i, "renames what old code reads"],
	[/\balter\s+column\b[^;]*\b(type|set\s+not\s+null)\b/i, "tightens a column"],
	[/\bdelete\s+from\b|\btruncate\b/i, "deletes rows"],
	[
		/\badd\s+column\b(?![^;]*\bdefault\b)[^;]*\bnot\s+null\b/i,
		"adds a required column old code never fills",
	],
];

/** Written before updates rolled; never edited again. */
const GRANDFATHERED = new Set([
	"0009_node_token_org.sql",
	// Its DELETEs sit in a trigger function body (scope cleanup), not in the migration itself.
	"0040_scope_cleanup.sql",
]);

const dir = join(import.meta.dir, "..", "drizzle");

function breaking(sql: string): string[] {
	if (/^--\s*logistack:contract\s+\S/m.test(sql)) return [];
	return sql
		.split("--> statement-breakpoint")
		.flatMap((s) =>
			BREAKING.filter(([re]) => re.test(s)).map(
				([, why]) => `${why}: ${s.trim().slice(0, 120)}`,
			),
		);
}

describe("migrations stay compatible with the previous release", () => {
	test("the check flags what it should and passes what it should", () => {
		expect(breaking(`ALTER TABLE "a" DROP COLUMN "b";`)).toHaveLength(1);
		expect(breaking(`ALTER TABLE "a" RENAME COLUMN "b" TO "c";`)).toHaveLength(
			1,
		);
		expect(
			breaking(`ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;`),
		).toHaveLength(1);
		expect(
			breaking(`ALTER TABLE "a" ADD COLUMN "b" text NOT NULL;`),
		).toHaveLength(1);
		expect(
			breaking(`ALTER TABLE "a" ADD COLUMN "b" text DEFAULT 'x' NOT NULL;`),
		).toEqual([]);
		expect(breaking(`ALTER TYPE "s" ADD VALUE 'x';`)).toEqual([]);
		expect(
			breaking(
				`-- logistack:contract 0.5 stopped reading b\nALTER TABLE "a" DROP COLUMN "b";`,
			),
		).toEqual([]);
	});

	test("every migration only adds, or says why it may not", async () => {
		const found: Record<string, string[]> = {};
		for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql"))) {
			if (GRANDFATHERED.has(f)) continue;
			const hits = breaking(await Bun.file(join(dir, f)).text());
			if (hits.length) found[f] = hits;
		}
		expect(found).toEqual({});
	});
});

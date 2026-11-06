import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Read at build time so the number on the page is the number in the catalog. */
export function templateCount(): number {
	const dir = join(process.cwd(), "..", "packages", "templates", "catalog");
	const count = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
	if (count === 0) throw new Error(`no templates found in ${dir}`);
	return count;
}

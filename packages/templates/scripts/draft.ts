import type { Template } from "@logistack/contracts";

/** An adapter's output before the converter pins images, picks a category and copies the logo. */
export type Draft = Omit<
	Template,
	"schema" | "category" | "version" | "logo"
> & {
	/** Upstream category and tags, matched against the category table. */
	categoryHint: string[];
	/** Logo path inside the upstream repository. */
	logoFile?: string;
	/** Upstream version label, when the source has one. */
	version?: string;
};

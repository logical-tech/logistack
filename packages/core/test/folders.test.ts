import { expect, test } from "bun:test";
import { checkFolderPlacement } from "../src/folders.ts";

const top = { id: "fldTop", organizationId: "org1", parentId: null };
const sub = { id: "fldSub", organizationId: "org1", parentId: "fldTop" };
const leaf = { organizationId: "org1", hasChildren: false };

test.each([
	["new folder at top level", { folder: leaf, parent: null }, null],
	["new folder under a top-level folder", { folder: leaf, parent: top }, null],
	[
		"new folder under a subfolder (depth 3)",
		{ folder: leaf, parent: sub },
		"parent_is_subfolder",
	],
	[
		"moving a folder with children under another",
		{
			folder: { id: "fldX", organizationId: "org1", hasChildren: true },
			parent: top,
		},
		"folder_has_children",
	],
	[
		"moving a folder with children to top level",
		{
			folder: { id: "fldX", organizationId: "org1", hasChildren: true },
			parent: null,
		},
		null,
	],
	[
		"folder as its own parent",
		{
			folder: { id: "fldTop", organizationId: "org1", hasChildren: false },
			parent: top,
		},
		"self_parent",
	],
	[
		"parent in another organization",
		{ folder: { organizationId: "org2", hasChildren: false }, parent: top },
		"cross_organization",
	],
] as const)("%s", (_name, input, expected) => {
	expect(checkFolderPlacement(input)).toBe(expected);
});

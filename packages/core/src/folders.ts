export type FolderPlacementError =
	| "parent_is_subfolder"
	| "folder_has_children"
	| "self_parent"
	| "cross_organization";

type FolderRef = {
	id: string;
	organizationId: string;
	parentId: string | null;
};

/**
 * Folders nest at most two levels: a folder with a parent cannot itself be a parent.
 * Checks placing `folder` (new or existing) under `parent`; null parent means top level.
 * The `folder_depth` DB trigger enforces the same rule as a backstop.
 */
export function checkFolderPlacement(input: {
	folder: { id?: string; organizationId: string; hasChildren: boolean };
	parent: FolderRef | null;
}): FolderPlacementError | null {
	const { folder, parent } = input;
	if (!parent) return null;
	if (parent.id === folder.id) return "self_parent";
	if (parent.organizationId !== folder.organizationId)
		return "cross_organization";
	if (parent.parentId !== null) return "parent_is_subfolder";
	if (folder.hasChildren) return "folder_has_children";
	return null;
}

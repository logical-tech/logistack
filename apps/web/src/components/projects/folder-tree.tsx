import { Link } from "@tanstack/react-router";
import { Folder, FolderOpen, Layers } from "lucide-react";
import type {
	FolderId,
	Folder as FolderT,
	ProjectSummary,
} from "@/lib/api/types";
import { cn } from "@/lib/utils";

export type FolderNode = FolderT & { children: FolderT[] };

/** Root folders with their subfolders; depth is capped at two by the model. */
export function buildTree(folders: FolderT[]): FolderNode[] {
	const byPos = (a: FolderT, b: FolderT) =>
		a.position - b.position || a.name.localeCompare(b.name);
	return folders
		.filter((f) => f.parentId === null)
		.sort(byPos)
		.map((root) => ({
			...root,
			children: folders.filter((f) => f.parentId === root.id).sort(byPos),
		}));
}

/** Projects inside a folder, including its subfolders. */
export function inFolder(
	projects: ProjectSummary[],
	folders: FolderT[],
	folderId: FolderId | "none" | undefined,
) {
	if (folderId === undefined) return projects;
	if (folderId === "none") return projects.filter((p) => p.folderId === null);
	const ids = new Set([
		folderId,
		...folders.filter((f) => f.parentId === folderId).map((f) => f.id),
	]);
	return projects.filter((p) => p.folderId !== null && ids.has(p.folderId));
}

function Row({
	folder,
	label,
	count,
	active,
	depth,
	icon: Icon,
}: {
	folder: FolderId | "none" | undefined;
	label: string;
	count: number;
	active: boolean;
	depth: 0 | 1;
	icon: typeof Folder;
}) {
	return (
		<Link
			to="/projects"
			search={(s) => ({ ...s, folder })}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors duration-(--duration-quick)",
				depth === 1 && "ml-4",
				active
					? "bg-accent font-medium text-foreground"
					: "text-muted-foreground hover:bg-muted hover:text-foreground",
			)}
		>
			<Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
			<span className="truncate">{label}</span>
			<span className="ml-auto text-xs tabular text-muted-foreground">
				{count}
			</span>
		</Link>
	);
}

export function FolderTree({
	folders,
	projects,
	selected,
}: {
	folders: FolderT[];
	projects: ProjectSummary[];
	selected: FolderId | "none" | undefined;
}) {
	const tree = buildTree(folders);
	const count = (id: FolderId | "none") =>
		inFolder(projects, folders, id).length;
	return (
		<nav aria-label="Folders" className="grid gap-0.5">
			<Row
				folder={undefined}
				label="All projects"
				count={projects.length}
				active={selected === undefined}
				depth={0}
				icon={Layers}
			/>
			{tree.map((root) => (
				<div key={root.id} className="grid gap-0.5">
					<Row
						folder={root.id}
						label={root.name}
						count={count(root.id)}
						active={selected === root.id}
						depth={0}
						icon={selected === root.id ? FolderOpen : Folder}
					/>
					{root.children.map((child) => (
						<Row
							key={child.id}
							folder={child.id}
							label={child.name}
							count={count(child.id)}
							active={selected === child.id}
							depth={1}
							icon={selected === child.id ? FolderOpen : Folder}
						/>
					))}
				</div>
			))}
			{count("none") > 0 && (
				<Row
					folder="none"
					label="No folder"
					count={count("none")}
					active={selected === "none"}
					depth={0}
					icon={Folder}
				/>
			)}
		</nav>
	);
}

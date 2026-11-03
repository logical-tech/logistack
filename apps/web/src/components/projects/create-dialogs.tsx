import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateFolder, useFolders } from "@/lib/api/folders";
import { useCreateProject } from "@/lib/api/projects";
import type { Folder, FolderId } from "@/lib/api/types";
import { issuesByKey } from "@/lib/form";

const ROOT = "__root";

function folderLabel(f: Folder, folders: Folder[]) {
	const parent = folders.find((p) => p.id === f.parentId);
	return parent ? `${parent.name} / ${f.name}` : f.name;
}

function DialogShell({
	open,
	onOpenChange,
	title,
	description,
	onSubmit,
	pending,
	submitLabel,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	onSubmit: (e: FormEvent) => void;
	pending: boolean;
	submitLabel: string;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={onSubmit} noValidate className="grid gap-5">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{children}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={pending}>
							{pending && <Loader2 className="animate-spin" />}
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const folderSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name the folder.")
		.max(60, "Keep it under 60 characters."),
});

export function CreateFolderDialog({
	open,
	onOpenChange,
	defaultParent,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultParent: FolderId | null;
}) {
	const { data: folders = [] } = useFolders();
	const create = useCreateFolder();
	const roots = folders.filter((f) => f.parentId === null);
	const validDefault = roots.some((f) => f.id === defaultParent)
		? defaultParent
		: null;
	const [name, setName] = useState("");
	const [parent, setParent] = useState<string>(validDefault ?? ROOT);
	const [errors, setErrors] = useState<Record<string, string>>({});

	function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = folderSchema.safeParse({ name });
		if (!parsed.success) return setErrors(issuesByKey(parsed.error.issues));
		create.mutate(
			{
				name: parsed.data.name,
				parentId: parent === ROOT ? null : (parent as FolderId),
			},
			{
				onSuccess: (f) => {
					toast.success(`Folder “${f.name}” created`);
					setName("");
					onOpenChange(false);
				},
				onError: (err) => setErrors({ name: err.message }),
			},
		);
	}

	return (
		<DialogShell
			open={open}
			onOpenChange={onOpenChange}
			title="New folder"
			description="Group projects by client or team. Folders nest one level deep."
			onSubmit={submit}
			pending={create.isPending}
			submitLabel="Create folder"
		>
			<Field id="folder-name" label="Name" error={errors.name}>
				<Input
					id="folder-name"
					autoFocus
					placeholder="Acme Retail"
					value={name}
					onChange={(e) => setName(e.target.value)}
					aria-invalid={errors.name ? true : undefined}
					aria-describedby="folder-name-msg"
				/>
			</Field>
			<Field
				id="folder-parent"
				label="Inside"
				hint="Only top-level folders can hold subfolders."
			>
				<Select value={parent} onValueChange={setParent}>
					<SelectTrigger id="folder-parent" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ROOT}>Top level</SelectItem>
						{roots.map((f) => (
							<SelectItem key={f.id} value={f.id}>
								{f.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
		</DialogShell>
	);
}

const projectSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name the project.")
		.max(60, "Keep it under 60 characters."),
	description: z.string().trim().max(160, "Keep it under 160 characters."),
});

export function CreateProjectDialog({
	open,
	onOpenChange,
	defaultFolder,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultFolder: FolderId | null;
}) {
	const navigate = useNavigate();
	const { data: folders = [] } = useFolders();
	const create = useCreateProject();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [folder, setFolder] = useState<string>(defaultFolder ?? ROOT);
	const [errors, setErrors] = useState<Record<string, string>>({});

	function submit(e: FormEvent) {
		e.preventDefault();
		const parsed = projectSchema.safeParse({ name, description });
		if (!parsed.success) return setErrors(issuesByKey(parsed.error.issues));
		create.mutate(
			{
				...parsed.data,
				folderId: folder === ROOT ? null : (folder as FolderId),
			},
			{
				onSuccess: (p) => {
					toast.success(`Project “${p.name}” created`, {
						description: "It starts with a Production environment.",
					});
					onOpenChange(false);
					navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
				},
				onError: (err) => setErrors({ name: err.message }),
			},
		);
	}

	const ordered = [...folders].sort((a, b) =>
		folderLabel(a, folders).localeCompare(folderLabel(b, folders)),
	);

	return (
		<DialogShell
			open={open}
			onOpenChange={onOpenChange}
			title="New project"
			description="A project holds environments, and each environment holds services."
			onSubmit={submit}
			pending={create.isPending}
			submitLabel="Create project"
		>
			<Field id="project-name" label="Name" error={errors.name}>
				<Input
					id="project-name"
					autoFocus
					placeholder="Storefront"
					value={name}
					onChange={(e) => setName(e.target.value)}
					aria-invalid={errors.name ? true : undefined}
					aria-describedby="project-name-msg"
				/>
			</Field>
			<Field
				id="project-description"
				label="Description"
				optional
				error={errors.description}
			>
				<Textarea
					id="project-description"
					rows={2}
					placeholder="What it is and who it's for"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					aria-invalid={errors.description ? true : undefined}
					aria-describedby="project-description-msg"
				/>
			</Field>
			<Field id="project-folder" label="Folder">
				<Select value={folder} onValueChange={setFolder}>
					<SelectTrigger id="project-folder" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ROOT}>No folder</SelectItem>
						{ordered.map((f) => (
							<SelectItem key={f.id} value={f.id}>
								{folderLabel(f, folders)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
		</DialogShell>
	);
}

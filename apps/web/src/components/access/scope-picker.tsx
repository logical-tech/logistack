import { useMemo } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useRoles } from "@/lib/api/access";
import type { Role, Scope, ScopeKind } from "@/lib/api/access-types";
import { useFolders } from "@/lib/api/folders";
import { useProjects } from "@/lib/api/projects";

export const SCOPE_KINDS: { kind: ScopeKind; label: string }[] = [
	{ kind: "organization", label: "Whole organization" },
	{ kind: "folder", label: "Folder" },
	{ kind: "project", label: "Project" },
	{ kind: "environment", label: "Environment" },
	{ kind: "service", label: "Service" },
];

export type ScopeOption = { id: string; label: string };

/** Every folder, project, environment and service the actor can see, labelled with its ancestry. */
export function useScopeOptions(): Record<ScopeKind, ScopeOption[]> & {
	labelOf: (s: Scope) => string;
} {
	const { data: folders = [] } = useFolders();
	const { data: projects = [] } = useProjects();
	return useMemo(() => {
		const folderName = (id: string | null) => {
			const f = folders.find((x) => x.id === id);
			if (!f) return null;
			const parent = folders.find((x) => x.id === f.parentId);
			return parent ? `${parent.name} / ${f.name}` : f.name;
		};
		const options: Record<ScopeKind, ScopeOption[]> = {
			organization: [{ id: "", label: "Organization" }],
			folder: folders
				.map((f) => ({ id: f.id, label: folderName(f.id) ?? f.name }))
				.sort((a, b) => a.label.localeCompare(b.label)),
			project: projects.map((p) => ({
				id: p.id,
				label: folderName(p.folderId)
					? `${folderName(p.folderId)} / ${p.name}`
					: p.name,
			})),
			environment: projects.flatMap((p) =>
				p.environments.map((e) => ({
					id: e.id,
					label: `${p.name} · ${e.name}`,
				})),
			),
			service: projects.flatMap((p) =>
				p.services.map((s) => ({ id: s.id, label: `${p.name} · ${s.name}` })),
			),
		};
		const labelOf = (s: Scope) =>
			s.kind === "organization"
				? "Whole organization"
				: (options[s.kind].find((o) => o.id === s.id)?.label ?? s.id);
		return { ...options, labelOf };
	}, [folders, projects]);
}

/** Kind, then the folder / project / environment / service it names. `organizationId` fills the organization scope. */
export function ScopePicker({
	id,
	value,
	onChange,
	organizationId,
	invalid,
}: {
	id: string;
	value: Scope | null;
	onChange: (scope: Scope | null) => void;
	organizationId: string;
	invalid?: boolean;
}) {
	const options = useScopeOptions();
	const kind = value?.kind ?? "folder";
	const targets = options[kind];
	return (
		<div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
			<Select
				value={kind}
				onValueChange={(k) =>
					onChange(
						k === "organization"
							? { kind: "organization", id: organizationId }
							: { kind: k as ScopeKind, id: "" },
					)
				}
			>
				<SelectTrigger id={id} aria-label="Scope type" className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{SCOPE_KINDS.map((k) => (
						<SelectItem key={k.kind} value={k.kind}>
							{k.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{kind !== "organization" && (
				<Select
					value={value?.id || undefined}
					onValueChange={(target) => onChange({ kind, id: target })}
				>
					<SelectTrigger
						aria-label={`Which ${kind}`}
						aria-invalid={invalid || undefined}
						className="w-full min-w-0"
					>
						<SelectValue placeholder={`Choose a ${kind}`} />
					</SelectTrigger>
					<SelectContent>
						{targets.length === 0 ? (
							<div className="px-2 py-1.5 text-sm text-muted-foreground">
								No {kind}s yet
							</div>
						) : (
							targets.map((t) => (
								<SelectItem key={t.id} value={t.id}>
									{t.label}
								</SelectItem>
							))
						)}
					</SelectContent>
				</Select>
			)}
		</div>
	);
}

/** Built-in and custom roles; `exclude` hides e.g. owner where it can't apply. */
/** Built-in role names whose UI name differs from the identifier. */
export const ROLE_LABELS: Record<string, string> = {
	manager: "Project manager",
};

export function RoleSelect({
	id,
	value,
	onChange,
	exclude = [],
	allowGuest = false,
	className,
	"aria-label": ariaLabel,
}: {
	id?: string;
	value: string;
	onChange: (role: string) => void;
	exclude?: string[];
	/** The guest role exists only on a project scope. */
	allowGuest?: boolean;
	className?: string;
	"aria-label"?: string;
}) {
	const { data: roles = [] } = useRoles();
	const shown = roles.filter(
		(r: Role) =>
			!exclude.includes(r.name) &&
			(allowGuest || !(r.builtin && r.name === "guest")),
	);
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger id={id} aria-label={ariaLabel} className={className}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{shown.map((r) => (
					<SelectItem key={r.name} value={r.name}>
						<span className="capitalize">
							{(r.builtin && ROLE_LABELS[r.name]) || r.name}
						</span>
						{!r.builtin && (
							<span className="text-muted-foreground">Custom</span>
						)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

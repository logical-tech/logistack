import { createFileRoute } from "@tanstack/react-router";
import { Check, CircleAlert, Minus, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { isOrgAdmin, roleName } from "@/components/access/members-dialogs";
import { type EditorState, RoleEditor } from "@/components/access/roles-editor";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	ACTION_LABELS,
	PERMISSION_ACTIONS,
	useMe,
	useRoles,
} from "@/lib/api/access";
import type { Role } from "@/lib/api/access-types";

export const Route = createFileRoute("/_app/settings/roles")({
	staticData: { crumb: "Roles" },
	component: Roles,
});

const BUILTIN_NOTE: Record<string, string> = {
	owner: "Everything, including deleting the organization.",
	admin: "Everything except deleting the organization.",
	developer: "Ships code: reads, deploys and edits, never sees secrets.",
	viewer: "Reads everything except secrets; comments on tasks.",
	manager:
		"Project manager: manages tasks, lists and fields; sees whether services are up. No access to deployments, logs or settings.",
	guest: "Reads tasks and comments on one project. For clients.",
};

function Roles() {
	const roles = useRoles();
	const { data: me } = useMe();
	const admin = isOrgAdmin(me);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const all = roles.data ?? [];
	const builtin = all.filter((r) => r.builtin);
	const custom = all.filter((r) => !r.builtin);

	return (
		<Page>
			<PageHeader
				title="Roles"
				description="A role is a set of actions. Grant it on the whole organization or on one folder, project, environment or service; it reaches everything below."
				actions={
					admin && (
						<Button onClick={() => setEditor({ mode: "create" })}>
							<Plus data-icon="inline-start" />
							Create role
						</Button>
					)
				}
			/>

			{roles.isError ? (
				<div
					role="alert"
					className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 px-4 py-6 text-sm"
				>
					<CircleAlert className="size-4 text-bad-text" aria-hidden />
					<span className="min-w-0 flex-1">
						Couldn't load roles.{" "}
						<span className="text-muted-foreground">{roles.error.message}</span>
					</span>
					<Button variant="outline" size="sm" onClick={() => roles.refetch()}>
						Try again
					</Button>
				</div>
			) : (
				<div className="grid gap-10">
					<Panel title="Built-in roles" id="builtin-roles">
						{roles.isPending ? (
							<SkeletonRows rows={4} />
						) : (
							<RoleMatrix roles={builtin} />
						)}
					</Panel>

					<Panel
						title={
							<>
								Custom roles{" "}
								{roles.data && (
									<span className="font-normal text-muted-foreground tabular-nums">
										{custom.length}
									</span>
								)}
							</>
						}
						id="custom-roles"
					>
						{roles.isPending ? (
							<SkeletonRows rows={2} />
						) : custom.length === 0 ? (
							<EmptyState
								icon={ShieldCheck}
								title="Four built-in roles cover most teams"
								description="Create a custom role when someone needs deploy rights on one project without seeing secrets."
								className="rounded-none"
							>
								{admin && (
									<Button
										variant="outline"
										onClick={() => setEditor({ mode: "create" })}
									>
										Create role
									</Button>
								)}
							</EmptyState>
						) : (
							<RoleMatrix
								roles={custom}
								onEdit={
									admin
										? (role) => setEditor({ mode: "edit", role })
										: undefined
								}
							/>
						)}
					</Panel>
				</div>
			)}

			<RoleEditor
				state={editor}
				onOpenChange={(open) => !open && setEditor(null)}
			/>
		</Page>
	);
}

/** Roles as rows, actions as columns on wide screens; a sentence of actions per role on phones. */
function RoleMatrix({
	roles,
	onEdit,
}: {
	roles: Role[];
	onEdit?: (role: Role) => void;
}) {
	return (
		<table className="w-full text-sm">
			<caption className="sr-only">Actions each role allows</caption>
			<thead className="hidden md:table-header-group">
				<tr className="border-b">
					<th
						scope="col"
						className="h-9 px-4 text-left text-xs font-medium text-muted-foreground"
					>
						Role
					</th>
					{PERMISSION_ACTIONS.map((a) => (
						<th
							key={a}
							scope="col"
							title={ACTION_LABELS[a].description}
							className="h-9 w-[4.75rem] px-1 text-center text-xs font-medium whitespace-nowrap text-muted-foreground"
						>
							{ACTION_LABELS[a].label}
						</th>
					))}
					<th
						scope="col"
						className="h-9 w-24 px-4 text-right text-xs font-medium text-muted-foreground"
					>
						Holders
					</th>
					{onEdit && (
						<th scope="col" className="w-20">
							<span className="sr-only">Edit</span>
						</th>
					)}
				</tr>
			</thead>
			<tbody>
				{roles.map((r) => (
					<tr
						key={r.name}
						className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/40"
					>
						<th scope="row" className="px-4 py-3 text-left font-normal">
							<span className="block font-medium">
								{r.builtin ? roleName(r.name) : r.name}
							</span>
							<span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
								{r.builtin
									? BUILTIN_NOTE[r.name]
									: `${r.usage} holder${r.usage === 1 ? "" : "s"}`}
							</span>
							<span className="mt-1 block text-xs text-muted-foreground md:hidden">
								{r.actions
									.map(
										(a) =>
											ACTION_LABELS[a as keyof typeof ACTION_LABELS]?.label,
									)
									.join(", ")}
							</span>
						</th>
						{PERMISSION_ACTIONS.map((a) => {
							const on = r.actions.includes(a);
							return (
								<td key={a} className="hidden px-1 text-center md:table-cell">
									{on ? (
										<Check
											className="mx-auto size-4 text-foreground"
											aria-label="Allowed"
										/>
									) : (
										<Minus
											className="mx-auto size-3.5 text-muted-foreground/50"
											aria-label="Not allowed"
										/>
									)}
								</td>
							);
						})}
						<td className="hidden px-4 text-right text-muted-foreground tabular-nums md:table-cell">
							{r.usage}
						</td>
						{onEdit && (
							<td className="px-4 py-3 text-right align-top md:align-middle">
								<Button
									variant="outline"
									size="sm"
									onClick={() => onEdit(r)}
									aria-label={`Edit role ${r.name}`}
								>
									Edit
								</Button>
							</td>
						)}
					</tr>
				))}
			</tbody>
		</table>
	);
}

import { StreamLanguage } from "@codemirror/language";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Lock, PenLine, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ScriptEditor } from "@/components/backups/script-editor";
import { CopyButton } from "@/components/copy-button";
import { Segmented } from "@/components/segmented";
import { ComposeChangesDialog } from "@/components/stack/compose-changes";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import {
	stackQuery,
	useApplyStackCompose,
	useSyncStack,
} from "@/lib/api/stacks";

const yamlLanguage = StreamLanguage.define(yaml);

export const Route = createFileRoute(
	"/_app/projects/$projectId/stacks/$stackId/compose",
)({
	validateSearch: z.object({
		view: z.enum(["source", "effective"]).optional().catch(undefined),
	}),
	component: StackCompose,
});

const NOTE = {
	source:
		"The file last applied to this stack. Edit it to add, change or remove containers; you review what changes before anything deploys.",
	effective:
		"What LogiStack runs now, written as compose from each container's settings. Secrets show as <secret> unless you can read secrets.",
};

const errorText = (e: unknown) =>
	e instanceof ApiError && Array.isArray(e.details)
		? `${e.message}: ${e.details.join("; ")}`
		: e instanceof Error
			? e.message
			: String(e);

function StackCompose() {
	const { stackId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: stack } = useQuery(stackQuery(stackId));
	const [draft, setDraft] = useState<string | null>(null);
	const preview = useMutation({
		mutationFn: (yaml: string) => api.stacks.previewCompose(stackId, yaml),
	});
	const apply = useApplyStackCompose(stackId);
	const [reviewing, setReviewing] = useState(false);
	const syncPreview = useMutation({
		mutationFn: () => api.stacks.sync(stackId, true),
	});
	const sync = useSyncStack(stackId);
	if (!stack) return null;
	const git = stack.git;
	const hasSource = stack.source === "compose" || git !== null;
	const view = hasSource ? (search.view ?? "source") : "effective";
	const text =
		view === "source" ? (stack.composeYaml ?? "") : stack.effectiveCompose;
	const editing = draft !== null && view === "source";
	const canEdit =
		stack.source === "compose" && view === "source" && !stack.composeHidden;
	const error = git
		? (syncPreview.error ?? sync.error)
		: (preview.error ?? apply.error);
	const note =
		git && view === "source"
			? `The file last read from ${git.repository}@${git.branch}. Every push to ${git.branch} re-syncs the stack; change it in the repository.`
			: NOTE[view];

	const stopEditing = () => {
		setDraft(null);
		preview.reset();
		apply.reset();
	};

	return (
		<div className="grid gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				{hasSource ? (
					<Segmented
						label="Compose view"
						value={view}
						onChange={(v) => navigate({ search: { view: v }, replace: true })}
						options={[
							{
								value: "source",
								label: git ? git.composePath : "Compose file",
							},
							{ value: "effective", label: "Effective" },
						]}
					/>
				) : (
					<h2 className="text-sm font-semibold [font-stretch:100%]">
						Effective compose
					</h2>
				)}
				<div className="flex items-center gap-1">
					{text && !editing && <CopyButton value={text} label="Copy compose" />}
					{canEdit && !editing && (
						<Button variant="outline" size="sm" onClick={() => setDraft(text)}>
							<PenLine aria-hidden />
							Edit
						</Button>
					)}
					{git && (
						<Button
							variant="outline"
							size="sm"
							disabled={syncPreview.isPending}
							onClick={() =>
								syncPreview.mutate(undefined, {
									onSuccess: () => setReviewing(true),
								})
							}
						>
							<RefreshCw aria-hidden />
							Sync now
						</Button>
					)}
				</div>
			</div>
			<p className="max-w-[75ch] text-sm text-pretty text-muted-foreground">
				{note}
			</p>
			{git && error && (
				<p role="alert" className="text-sm text-pretty text-bad-text">
					{errorText(error)}
				</p>
			)}
			{git && syncPreview.data && (
				<ComposeChangesDialog
					changes={syncPreview.data.changes}
					open={reviewing}
					onOpenChange={setReviewing}
					applying={sync.isPending}
					onApply={() =>
						sync.mutate(undefined, {
							onSuccess: (out) => {
								setReviewing(false);
								syncPreview.reset();
								toast.success(
									out.services.length
										? `Synced; deploying ${out.services.map((s) => s.name).join(", ")}`
										: "Synced; nothing changed",
								);
							},
							onError: () => setReviewing(false),
						})
					}
				/>
			)}
			{view === "source" && stack.composeHidden ? (
				<div className="flex items-start gap-3 rounded-xl bg-card px-4 py-5 text-sm shadow-card ring-1 ring-border">
					<Lock
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<p className="text-pretty">
						The pasted file can hold credentials, so it shows only to members
						who can read secrets. The effective view masks them.
					</p>
				</div>
			) : editing ? (
				<>
					<ScriptEditor
						key="draft"
						id="stack-compose"
						label="Compose file"
						value={draft}
						onChange={setDraft}
						language={yamlLanguage}
						hint=""
						invalid={Boolean(error)}
						describedBy={error ? "stack-compose-error" : undefined}
						className="max-h-[70vh] overflow-auto"
					/>
					{error && (
						<p
							id="stack-compose-error"
							role="alert"
							className="text-sm text-pretty text-bad-text"
						>
							{errorText(error)}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button variant="outline" onClick={stopEditing}>
							Cancel
						</Button>
						<Button
							disabled={preview.isPending || !draft.trim()}
							onClick={() =>
								preview.mutate(draft, { onSuccess: () => setReviewing(true) })
							}
						>
							Review changes
						</Button>
					</div>
					{preview.data && (
						<ComposeChangesDialog
							changes={preview.data.changes}
							open={reviewing}
							onOpenChange={setReviewing}
							applying={apply.isPending}
							onApply={() =>
								apply.mutate(draft, {
									onSuccess: (out) => {
										setReviewing(false);
										stopEditing();
										toast.success(
											out.services.length
												? `Applied; deploying ${out.services.map((s) => s.name).join(", ")}`
												: "Applied the compose file",
										);
									},
									onError: () => setReviewing(false),
								})
							}
						/>
					)}
				</>
			) : (
				<ScriptEditor
					key={view}
					id="stack-compose"
					label={view === "source" ? "Compose file" : "Effective compose"}
					value={text}
					onChange={() => {}}
					language={yamlLanguage}
					hint=""
					readOnly
					className="max-h-[70vh] overflow-auto"
				/>
			)}
		</div>
	);
}

import { StreamLanguage } from "@codemirror/language";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { z } from "zod";
import { ScriptEditor } from "@/components/backups/script-editor";
import { CopyButton } from "@/components/copy-button";
import { Segmented } from "@/components/segmented";
import { stackQuery } from "@/lib/api/stacks";

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
		"The file as it was pasted. LogiStack read it once to create the containers; edit a container to change it.",
	effective:
		"What LogiStack runs now, written as compose from each container's settings. Secrets show as <secret> unless you can read secrets.",
};

function StackCompose() {
	const { stackId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: stack } = useQuery(stackQuery(stackId));
	if (!stack) return null;
	const hasSource = stack.source === "compose";
	const view = hasSource ? (search.view ?? "source") : "effective";
	const text =
		view === "source" ? (stack.composeYaml ?? "") : stack.effectiveCompose;

	return (
		<div className="grid gap-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				{hasSource ? (
					<Segmented
						label="Compose view"
						value={view}
						onChange={(v) => navigate({ search: { view: v }, replace: true })}
						options={[
							{ value: "source", label: "Pasted file" },
							{ value: "effective", label: "Effective" },
						]}
					/>
				) : (
					<h2 className="text-sm font-semibold [font-stretch:100%]">
						Effective compose
					</h2>
				)}
				{text && <CopyButton value={text} label="Copy compose" />}
			</div>
			<p className="max-w-[75ch] text-sm text-pretty text-muted-foreground">
				{NOTE[view]}
			</p>
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
			) : (
				<ScriptEditor
					key={view}
					id="stack-compose"
					label={
						view === "source" ? "Pasted compose file" : "Effective compose"
					}
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

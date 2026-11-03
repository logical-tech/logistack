import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { EnvironmentId, ProjectId, ProjectSummary } from "@/lib/api/types";

/** Projects page → template gallery: pick where the app goes first, since template services are named per environment. */
export function StartFromTemplateDialog({
	open,
	onOpenChange,
	projects,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projects: ProjectSummary[];
}) {
	const navigate = useNavigate();
	const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
	const [projectId, setProjectId] = useState<ProjectId | undefined>(
		sorted[0]?.id,
	);
	const project = sorted.find((p) => p.id === projectId);
	const [envId, setEnvId] = useState<EnvironmentId | undefined>();
	const env =
		project?.environments.find((e) => e.id === envId) ??
		project?.environments.find((e) => e.kind === "production") ??
		project?.environments[0];

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!project || !env) return;
		void navigate({
			to: "/projects/$projectId/templates",
			params: { projectId: project.id },
			search: { env: env.id },
		});
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} noValidate className="grid grid-cols-1 gap-5">
					<DialogHeader>
						<DialogTitle>New from a template</DialogTitle>
						<DialogDescription>
							Choose where the app goes. Its services join that environment's
							network under their own names.
						</DialogDescription>
					</DialogHeader>
					<Field id="tpl-project" label="Project">
						<Select
							value={projectId}
							onValueChange={(v) => {
								setProjectId(v as ProjectId);
								setEnvId(undefined);
							}}
						>
							<SelectTrigger id="tpl-project" className="w-full">
								<SelectValue placeholder="Choose a project" />
							</SelectTrigger>
							<SelectContent>
								{sorted.map((p) => (
									<SelectItem key={p.id} value={p.id}>
										{p.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field id="tpl-env" label="Environment">
						<Select
							value={env?.id}
							onValueChange={(v) => setEnvId(v as EnvironmentId)}
							disabled={!project}
						>
							<SelectTrigger id="tpl-env" className="w-full">
								<SelectValue placeholder="Choose an environment" />
							</SelectTrigger>
							<SelectContent>
								{project?.environments.map((e) => (
									<SelectItem key={e.id} value={e.id}>
										{e.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!env}>
							Browse templates
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

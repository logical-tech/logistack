import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Minus } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { ENV_KINDS } from "@/components/projects/create-dialogs";
import { EnvDot } from "@/components/projects/env-color";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { projectQuery, useDuplicateEnvironment } from "@/lib/api/projects";
import { servicesQuery } from "@/lib/api/services";
import type { Environment, EnvironmentKind } from "@/lib/api/types";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/projects/$projectId/duplicate")({
	staticData: { crumb: "Duplicate environment" },
	validateSearch: z.object({
		from: z.string().startsWith("env_").optional().catch(undefined),
		step: stepParam,
	}),
	component: DuplicateEnvironment,
});

type V = {
	from: string;
	name: string;
	kind: EnvironmentKind;
	variables: "copy" | "skip";
};

const KIND_HINT: Record<EnvironmentKind, string> = {
	staging: "Checks before a release",
	preview: "Short-lived, for one change",
	production: "Serves real traffic",
	custom: "Anything else",
};

const slugOf = (name: string) =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

function List({ items, copied }: { items: string[]; copied: boolean }) {
	const Icon = copied ? Check : Minus;
	return (
		<ul className="grid gap-1.5 text-sm">
			{items.map((i) => (
				<li key={i} className="flex gap-2">
					<Icon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span className="text-pretty">{i}</span>
				</li>
			))}
		</ul>
	);
}

function DuplicateEnvironment() {
	const { projectId } = Route.useParams();
	const { from, step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: project } = useQuery(projectQuery(projectId));
	const duplicate = useDuplicateEnvironment(projectId);
	const envs = project?.environments ?? [];
	const source =
		envs.find((e) => e.id === from) ?? envs.find((e) => e.isDefault) ?? envs[0];

	const steps = useMemo((): WizardStep<V>[] => {
		const envOf = (id: string): Environment | undefined =>
			envs.find((e) => e.id === id);
		return [
			{
				id: "name",
				title: "Name the copy",
				description:
					"A new environment in this project, built from the services and settings of the one you copy.",
				schema: z.object({
					from: z.string().min(1, "Pick the environment to copy."),
					name: z
						.string()
						.trim()
						.min(1, "Name it.")
						.max(100)
						.refine(
							(n) => !envs.some((e) => e.slug === slugOf(n)),
							"This project already has an environment with that name.",
						),
				}),
				render: (w) => (
					<div className="grid max-w-xl gap-5">
						<Field id="wz-from" label="Copy from" error={w.error("from")}>
							<Select
								value={w.values.from}
								onValueChange={(v) => w.set("from", v)}
							>
								<SelectTrigger id="wz-from" className="w-full">
									<SelectValue placeholder="Pick an environment" />
								</SelectTrigger>
								<SelectContent>
									{envs.map((e) => (
										<SelectItem key={e.id} value={e.id}>
											<EnvDot env={e} />
											{e.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field id="wz-name" label="Name" error={w.error("name")}>
							<Input {...w.bind("name")} autoFocus placeholder="Staging" />
						</Field>
						<div className="grid gap-2">
							<span className="text-sm font-medium">Kind</span>
							<ChoiceGroup
								label="Kind"
								value={w.values.kind}
								onChange={(k) => w.set("kind", k)}
								choices={ENV_KINDS.map((k) => ({
									value: k.value,
									title: k.label,
									description: KIND_HINT[k.value],
								}))}
							/>
						</div>
					</div>
				),
			},
			{
				id: "copy",
				title: "What comes over",
				description:
					"Services keep their source, build, resources, health checks and config files. Hostnames and data stay with the original.",
				render: (w) => (
					<div className="grid gap-6">
						<ChoiceGroup
							label="Variables"
							value={w.values.variables}
							onChange={(v) => w.set("variables", v)}
							choices={[
								{
									value: "copy",
									title: "Copy variables",
									description:
										"The environment's variables and every service's own. Secrets are copied encrypted when you may read them.",
								},
								{
									value: "skip",
									title: "Start without variables",
									description:
										"For a copy that must not reach the original's databases or APIs. Set new values before deploying.",
								},
							]}
						/>
						<div className="grid gap-6 rounded-lg bg-card p-4 ring-1 ring-border sm:grid-cols-2">
							<div className="grid content-start gap-2">
								<h3 className="text-sm font-medium">Copied</h3>
								<List
									copied
									items={[
										"Services, with their settings and config files",
										"Stacks deployed from Git",
										...(w.values.variables === "copy" ? ["Variables"] : []),
									]}
								/>
							</div>
							<div className="grid content-start gap-2">
								<h3 className="text-sm font-medium">Not copied</h3>
								<List
									copied={false}
									items={[
										"Domains: a hostname points at one environment",
										"Volume and database data: new volumes start empty",
										"Backup policies",
										...(w.values.variables === "skip" ? ["Variables"] : []),
									]}
								/>
							</div>
						</div>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and duplicate",
				description:
					"Nothing is deployed. Add domains and deploy each service when it is ready.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "name",
								title: "Environment",
								rows: [
									{ label: "Name", value: w.values.name.trim() },
									{
										label: "Kind",
										value: ENV_KINDS.find((k) => k.value === w.values.kind)
											?.label,
									},
									{
										label: "Copied from",
										value: envOf(w.values.from)?.name ?? "",
									},
								],
							},
							{
								stepId: "copy",
								title: "Contents",
								rows: [
									{
										label: "Services",
										value: <ServiceCount environmentId={w.values.from} />,
									},
									{
										label: "Variables",
										value:
											w.values.variables === "copy" ? "Copied" : "Not copied",
									},
									{ label: "Domains and data", value: "Not copied" },
								],
							},
						]}
					/>
				),
			},
		];
	}, [envs]);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	if (!project || !source) return null;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Duplicate environment"
				description={`Start a new environment of ${project.name} from an existing one, for example Staging from Production.`}
			/>
			<Wizard
				id={`duplicate-env-${source.id}`}
				steps={steps}
				defaultValues={{
					from: source.id,
					name: "",
					kind: source.kind === "production" ? "staging" : source.kind,
					variables: "copy",
				}}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Duplicate environment"
				onComplete={async (v) => {
					const out = await duplicate.mutateAsync({
						id: v.from as Environment["id"],
						name: v.name.trim(),
						kind: v.kind,
						includeVariables: v.variables === "copy",
					});
					toast.success(`${out.environment.name} created`, {
						description: out.warnings.length
							? out.warnings.join(" ")
							: "Nothing is deployed yet. Add domains, then deploy each service.",
					});
					await navigate({
						to: "/projects/$projectId",
						params: { projectId },
						search: { env: out.environment.id },
					});
				}}
			/>
		</Page>
	);
}

function ServiceCount({ environmentId }: { environmentId: string }) {
	const { data } = useQuery(servicesQuery(environmentId as Environment["id"]));
	if (!data) return "…";
	return data.length === 1 ? "1 service" : `${data.length} services`;
}

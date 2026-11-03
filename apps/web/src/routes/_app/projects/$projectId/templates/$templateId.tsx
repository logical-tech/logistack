import { secretInputTypes, type Template } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { BookOpen, ExternalLink } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { Page } from "@/components/page-header";
import {
	TemplateInputs,
	type TemplateValues,
} from "@/components/templates/inputs";
import { TemplateOverview } from "@/components/templates/overview";
import { DeployProgress } from "@/components/templates/progress";
import {
	type DeployProblem,
	TemplateReview,
} from "@/components/templates/review";
import { TemplateLogo } from "@/components/templates/template-logo";
import { Button } from "@/components/ui/button";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { ApiError } from "@/lib/api";
import { instanceStatusQuery } from "@/lib/api/instance";
import { projectQuery } from "@/lib/api/projects";
import { servicesQuery } from "@/lib/api/services";
import {
	type TemplateDeployResult,
	templateQuery,
	useDeployTemplate,
} from "@/lib/api/templates";
import type { Environment, ProjectId } from "@/lib/api/types";
import { stepParam } from "@/lib/search";
import {
	CATEGORY_LABEL,
	deployInputs,
	inputsSchema,
	isRepeat,
	nameConflicts,
} from "@/lib/templates";

export const Route = createFileRoute(
	"/_app/projects/$projectId/templates/$templateId",
)({
	validateSearch: z.object({
		env: z.string().startsWith("env_").optional().catch(undefined),
		step: stepParam,
	}),
	loader: async ({ context, params }) => {
		try {
			const t = await context.queryClient.ensureQueryData(
				templateQuery(params.templateId),
			);
			return { crumb: t.name };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: TemplateFlow,
});

function problemOf(e: unknown): DeployProblem {
	if (e instanceof ApiError && e.code === "conflict") {
		const names = (e.details as { conflicts?: string[] } | undefined)
			?.conflicts;
		return { kind: "conflict", names: names ?? [] };
	}
	if (e instanceof ApiError && e.code === "validation_failed")
		return {
			kind: "invalid",
			issues: Array.isArray(e.details) ? e.details.map(String) : [e.message],
		};
	return { kind: "other", message: e instanceof Error ? e.message : String(e) };
}

function buildSteps(
	t: Template,
	env: Environment,
	others: Environment[],
	projectId: ProjectId,
	base: string,
	conflicts: string[],
	repeat: boolean,
	problem: DeployProblem | null,
): WizardStep<TemplateValues>[] {
	return [
		{
			id: "overview",
			title: "What it creates",
			description: `Everything below is created in ${env.name} when you deploy.`,
			render: () => <TemplateOverview template={t} base={base} />,
		},
		{
			id: "settings",
			title: "Settings",
			description:
				"Only the required fields need an answer. Everything else has a safe default.",
			when: () => t.inputs.length > 0,
			schema: inputsSchema(t),
			render: (w) => <TemplateInputs w={w} template={t} base={base} />,
		},
		{
			id: "review",
			title: "Review",
			description: `Check what goes into ${env.name}, then deploy.`,
			schema: z.custom(
				() => conflicts.length === 0,
				"Choose an environment without these service names.",
			),
			render: (w) => (
				<TemplateReview
					w={w}
					template={t}
					base={base}
					env={env}
					otherEnvironments={others}
					projectId={projectId}
					conflicts={conflicts}
					repeat={repeat}
					problem={problem}
				/>
			),
		},
	];
}

function TemplateFlow() {
	const { projectId, templateId } = Route.useParams();
	const { env: envParam, step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: template } = useQuery(templateQuery(templateId));
	const { data: project } = useQuery(projectQuery(projectId));
	const { data: status } = useQuery(instanceStatusQuery);
	const env =
		project?.environments.find((e) => e.id === envParam) ??
		project?.environments.find((e) => e.isDefault) ??
		project?.environments[0];
	const services = useQuery({
		...servicesQuery(env?.id ?? ("" as never)),
		enabled: Boolean(env),
	});
	const deploy = useDeployTemplate(env?.id ?? ("" as never));
	const [result, setResult] = useState<TemplateDeployResult | null>(null);
	const [problem, setProblem] = useState<DeployProblem | null>(null);

	// shortcut: generated hostnames assume sslip.io until instance settings are exposed by the API.
	const base = `${(status?.publicIp ?? "0.0.0.0").replaceAll(".", "-")}.sslip.io`;
	const conflicts = useMemo(
		() =>
			template && services.data ? nameConflicts(template, services.data) : [],
		[template, services.data],
	);
	const repeat = Boolean(
		template && services.data && isRepeat(template.id, services.data),
	);
	const steps = useMemo(
		() =>
			template && project && env
				? buildSteps(
						template,
						env,
						project.environments.filter((e) => e.id !== env.id),
						projectId,
						base,
						conflicts,
						repeat,
						problem,
					)
				: [],
		[template, project, env, projectId, base, conflicts, repeat, problem],
	);
	const secretKeys = useMemo(
		() =>
			template?.inputs
				.filter((i) => secretInputTypes.includes(i.type))
				.map((i) => i.key) ?? [],
		[template],
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	if (!template || !project || !env || services.isPending) return null;

	return (
		<Page className="max-w-5xl">
			<header className="flex flex-col gap-4 pb-8 sm:flex-row sm:items-start">
				<TemplateLogo template={template} className="size-12 rounded-xl" />
				<div className="min-w-0 flex-1">
					<h1 className="text-xl font-semibold text-balance">
						{template.name}
					</h1>
					<p className="mt-1 max-w-[70ch] text-sm text-pretty text-muted-foreground">
						{template.description}
					</p>
					<p className="mt-2 text-xs text-muted-foreground">
						{CATEGORY_LABEL[template.category]} · Into{" "}
						<span className="text-foreground">{project.name}</span> ·{" "}
						<span className="text-foreground">{env.name}</span>
					</p>
				</div>
				{(template.website || template.docs) && (
					<div className="flex shrink-0 gap-2">
						{template.website && (
							<Button asChild variant="outline" size="sm">
								<a href={template.website} target="_blank" rel="noreferrer">
									Website
									<ExternalLink data-icon="inline-end" />
								</a>
							</Button>
						)}
						{template.docs && (
							<Button asChild variant="outline" size="sm">
								<a href={template.docs} target="_blank" rel="noreferrer">
									<BookOpen data-icon="inline-start" />
									Docs
								</a>
							</Button>
						)}
					</div>
				)}
			</header>

			{result ? (
				<DeployProgress
					result={result}
					template={template}
					projectId={projectId}
					environmentId={env.id}
				/>
			) : (
				<Wizard
					key={env.id}
					id={`template:${env.id}:${template.id}`}
					steps={steps}
					defaultValues={{}}
					secretKeys={secretKeys}
					step={step}
					onStepChange={onStepChange}
					finishLabel="Deploy"
					onComplete={async (v) => {
						setProblem(null);
						try {
							setResult(
								await deploy.mutateAsync({
									templateId: template.id,
									input: { inputs: deployInputs(template, v) },
								}),
							);
						} catch (e) {
							setProblem(problemOf(e));
							void services.refetch();
						}
					}}
				/>
			)}
		</Page>
	);
}

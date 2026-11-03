import type { Template } from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Summary } from "@/components/wizard/parts";
import type { WizardApi } from "@/components/wizard/wizard";
import type { Environment, ProjectId } from "@/lib/api/types";
import {
	inputGroup,
	isSecretInput,
	publicRoutes,
	serviceImage,
} from "@/lib/templates";
import type { TemplateValues } from "./inputs";
import { generatedExample } from "./overview";

/** A problem the server reported on the last deploy attempt, shown where it can be fixed. */
export type DeployProblem =
	| { kind: "conflict"; names: string[] }
	| { kind: "invalid"; issues: string[] }
	| { kind: "other"; message: string };

const list = (names: string[]) =>
	names.length < 2
		? (names[0] ?? "")
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function TemplateReview({
	w,
	template: t,
	base,
	env,
	otherEnvironments,
	projectId,
	conflicts,
	repeat,
	problem,
}: {
	w: WizardApi<TemplateValues>;
	template: Template;
	base: string;
	env: Environment;
	otherEnvironments: Environment[];
	projectId: ProjectId;
	conflicts: string[];
	/** The environment already runs this instance; deploying returns it and creates nothing. */
	repeat: boolean;
	problem: DeployProblem | null;
}) {
	const v = w.values;
	const taken = conflicts.length
		? conflicts
		: problem?.kind === "conflict"
			? problem.names
			: [];
	const routes = publicRoutes(t);
	const shown = (key: string) => (v[key] ?? "").trim();

	return (
		<div className="grid grid-cols-1 gap-5">
			{taken.length > 0 && (
				<Callout
					title={`${env.name} already has ${taken.length === 1 ? "a service" : "services"} named ${list(taken)}`}
				>
					<p>
						Each service keeps its template name, because the others reach it by
						that name. Deploy {t.name} into another environment.
					</p>
					{otherEnvironments.length > 0 ? (
						<div className="mt-3 flex flex-wrap gap-2">
							{otherEnvironments.map((e) => (
								<Button key={e.id} asChild variant="outline" size="sm">
									<Link
										to="/projects/$projectId/templates/$templateId"
										params={{ projectId, templateId: t.id }}
										search={{ env: e.id, step: "review" }}
									>
										Use {e.name}
									</Link>
								</Button>
							))}
						</div>
					) : (
						<p className="mt-1">This project has no other environment yet.</p>
					)}
				</Callout>
			)}
			{repeat && (
				<p className="rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground dark:bg-muted/40">
					{t.name} already runs in {env.name}. Deploying again creates nothing
					and shows its services.
				</p>
			)}
			{problem?.kind === "invalid" && (
				<Callout title="The server refused these settings">
					<ul className="list-disc pl-4">
						{problem.issues.map((i) => (
							<li key={i}>{i}</li>
						))}
					</ul>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-3"
						onClick={() => w.goTo("settings")}
					>
						Edit settings
					</Button>
				</Callout>
			)}
			{problem?.kind === "other" && (
				<Callout title="Couldn't deploy">
					<p>{problem.message}</p>
				</Callout>
			)}

			<Summary
				w={w}
				sections={[
					{
						stepId: "overview",
						title: `${t.services.length === 1 ? "1 service" : `${t.services.length} services`} in ${env.name}`,
						rows: t.services.map((s) => ({
							label: s.name,
							value: (
								<span className="font-mono text-xs text-muted-foreground">
									{serviceImage(s)}
								</span>
							),
						})),
					},
					...(t.inputs.length
						? [
								{
									stepId: "settings",
									title: "Settings",
									rows: [
										...routes.map((r) => ({
											label:
												r.input.role === "primary"
													? "Public URL"
													: r.input.label,
											value: (
												<span className="font-mono text-xs break-all">
													https://
													{shown(r.input.key) ||
														generatedExample(r.service, base)}
												</span>
											),
										})),
										...t.inputs
											.filter((i) => i.type !== "domain")
											.map((i) => ({
												label: i.label,
												value: isSecretInput(i) ? (
													<span className="text-muted-foreground">
														{shown(i.key) ? "Set by you" : "Auto-generated"}
													</span>
												) : shown(i.key) ? (
													shown(i.key)
												) : (
													<span className="text-muted-foreground">
														{inputGroup(i) === "generated"
															? "Auto-generated"
															: i.type === "text" && i.default
																? `Default, ${i.default}`
																: "Not set"}
													</span>
												),
											})),
									],
								},
							]
						: []),
				]}
			/>
		</div>
	);
}

function Callout({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div
			role="alert"
			className="t-reveal flex gap-3 rounded-lg bg-bad/8 p-4 ring-1 ring-bad/25 ring-inset"
		>
			<CircleAlert
				className="mt-0.5 size-4 shrink-0 text-bad-text"
				aria-hidden
			/>
			<div className="min-w-0 text-sm text-muted-foreground">
				<p className="font-medium text-foreground">{title}</p>
				<div className="mt-1">{children}</div>
			</div>
		</div>
	);
}

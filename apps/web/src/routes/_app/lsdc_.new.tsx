import { LsdcProvisionInput } from "@logistack/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Boxes, CircleCheck, Gauge, Layers, Rocket } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import {
	CurrencySelect,
	cores,
	LimitFields,
	megabytes,
	money,
	parseLimits,
	parsePrice,
} from "@/components/lsdc/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type Choice,
	ChoiceGroup,
	Instructions,
	Summary,
} from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { ApiError } from "@/lib/api";
import { type LsdcProvision, lsdcApi, useLsdcMutation } from "@/lib/api/lsdc";
import { useProjects } from "@/lib/api/projects";
import type { ProjectSummary, ServiceId } from "@/lib/api/types";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/lsdc_/new")({
	staticData: { crumb: "New LSDC instance" },
	validateSearch: z.object({ step: stepParam }),
	component: NewLsdcInstance,
});

type V = {
	customer: string;
	projectId: string;
	environmentId: string;
	domain: string;
	adminEmail: string;
	blueprintUrl: string;
	cpu: string;
	ramMb: string;
	storageMb: string;
	price: string;
	currency: string;
};

const PRESETS = {
	small: { title: "Small", cpu: 0.5, ramMb: 512, storageMb: 2048 },
	medium: { title: "Medium", cpu: 1, ramMb: 1024, storageMb: 10_240 },
	large: { title: "Large", cpu: 2, ramMb: 2048, storageMb: 51_200 },
} as const;
type Preset = keyof typeof PRESETS | "custom";

const presetOf = (v: V): Preset =>
	(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).find(
		(k) =>
			String(PRESETS[k].cpu) === v.cpu &&
			String(PRESETS[k].ramMb) === v.ramMb &&
			String(PRESETS[k].storageMb) === v.storageMb,
	) ?? "custom";

const PLAN_CHOICES: Choice<Preset>[] = [
	...(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => ({
		value: k,
		title: PRESETS[k].title,
		description: `${cores(PRESETS[k].cpu)} · ${megabytes(PRESETS[k].ramMb)} RAM · ${megabytes(PRESETS[k].storageMb)} disk`,
		icon: k === "small" ? Boxes : k === "medium" ? Layers : Gauge,
	})),
	{
		value: "custom",
		title: "Custom",
		description: "Set each limit yourself below.",
	},
];

const HOST =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const shape = LsdcProvisionInput.shape;

/** The project's production environment first, as the template wizard does. */
const defaultEnv = (p: ProjectSummary | undefined) =>
	p?.environments.find((e) => e.kind === "production") ?? p?.environments[0];

function buildSteps(projects: ProjectSummary[]): WizardStep<V>[] {
	const project = (v: V) => projects.find((p) => p.id === v.projectId);
	const env = (v: V) =>
		project(v)?.environments.find((e) => e.id === v.environmentId);
	return [
		{
			id: "customer",
			title: "Customer",
			description:
				"Who the back office is for. The instance, its stack and service are named after them.",
			schema: z.object({
				customer: z
					.string()
					.trim()
					.min(1, "Enter the customer's name.")
					.max(100, "At most 100 characters."),
			}),
			render: (w) => (
				<div className="grid max-w-md gap-6">
					<Field id="wz-customer" label="Customer" error={w.error("customer")}>
						<Input
							{...w.bind("customer")}
							placeholder="Ferretti Logistica S.r.l."
							autoComplete="organization"
							maxLength={100}
							autoFocus
						/>
					</Field>
				</div>
			),
		},
		{
			id: "where",
			title: "Where it runs",
			description:
				"The project and environment the instance joins. Each customer gets its own stack there.",
			schema: (v) =>
				z.object({
					environmentId: z
						.string()
						.refine(
							() => env(v) !== undefined,
							"Choose a project and an environment.",
						),
				}),
			render: (w) => {
				const p = project(w.values);
				return (
					<div className="grid max-w-md gap-6">
						<Field id="wz-projectId" label="Project">
							<Select
								value={w.values.projectId || undefined}
								onValueChange={(id) => {
									w.set("projectId", id);
									w.set(
										"environmentId",
										defaultEnv(projects.find((x) => x.id === id))?.id ?? "",
									);
								}}
							>
								<SelectTrigger id="wz-projectId" className="w-full">
									<SelectValue placeholder="Choose a project" />
								</SelectTrigger>
								<SelectContent>
									{projects.map((x) => (
										<SelectItem key={x.id} value={x.id}>
											{x.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<Field
							id="wz-environmentId"
							label="Environment"
							error={w.error("environmentId")}
						>
							<Select
								value={w.values.environmentId || undefined}
								onValueChange={(id) => w.set("environmentId", id)}
								disabled={!p}
							>
								<SelectTrigger
									id="wz-environmentId"
									className="w-full"
									aria-invalid={w.error("environmentId") ? true : undefined}
									aria-describedby="wz-environmentId-msg"
								>
									<SelectValue placeholder="Choose an environment" />
								</SelectTrigger>
								<SelectContent>
									{p?.environments.map((e) => (
										<SelectItem key={e.id} value={e.id}>
											{e.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
				);
			},
		},
		{
			id: "access",
			title: "Domain and first admin",
			description:
				"How the customer reaches it and who signs in first. Everything here is optional.",
			schema: z.object({
				domain: z
					.string()
					.trim()
					.toLowerCase()
					.refine(
						(d) => d === "" || HOST.test(d),
						"A hostname like office.example.com, or leave it empty.",
					),
				adminEmail: z
					.string()
					.trim()
					.refine(
						(e) => shape.adminEmail.safeParse(e).success,
						"An email address, or leave it empty.",
					),
				blueprintUrl: z
					.string()
					.trim()
					.refine(
						(u) => shape.blueprintUrl.safeParse(u).success,
						"An https:// URL, or leave it empty.",
					),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<Field
						id="wz-domain"
						label="Domain"
						optional
						error={w.error("domain")}
						hint="Empty: a generated hostname. Point the domain's DNS at this server first."
					>
						<Input
							{...w.bind("domain")}
							placeholder="office.customer.com"
							className="font-mono"
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							inputMode="url"
						/>
					</Field>
					<Field
						id="wz-adminEmail"
						label="Admin email"
						optional
						error={w.error("adminEmail")}
						hint="Creates the first admin with a generated password, shown once after creation. Empty: the instance opens its own setup wizard."
					>
						<Input
							{...w.bind("adminEmail")}
							type="email"
							placeholder="admin@customer.com"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					<Field
						id="wz-blueprintUrl"
						label="Blueprint URL"
						optional
						error={w.error("blueprintUrl")}
						hint="An https:// link to a blueprint the instance applies on first start."
					>
						<Input
							{...w.bind("blueprintUrl")}
							type="url"
							placeholder="https://example.com/blueprint.json"
							className="font-mono"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
				</div>
			),
		},
		{
			id: "plan",
			title: "Plan",
			description:
				"CPU and RAM cap the container; storage is LSDC's own quota. The price is what you bill each month.",
			schema: (v) => {
				const { errors } = parseLimits(v);
				return z.object({
					cpu: z.string().refine(() => !errors.cpu, errors.cpu),
					ramMb: z.string().refine(() => !errors.ramMb, errors.ramMb),
					storageMb: z
						.string()
						.refine(() => !errors.storageMb, errors.storageMb),
					price: z
						.string()
						.refine(
							(p) => parsePrice(p) !== undefined,
							"A price like 149 or 149.90.",
						),
				});
			},
			render: (w) => (
				<div className="grid gap-8">
					<ChoiceGroup
						label="Plan"
						columns={2}
						value={presetOf(w.values)}
						onChange={(k) => {
							if (k === "custom") return;
							w.set("cpu", String(PRESETS[k].cpu));
							w.set("ramMb", String(PRESETS[k].ramMb));
							w.set("storageMb", String(PRESETS[k].storageMb));
						}}
						choices={PLAN_CHOICES}
					/>
					<LimitFields
						id="wz"
						values={w.values}
						errors={{
							cpu: w.error("cpu"),
							ramMb: w.error("ramMb"),
							storageMb: w.error("storageMb"),
						}}
						onChange={(k, v) => w.set(k, v)}
					/>
					<Field
						id="wz-price"
						label="Monthly price"
						optional
						error={w.error("price")}
						hint="What the customer pays per month, for the revenue totals."
					>
						<div className="flex gap-2">
							<Input
								{...w.bind("price")}
								inputMode="decimal"
								placeholder="0.00"
								className="tabular max-w-40"
							/>
							<CurrencySelect
								id="wz-currency"
								value={w.values.currency}
								onChange={(c) => w.set("currency", c)}
							/>
						</div>
					</Field>
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"Creating it deploys the instance right away. You can change the plan and price later.",
			render: (w) => {
				const v = w.values;
				const limits = parseLimits(v).limits;
				const cents = parsePrice(v.price);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "customer",
								title: "Customer",
								rows: [{ label: "Name", value: v.customer.trim() }],
							},
							{
								stepId: "where",
								title: "Where it runs",
								rows: [
									{ label: "Project", value: project(v)?.name ?? "–" },
									{ label: "Environment", value: env(v)?.name ?? "–" },
								],
							},
							{
								stepId: "access",
								title: "Domain and first admin",
								rows: [
									{
										label: "Domain",
										value: v.domain.trim() ? (
											<span className="font-mono">
												{v.domain.trim().toLowerCase()}
											</span>
										) : (
											"Generated"
										),
									},
									{
										label: "First admin",
										value:
											v.adminEmail.trim() || "Set up in the instance's wizard",
									},
									...(v.blueprintUrl.trim()
										? [
												{
													label: "Blueprint",
													value: (
														<span className="font-mono">
															{v.blueprintUrl.trim()}
														</span>
													),
												},
											]
										: []),
								],
							},
							{
								stepId: "plan",
								title: "Plan",
								rows: [
									{
										label: "Limits",
										value: limits
											? `${cores(limits.cpu)} · ${megabytes(limits.ramMb)} RAM · ${megabytes(limits.storageMb)} disk`
											: "–",
									},
									{
										label: "Monthly price",
										value:
											typeof cents === "number"
												? money(cents, v.currency)
												: "No price",
									},
								],
							},
						]}
					/>
				);
			},
		},
	];
}

function NewLsdcInstance() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: projects } = useProjects();
	const [result, setResult] = useState<
		(LsdcProvision & { adminEmail: string }) | null
	>(null);
	const provision = useLsdcMutation(
		(a: { environmentId: string; input: LsdcProvisionInput }) =>
			lsdcApi.provision(a.environmentId, a.input),
	);
	const sorted = useMemo(
		() => [...(projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
		[projects],
	);
	const steps = useMemo(() => buildSteps(sorted), [sorted]);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	const first = sorted[0];

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="New LSDC instance"
				description="A managed back office for one customer: its own container with CPU, RAM and storage limits, and a monthly price."
			/>
			{result ? (
				<Created result={result} />
			) : !projects ? (
				<Panel title="Loading" id="wizard-loading">
					<SkeletonRows rows={3} />
				</Panel>
			) : !first ? (
				<EmptyState
					icon={Boxes}
					title="Create a project first"
					description="An instance runs in a project's environment. Create one, then come back."
				>
					<Button asChild>
						<Link to="/projects">Go to projects</Link>
					</Button>
				</EmptyState>
			) : (
				<Wizard
					id="lsdc-new"
					steps={steps}
					defaultValues={{
						customer: "",
						projectId: first.id,
						environmentId: defaultEnv(first)?.id ?? "",
						domain: "",
						adminEmail: "",
						blueprintUrl: "",
						cpu: "1",
						ramMb: "1024",
						storageMb: "10240",
						price: "",
						currency: "EUR",
					}}
					step={step}
					onStepChange={onStepChange}
					finishLabel="Create instance"
					onComplete={async (v) => {
						const limits = parseLimits(v).limits;
						if (!limits) throw new Error("Check the plan's limits.");
						try {
							const r = await provision.mutateAsync({
								environmentId: v.environmentId,
								input: {
									customer: v.customer.trim(),
									domain: v.domain.trim().toLowerCase(),
									adminEmail: v.adminEmail.trim(),
									blueprintUrl: v.blueprintUrl.trim(),
									limits,
									priceCents: parsePrice(v.price) ?? null,
									currency: v.currency,
								},
							});
							setResult({ ...r, adminEmail: v.adminEmail.trim() });
						} catch (err) {
							if (err instanceof ApiError && err.status === 409)
								throw new Error(
									"This customer already has an instance in that environment. Use another name or environment.",
								);
							throw err;
						}
					}}
				/>
			)}
		</Page>
	);
}

/** After creation: the admin password, shown this one time, and the way to the instance. */
function Created({
	result: { instance: i, adminPassword, adminEmail },
}: {
	result: LsdcProvision & { adminEmail: string };
}) {
	return (
		<div className="t-reveal grid max-w-2xl gap-6">
			<div className="flex items-start gap-3">
				<CircleCheck className="mt-0.5 size-5 shrink-0 text-ok-text" />
				<div>
					<h2 className="text-lg font-semibold text-balance">
						{i.customer ?? i.name} is deploying
					</h2>
					<p className="mt-1 text-sm text-pretty text-muted-foreground">
						It is reachable at{" "}
						<span className="font-mono text-foreground">{i.hostname}</span> once
						the first deployment finishes, usually within a minute.
					</p>
				</div>
			</div>

			{adminPassword ? (
				<div className="grid gap-3 rounded-xl bg-card p-5 shadow-card ring-1 ring-border">
					<div>
						<h3 className="text-sm font-medium">First admin</h3>
						<p className="mt-0.5 text-sm text-muted-foreground">
							Sign in as <span className="text-foreground">{adminEmail}</span>{" "}
							with this password.
						</p>
					</div>
					<CopyField value={adminPassword} label="Copy admin password" />
					<p className="text-sm font-medium text-warn-text">
						Shown only once. Save it in your password manager before leaving
						this page.
					</p>
				</div>
			) : (
				<Instructions>
					<p>
						No admin was created. The first person to open the instance goes
						through LSDC's setup wizard, so open it yourself before you share
						the link.
					</p>
				</Instructions>
			)}

			<div className="flex flex-wrap gap-2">
				<Button asChild>
					<Link
						to="/projects/$projectId/services/$serviceId"
						params={{
							projectId: i.projectId,
							serviceId: i.serviceId as ServiceId,
						}}
					>
						<Rocket data-icon="inline-start" />
						Open instance
					</Link>
				</Button>
				<Button asChild variant="ghost">
					<Link to="/lsdc">All instances</Link>
				</Button>
			</div>
		</div>
	);
}

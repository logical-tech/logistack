import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	CalendarClock,
	CalendarRange,
	Infinity as Forever,
	Layers,
	Plus,
	ShieldCheck,
	Timer,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { SecretReveal } from "@/components/access/api-key-secret";
import {
	RoleSelect,
	ScopePicker,
	useScopeOptions,
} from "@/components/access/scope-picker";
import { Field } from "@/components/field";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { useCreateApiKey, useMe, useServiceAccounts } from "@/lib/api/access";
import type {
	CreatedApiKey,
	Me,
	Scope,
	ServiceAccount,
} from "@/lib/api/access-types";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/api-keys_/new")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "New API key" },
	component: NewApiKey,
});

type ScopeRow = { role: string; scope: Scope | null };
type Expiry = "30" | "90" | "365" | "never";

type V = {
	name: string;
	/** "me", or a service account's user id. */
	owner: string;
	access: "all" | "scoped";
	scopes: ScopeRow[];
	expiry: Expiry;
};

const DEFAULTS: V = {
	name: "",
	owner: "me",
	access: "all",
	scopes: [{ role: "developer", scope: null }],
	expiry: "90",
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const EXPIRY: Record<Expiry, string> = {
	"30": "30 days",
	"90": "90 days",
	"365": "1 year",
	never: "Never",
};

const ownerName = (v: V, accounts: ServiceAccount[]) =>
	v.owner === "me"
		? "You"
		: (accounts.find((a) => a.id === v.owner)?.name ?? "Service account");

function ScopeRows({
	w,
	organizationId,
}: {
	w: WizardApi<V>;
	organizationId: string;
}) {
	const rows = w.values.scopes;
	const error = w.error("scopes");
	const update = (i: number, patch: Partial<ScopeRow>) =>
		w.set(
			"scopes",
			rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
		);
	return (
		<div className="grid gap-3">
			<ul className="grid gap-2">
				{rows.map((r, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
						key={i}
						className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg bg-card p-3 ring-1 ring-border sm:grid-cols-[9.5rem_minmax(0,1fr)_auto]"
					>
						<RoleSelect
							aria-label={`Role for scope ${i + 1}`}
							value={r.role}
							onChange={(role) => update(i, { role })}
							exclude={["owner"]}
							className="w-full"
						/>
						{/* Phone: role and remove share the first line, the scope takes the next. */}
						<div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
							<ScopePicker
								id={`wz-scope-${i}`}
								value={r.scope}
								onChange={(scope) => update(i, { scope })}
								organizationId={organizationId}
								invalid={Boolean(error) && !r.scope?.id}
							/>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={`Remove scope ${i + 1}`}
							disabled={rows.length === 1}
							onClick={() =>
								w.set(
									"scopes",
									rows.filter((_, j) => j !== i),
								)
							}
							className="col-start-2 row-start-1 sm:col-start-3"
						>
							<X />
						</Button>
					</li>
				))}
			</ul>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() =>
						w.set("scopes", [...rows, { role: "viewer", scope: null }])
					}
					disabled={rows.length >= 20}
				>
					<Plus data-icon="inline-start" />
					Add scope
				</Button>
				<p
					id="wz-scopes-msg"
					className={error ? "text-xs text-bad-text" : "sr-only"}
					aria-live="polite"
				>
					{error}
				</p>
			</div>
		</div>
	);
}

function OwnerAccess({
	v,
	me,
	accounts,
}: {
	v: V;
	me: Me | undefined;
	accounts: ServiceAccount[];
}) {
	const { labelOf } = useScopeOptions();
	const lines =
		v.owner === "me"
			? (me?.grants ?? []).map(
					(g) =>
						`${capitalize(g.role)} on ${labelOf(g.scope as Scope).replace("Whole organization", "the organization")}`,
				)
			: [
					`${capitalize(accounts.find((a) => a.id === v.owner)?.role ?? "viewer")} on the organization`,
				];
	return (
		<div className="rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40">
			<p className="font-medium">
				{v.owner === "me"
					? "Your access"
					: `${ownerName(v, accounts)}'s access`}
			</p>
			<ul className="mt-1 grid gap-0.5 text-muted-foreground">
				{lines.map((l) => (
					<li key={l}>{l}</li>
				))}
			</ul>
			<p className="mt-2 text-xs text-muted-foreground">
				A key never does more than its owner. Scopes only narrow it.
			</p>
		</div>
	);
}

function buildSteps(
	me: Me | undefined,
	accounts: ServiceAccount[],
): WizardStep<V>[] {
	const organizationId = me?.organizationId ?? "";
	return [
		{
			id: "key",
			title: "Name and owner",
			description:
				"Name it after what uses it. A service account keeps CI working when people leave the team.",
			schema: z.object({
				name: z
					.string()
					.trim()
					.min(1, "Name the key.")
					.max(32, "Keep it to 32 characters."),
			}),
			render: (w) => (
				<div className="grid max-w-md gap-5">
					<Field
						id="wz-name"
						label="Name"
						error={w.error("name")}
						hint="Like storefront-ci or claude-code."
					>
						<Input
							{...w.bind("name")}
							autoComplete="off"
							spellCheck={false}
							placeholder="storefront-ci"
							autoFocus
						/>
					</Field>
					<Field
						id="wz-owner"
						label="Owner"
						hint="The key acts as its owner, within the scopes you pick next."
					>
						<Select
							value={w.values.owner}
							onValueChange={(o) => w.set("owner", o)}
						>
							<SelectTrigger id="wz-owner" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="me">You</SelectItem>
								{accounts.map((a) => (
									<SelectItem key={a.id} value={a.id}>
										{a.name}
										<span className="text-muted-foreground">
											Service account
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				</div>
			),
		},
		{
			id: "access",
			title: "Access",
			description:
				"Give the key the least it needs. An action is allowed only where both the owner and the key's scopes allow it.",
			schema: (v) =>
				v.access === "all"
					? z.object({})
					: z.object({
							scopes: z
								.array(
									z.object({
										role: z.string().min(1),
										scope: z.object({
											kind: z.string(),
											id: z.string().min(1),
										}),
									}),
								)
								.min(1),
						}),
			render: (w) => (
				<div className="grid gap-5">
					<ChoiceGroup
						label="Access"
						value={w.values.access}
						onChange={(a) => w.set("access", a)}
						choices={[
							{
								value: "all",
								title: "Everything the owner can do",
								description:
									"Follows the owner's roles, now and as they change.",
								icon: ShieldCheck,
							},
							{
								value: "scoped",
								title: "Limit to scopes",
								description:
									"A role on a folder, project, environment or service.",
								icon: Layers,
							},
						]}
					/>
					{w.values.access === "scoped" && (
						<ScopeRows w={w} organizationId={organizationId} />
					)}
					<OwnerAccess v={w.values} me={me} accounts={accounts} />
				</div>
			),
		},
		{
			id: "expiry",
			title: "Expiry",
			description:
				"An expiring key limits the damage of one that leaks. Rotate it before it runs out.",
			render: (w) => (
				<ChoiceGroup
					label="Expiry"
					columns={4}
					value={w.values.expiry}
					onChange={(e) => w.set("expiry", e)}
					choices={[
						{
							value: "30",
							title: "30 days",
							description: "For a trial or a short job.",
							icon: Timer,
						},
						{
							value: "90",
							title: "90 days",
							description: "A sensible default for CI.",
							icon: CalendarClock,
						},
						{
							value: "365",
							title: "1 year",
							description: "Long-lived automation.",
							icon: CalendarRange,
						},
						{
							value: "never",
							title: "Never",
							description: "Until you revoke it.",
							icon: Forever,
						},
					]}
				/>
			),
		},
		{
			id: "review",
			title: "Review",
			description: "The secret appears once, on the next screen.",
			render: (w) => <ScopeSummary w={w} accounts={accounts} />,
		},
	];
}

function ScopeSummary({
	w,
	accounts,
}: {
	w: WizardApi<V>;
	accounts: ServiceAccount[];
}) {
	const { labelOf } = useScopeOptions();
	const v = w.values;
	return (
		<Summary
			w={w}
			sections={[
				{
					stepId: "key",
					title: "Name and owner",
					rows: [
						{ label: "Name", value: v.name.trim() },
						{ label: "Owner", value: ownerName(v, accounts) },
					],
				},
				{
					stepId: "access",
					title: "Access",
					rows:
						v.access === "all"
							? [{ label: "Scopes", value: "Everything the owner can do" }]
							: v.scopes.map((s, i) => ({
									label: v.scopes.length > 1 ? `Scope ${i + 1}` : "Scope",
									value: s.scope
										? `${capitalize(s.role)} on ${labelOf(s.scope)}`
										: "",
								})),
				},
				{
					stepId: "expiry",
					title: "Expiry",
					rows: [{ label: "Expires", value: EXPIRY[v.expiry] }],
				},
			]}
		/>
	);
}

function NewApiKey() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: me } = useMe();
	const { data: accounts } = useServiceAccounts();
	const create = useCreateApiKey();
	const [created, setCreated] = useState<CreatedApiKey | null>(null);
	const { reset } = create;
	// The secret lives only in this component's state: clear the mutation cache's copy on leave.
	useEffect(() => reset, [reset]);

	const steps = useMemo(
		() => (accounts ? buildSteps(me, accounts) : []),
		[me, accounts],
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	if (created)
		return (
			<Page className="max-w-2xl">
				<PageHeader
					title="Key created"
					description={
						<>
							<span className="text-foreground">{created.name}</span> is ready.
							Store the secret somewhere safe before you leave this page.
						</>
					}
				/>
				<div className="t-reveal">
					<SecretReveal created={created} />
				</div>
				<div className="mt-8 flex justify-end border-t pt-5">
					<Button asChild size="lg">
						<Link to="/settings/api-keys">Done</Link>
					</Button>
				</div>
			</Page>
		);

	if (!accounts) return null;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="New API key"
				description="For the REST API, the CLI and the MCP server."
			/>
			<Wizard
				id="new-api-key"
				steps={steps}
				defaultValues={DEFAULTS}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Create key"
				onComplete={async (v) => {
					const key = await create.mutateAsync({
						name: v.name.trim(),
						...(v.owner !== "me" && { ownerId: v.owner }),
						...(v.access === "scoped" && {
							scopes: v.scopes.flatMap((s) =>
								s.scope ? [{ role: s.role, scope: s.scope }] : [],
							),
						}),
						...(v.expiry !== "never" && { expiresInDays: Number(v.expiry) }),
					});
					reset();
					setCreated(key);
					toast.success(`${key.name} created`);
				}}
			/>
		</Page>
	);
}

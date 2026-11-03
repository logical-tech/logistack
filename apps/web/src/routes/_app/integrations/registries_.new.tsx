import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { REGISTRY_KIND } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { integrations, useCreateRegistry } from "@/lib/api/integrations";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/integrations/registries_/new")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Add registry" },
	component: AddRegistry,
});

type Kind = "ghcr" | "dockerhub" | "generic";

type V = {
	kind: Kind;
	username: string;
	password: string;
	namespace: string;
	host: string;
	isDefault: boolean;
	keepTags: string;
};

const DEFAULTS: V = {
	kind: "ghcr",
	username: "",
	password: "",
	namespace: "",
	host: "",
	isDefault: false,
	keepTags: "10",
};

const ADDRESS = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/i;
const NAMESPACE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Host plus namespace, the form the server stores: ghcr.io/acme, docker.io/acme. */
function registryUrl(v: V) {
	if (v.kind === "ghcr")
		return `ghcr.io/${(v.namespace.trim() || v.username.trim()).toLowerCase()}`;
	if (v.kind === "dockerhub")
		return `docker.io/${v.namespace.trim().toLowerCase()}`;
	return v.host
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
}

const credentials = (v: V) =>
	v.username.trim() && v.password
		? { username: v.username.trim(), password: v.password }
		: {};

const STEPS: WizardStep<V>[] = [
	{
		id: "kind",
		title: "Choose a registry",
		description: "Builds push images here and every node pulls them from here.",
		render: (w) => (
			<ChoiceGroup
				label="Registry"
				columns={1}
				value={w.values.kind}
				onChange={(k) => w.set("kind", k)}
				choices={[
					{
						value: "ghcr",
						title: "GitHub Container Registry",
						description: "ghcr.io, with a personal access token.",
						icon: REGISTRY_KIND.ghcr.icon,
					},
					{
						value: "dockerhub",
						title: "Docker Hub",
						description: "docker.io, with a personal access token.",
						icon: REGISTRY_KIND.dockerhub.icon,
					},
					{
						value: "generic",
						title: "Any OCI registry",
						description:
							"GitLab, Harbor, Zot, ECR behind a proxy, or your own registry:2.",
						icon: REGISTRY_KIND.generic.icon,
					},
				]}
			/>
		),
	},
	{
		id: "credentials",
		title: "Credentials",
		description: "Stored encrypted. Nodes use them to pull, builds to push.",
		schema: (v) => {
			if (v.kind === "ghcr")
				return z.object({
					username: z
						.string()
						.trim()
						.regex(/^[a-z\d](?:[a-z\d-]{0,38})$/i, "Use your GitHub username."),
					password: z.string().min(1, "Paste the token."),
					namespace: z
						.string()
						.trim()
						.regex(
							/^$|^[a-z\d](?:[a-z\d-]{0,38})$/i,
							"Use a user or organization login.",
						),
				});
			if (v.kind === "dockerhub")
				return z.object({
					namespace: z
						.string()
						.trim()
						.regex(NAMESPACE, "Use your Docker ID or an organization name."),
					username: z.string().trim().min(1, "Enter your Docker ID."),
					password: z.string().min(1, "Paste the access token."),
				});
			return z
				.object({
					host: z
						.string()
						.trim()
						.transform((h) => h.replace(/^https?:\/\//, "").replace(/\/+$/, ""))
						.pipe(
							z
								.string()
								.regex(
									ADDRESS,
									"Use host[:port][/namespace], like registry.example.com/acme",
								),
						),
					username: z.string(),
					password: z.string(),
				})
				.refine((c) => Boolean(c.username.trim()) === Boolean(c.password), {
					message: "Enter both a username and a password, or neither.",
					path: ["password"],
				});
		},
		render: (w) => <CredentialsStep w={w} />,
	},
	{
		id: "test",
		title: "Test push and pull",
		description: "Nothing is saved until the test passes and you confirm.",
		testKeys: ["kind", "host", "namespace", "username", "password"],
		test: (v) =>
			integrations.registries.test({ url: registryUrl(v), ...credentials(v) }),
		render: (w) => (
			<div className="grid gap-4">
				<TestPanel
					w={w}
					action="Run test"
					idle={
						<>
							We'll log in, push a tiny image to{" "}
							<span className="font-mono text-xs text-foreground">
								{registryUrl(w.values)}/logistack-check
							</span>{" "}
							and pull it back.
						</>
					}
				/>
				<p className="text-sm text-muted-foreground">
					The test leaves a few-hundred-byte{" "}
					<span className="font-mono text-xs text-foreground">
						logistack-check
					</span>{" "}
					{w.values.kind === "ghcr" ? "package" : "repository"} behind. Delete
					it whenever you like.
				</p>
			</div>
		),
	},
	{
		id: "options",
		title: "Options",
		description: "Both can be changed later from the registry list.",
		schema: z.object({
			keepTags: z
				.string()
				.regex(/^\d+$/, "Use a number.")
				.refine(
					(n) => Number(n) >= 1 && Number(n) <= 500,
					"Keep between 1 and 500.",
				),
		}),
		render: (w) => (
			<div className="grid gap-5">
				<label
					htmlFor="wz-isDefault"
					className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
				>
					<span>
						<span className="block font-medium">Make it the default</span>
						<span className="text-muted-foreground">
							New builds push here instead of the current default.
						</span>
					</span>
					<Switch
						id="wz-isDefault"
						checked={w.values.isDefault}
						onCheckedChange={(c) => w.set("isDefault", c)}
					/>
				</label>
				<Field
					id="wz-keepTags"
					label="Images to keep"
					error={w.error("keepTags")}
					hint="The newest images of each service survive the hourly prune. Older ones are deleted, so rollbacks reach this far back."
				>
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						Keep last
						<Input
							{...w.bind("keepTags")}
							inputMode="numeric"
							className="w-20 tabular"
						/>
						per service
					</div>
				</Field>
			</div>
		),
	},
	{
		id: "review",
		title: "Review",
		description: "The registry is added when you confirm.",
		render: (w) => {
			const v = w.values;
			return (
				<Summary
					w={w}
					sections={[
						{
							stepId: "credentials",
							title: REGISTRY_KIND[v.kind].label,
							rows: [
								{
									label: "Address",
									value: (
										<span className="font-mono text-xs">{registryUrl(v)}</span>
									),
								},
								{
									label: "Sign in as",
									value: v.username.trim() || "Anonymous",
								},
							],
						},
						{
							stepId: "options",
							title: "Options",
							rows: [
								{ label: "Default", value: v.isDefault ? "Yes" : "No" },
								{
									label: "Retention",
									value: `Last ${v.keepTags} images per service`,
								},
							],
						},
					]}
				/>
			);
		},
	},
];

function CredentialsStep({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const secret = (label: string, placeholder?: string) => (
		<Field id="wz-password" label={label} error={w.error("password")}>
			<Input
				{...w.bind("password")}
				type="password"
				autoComplete="off"
				spellCheck={false}
				className="font-mono"
				placeholder={placeholder}
			/>
		</Field>
	);
	const user = (label: string, hint?: string, autoFocus?: boolean) => (
		<Field
			id="wz-username"
			label={label}
			hint={hint}
			error={w.error("username")}
		>
			<Input
				{...w.bind("username")}
				autoCapitalize="none"
				autoComplete="off"
				spellCheck={false}
				autoFocus={autoFocus}
			/>
		</Field>
	);

	if (v.kind === "ghcr")
		return (
			<div className="grid gap-5">
				<Instructions
					href="https://github.com/settings/tokens/new?scopes=write:packages"
					link="Create a token on GitHub"
				>
					<p>
						Create a <strong>classic</strong> personal access token with{" "}
						<strong>write:packages</strong>.
					</p>
					<p>
						Optional: <strong>read:packages</strong> to pull private images from
						other accounts, <strong>delete:packages</strong> so retention can
						remove old images.
					</p>
				</Instructions>
				<div className="grid gap-5 sm:grid-cols-2">
					{user("GitHub username", undefined, true)}
					{secret("Personal access token", "ghp_…")}
				</div>
				<Field
					id="wz-namespace"
					label="Namespace"
					optional
					error={w.error("namespace")}
					hint={`Your user or an organization. Images go to ${registryUrl(v) || "ghcr.io/<namespace>"}/<service>.`}
				>
					<Input
						{...w.bind("namespace")}
						placeholder={v.username.trim() || "acme-retail"}
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
			</div>
		);

	if (v.kind === "dockerhub")
		return (
			<div className="grid gap-5">
				<Instructions
					href="https://app.docker.com/settings/personal-access-tokens"
					link="Create a token on Docker Hub"
				>
					<p>
						Create a personal access token with{" "}
						<strong>Read &amp; Write</strong> access. Use{" "}
						<strong>Read, Write &amp; Delete</strong> if retention should remove
						old images.
					</p>
				</Instructions>
				<Field
					id="wz-namespace"
					label="Namespace"
					error={w.error("namespace")}
					hint={`Your Docker ID or an organization. Images go to docker.io/${v.namespace.trim().toLowerCase() || "<namespace>"}/<service>.`}
				>
					<Input
						{...w.bind("namespace")}
						placeholder="acmeretail"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
						autoFocus
					/>
				</Field>
				<div className="grid gap-5 sm:grid-cols-2">
					{user("Docker ID")}
					{secret("Access token", "dckr_pat_…")}
				</div>
			</div>
		);

	return (
		<div className="grid gap-5">
			<Field
				id="wz-host"
				label="Address"
				error={w.error("host")}
				hint="Host, optional port and namespace, like registry.example.com:5000/acme. HTTPS is required."
			>
				<Input
					{...w.bind("host")}
					placeholder="registry.example.com/acme"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
					autoFocus
				/>
			</Field>
			<div className="grid gap-5 sm:grid-cols-2">
				{user("Username", "Leave both empty for an open registry.")}
				{secret("Password or token")}
			</div>
		</div>
	);
}

function AddRegistry() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const create = useCreateRegistry();
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add a registry"
				description="Login, push and pull are tested before anything is saved."
			/>
			<Wizard
				id="add-registry"
				steps={STEPS}
				defaultValues={DEFAULTS}
				secretKeys={["password"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Add registry"
				onComplete={async (v) => {
					const url = registryUrl(v);
					await create.mutateAsync({
						kind: v.kind,
						url,
						...credentials(v),
						isDefault: v.isDefault,
						keepTags: Number(v.keepTags),
					});
					toast.success(`${url} added`, {
						description: v.isDefault
							? "New builds push here."
							: "Make it the default from the registry list when you're ready.",
					});
					await navigate({ to: "/integrations/registries" });
				}}
			/>
		</Page>
	);
}

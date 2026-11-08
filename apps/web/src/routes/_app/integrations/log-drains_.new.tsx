import {
	datadogSites,
	LogDrainConfig,
	type LogDrainKind,
	logDrainKinds,
} from "@logistack/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import {
	type DrainScope,
	DrainScopePicker,
	scopeSummary,
} from "@/components/integrations/drain-scope";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { logDrainsApi } from "@/lib/api/log-drains";
import { useInvalidating } from "@/lib/api/networking";
import { DRAIN_KINDS } from "@/lib/integrations";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/integrations/log-drains_/new")({
	staticData: { crumb: "Add drain" },
	validateSearch: z.object({ step: stepParam }),
	component: NewDrain,
});

type Auth = "none" | "basic" | "bearer";
type V = {
	kind: LogDrainKind;
	url: string;
	tenantId: string;
	auth: Auth;
	username: string;
	password: string;
	token: string;
	/** One `Name: value` per line. */
	headers: string;
	site: string;
	apiKey: string;
	host: string;
	port: string;
	protocol: "tcp" | "tls" | "udp";
	scope: DrainScope;
	name: string;
};

const DEFAULTS: V = {
	kind: "loki",
	url: "",
	tenantId: "",
	auth: "none",
	username: "",
	password: "",
	token: "",
	headers: "",
	site: "datadoghq.com",
	apiKey: "",
	host: "",
	port: "514",
	protocol: "tcp",
	scope: { projectIds: [], serviceIds: [] },
	name: "",
};

const opt = (s: string) => s.trim() || undefined;

function parseHeaders(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf(":");
		if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return out;
}

/** The API's own schema decides; the form only shapes the answers into it. */
function toConfig(v: V): unknown {
	switch (v.kind) {
		case "loki":
			return {
				kind: "loki",
				url: v.url.trim(),
				tenantId: opt(v.tenantId),
				...(v.auth === "basic"
					? { username: v.username.trim(), password: v.password }
					: {}),
				...(v.auth === "bearer" ? { bearerToken: opt(v.token) } : {}),
			};
		case "otlp":
		case "http":
			return {
				kind: v.kind,
				url: v.url.trim(),
				headers: parseHeaders(v.headers),
			};
		case "datadog":
			return { kind: "datadog", site: v.site, apiKey: v.apiKey.trim() };
		case "syslog":
			return {
				kind: "syslog",
				host: v.host.trim(),
				port: Number(v.port),
				protocol: v.protocol,
			};
	}
}

const FIELD_OF: Record<string, keyof V> = {
	bearerToken: "token",
};

const connectSchema = (v: V) =>
	z.any().superRefine((_, ctx) => {
		if (v.kind === "loki" && v.auth === "basic" && !v.username.trim())
			ctx.addIssue({
				code: "custom",
				path: ["username"],
				message: "Required.",
			});
		const parsed = LogDrainConfig.safeParse(toConfig(v));
		if (parsed.success) return;
		for (const issue of parsed.error.issues) {
			const key = String(issue.path[0] ?? "url");
			ctx.addIssue({
				code: "custom",
				path: [FIELD_OF[key] ?? key],
				message:
					key === "url"
						? "An http:// or https:// URL."
						: key === "port"
							? "A port from 1 to 65535."
							: key === "headers"
								? "One “Name: value” per line; names use letters, digits and dashes."
								: issue.message,
			});
		}
	});

function Select2<T extends string>({
	id,
	value,
	onChange,
	options,
}: {
	id: string;
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<Select value={value} onValueChange={(x) => onChange(x as T)}>
			<SelectTrigger id={id} className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function ConnectFields({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const url = (placeholder: string, hint: string) => (
		<Field id="wz-url" label="URL" hint={hint} error={w.error("url")}>
			<Input {...w.bind("url")} placeholder={placeholder} autoFocus />
		</Field>
	);
	const headers = (
		<Field
			id="wz-headers"
			label="Headers"
			optional
			hint="One “Name: value” per line, for example Authorization: Bearer …"
			error={w.error("headers")}
		>
			<Textarea
				{...w.bind("headers")}
				rows={3}
				className="font-mono text-xs"
				spellCheck={false}
			/>
		</Field>
	);
	return (
		<div className="grid max-w-md gap-4">
			{v.kind === "loki" && (
				<>
					{url(
						"https://loki.example.com",
						"The base URL; LogiStack adds /loki/api/v1/push.",
					)}
					<Field
						id="wz-tenantId"
						label="Tenant ID"
						optional
						hint="Sent as X-Scope-OrgID, for multi-tenant Loki and Grafana Cloud."
					>
						<Input {...w.bind("tenantId")} />
					</Field>
					<Field id="wz-auth" label="Authentication">
						<Select2
							id="wz-auth"
							value={v.auth}
							onChange={(a) => w.set("auth", a)}
							options={[
								{ value: "none", label: "None" },
								{ value: "basic", label: "Username and password" },
								{ value: "bearer", label: "Bearer token" },
							]}
						/>
					</Field>
					{v.auth === "basic" && (
						<>
							<Field
								id="wz-username"
								label="Username"
								hint="On Grafana Cloud, the Loki instance ID."
								error={w.error("username")}
							>
								<Input {...w.bind("username")} autoComplete="off" />
							</Field>
							<Field id="wz-password" label="Password">
								<Input
									{...w.bind("password")}
									type="password"
									autoComplete="new-password"
								/>
							</Field>
						</>
					)}
					{v.auth === "bearer" && (
						<Field id="wz-token" label="Token" error={w.error("token")}>
							<Input
								{...w.bind("token")}
								type="password"
								autoComplete="new-password"
							/>
						</Field>
					)}
				</>
			)}
			{v.kind === "otlp" && (
				<>
					{url(
						"https://otel-collector.example.com:4318",
						"The collector's OTLP/HTTP base URL; LogiStack adds /v1/logs.",
					)}
					{headers}
				</>
			)}
			{v.kind === "http" && (
				<>
					{url(
						"https://in.logs.example.com/ingest",
						"Each batch is POSTed here as a JSON array.",
					)}
					{headers}
				</>
			)}
			{v.kind === "datadog" && (
				<>
					<Field
						id="wz-site"
						label="Site"
						hint="Where your Datadog account lives."
					>
						<Select2
							id="wz-site"
							value={v.site}
							onChange={(s) => w.set("site", s)}
							options={datadogSites.map((s) => ({ value: s, label: s }))}
						/>
					</Field>
					<Field
						id="wz-apiKey"
						label="API key"
						hint="Organization Settings → API Keys. An API key, not an application key."
						error={w.error("apiKey")}
					>
						<Input
							{...w.bind("apiKey")}
							type="password"
							autoComplete="new-password"
							autoFocus
						/>
					</Field>
				</>
			)}
			{v.kind === "syslog" && (
				<>
					<Field id="wz-host" label="Host" error={w.error("host")}>
						<Input
							{...w.bind("host")}
							placeholder="logs.papertrailapp.com"
							autoFocus
						/>
					</Field>
					<div className="grid grid-cols-2 gap-4">
						<Field id="wz-port" label="Port" error={w.error("port")}>
							<Input {...w.bind("port")} inputMode="numeric" />
						</Field>
						<Field id="wz-protocol" label="Transport">
							<Select2
								id="wz-protocol"
								value={v.protocol}
								onChange={(p) => w.set("protocol", p)}
								options={[
									{ value: "tcp", label: "TCP" },
									{ value: "tls", label: "TLS" },
									{ value: "udp", label: "UDP" },
								]}
							/>
						</Field>
					</div>
				</>
			)}
		</div>
	);
}

function NewDrain() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const create = useInvalidating(logDrainsApi.create, [["log-drains"]]);

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "kind",
				title: "Where should logs go?",
				description:
					"Each node ships its own containers' logs straight to the destination, in batches.",
				render: (w) => (
					<ChoiceGroup
						label="Destination"
						value={w.values.kind}
						onChange={(kind) => w.set("kind", kind)}
						choices={logDrainKinds.map((k) => ({
							value: k,
							title: DRAIN_KINDS[k].label,
							description: DRAIN_KINDS[k].blurb,
							icon: DRAIN_KINDS[k].icon,
						}))}
					/>
				),
			},
			{
				id: "connect",
				title: "Connect it",
				description:
					"Credentials are encrypted at rest and only ever sent to the node agents.",
				schema: connectSchema,
				render: (w) => <ConnectFields w={w} />,
			},
			{
				id: "test",
				title: "Send a test event",
				description:
					"One line goes out from a node now, the same way service logs will.",
				testKeys: [
					"kind",
					"url",
					"tenantId",
					"auth",
					"username",
					"password",
					"token",
					"headers",
					"site",
					"apiKey",
					"host",
					"port",
					"protocol",
				],
				test: async (v) => {
					try {
						const r = await logDrainsApi.testConfig(toConfig(v));
						return r.ok
							? {
									ok: true,
									message: `Delivered to ${DRAIN_KINDS[v.kind].label}`,
									detail:
										"Look for service “logistack-test” with the line “LogiStack test event”.",
								}
							: {
									ok: false,
									message: r.status
										? `The destination answered ${r.status}`
										: "The test event didn't arrive",
									detail: `${r.error ?? ""} Sent from node ${r.nodeId}.`.trim(),
								};
					} catch (err) {
						return {
							ok: false,
							message: "The test event didn't go out",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<TestPanel
						w={w}
						action="Send test event"
						idle={`We'll send “LogiStack test event: this drain is reachable.” to ${DRAIN_KINDS[w.values.kind].label}.`}
					/>
				),
			},
			{
				id: "scope",
				title: "Which logs?",
				description:
					"A whole project includes services added to it later. Logs carry organization, project, environment, service, deployment and node.",
				schema: z.object({
					scope: z
						.object({
							projectIds: z.array(z.string()),
							serviceIds: z.array(z.string()),
						})
						.refine(
							(s) => s.projectIds.length + s.serviceIds.length > 0,
							"Pick at least one project or service.",
						),
				}),
				render: (w) => (
					<div className="grid gap-2">
						<DrainScopePicker
							value={w.values.scope}
							onChange={(s) => w.set("scope", s)}
							invalid={Boolean(w.error("scope"))}
						/>
						{w.error("scope") && (
							<p className="text-xs text-bad-text" aria-live="polite">
								{w.error("scope")}
							</p>
						)}
					</div>
				),
			},
			{
				id: "name",
				title: "Name it",
				description: "Health and delivery errors refer to it by this name.",
				schema: z.object({
					name: z.string().trim().min(1, "Give the drain a name.").max(100),
				}),
				render: (w) => (
					<div className="grid max-w-md gap-4">
						<Field id="wz-name" label="Name" error={w.error("name")}>
							<Input
								{...w.bind("name")}
								autoFocus
								placeholder={`${DRAIN_KINDS[w.values.kind].label} production`}
							/>
						</Field>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and add",
				description:
					"Agents pick it up within seconds. A destination that goes down shows on the drain's health; containers never wait for it.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "kind",
								title: "Destination",
								rows: [
									{ label: "Kind", value: DRAIN_KINDS[w.values.kind].label },
									{ label: "Test event", value: "Delivered" },
								],
							},
							{
								stepId: "scope",
								title: "Logs",
								rows: [{ label: "From", value: scopeSummary(w.values.scope) }],
							},
							{
								stepId: "name",
								title: "Drain",
								rows: [{ label: "Name", value: w.values.name }],
							},
						]}
					/>
				),
			},
		],
		[],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add a log drain"
				description="Ship service logs to the observability tool your team already uses, with retention you control."
			/>
			<Wizard<V>
				id="log-drain"
				steps={steps}
				defaultValues={DEFAULTS}
				secretKeys={["password", "token", "apiKey", "headers"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Add drain"
				onComplete={async (v) => {
					const d = await create.mutateAsync({
						name: v.name.trim(),
						config: toConfig(v),
						enabled: true,
						...v.scope,
					});
					toast.success(`${d.name} added`, {
						description: "Logs start arriving within a few seconds.",
					});
					await navigate({ to: "/integrations/log-drains" });
				}}
			/>
		</Page>
	);
}

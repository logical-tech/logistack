import { useMutation } from "@tanstack/react-query";
import {
	CalendarClock,
	CircleAlert,
	CircleCheck,
	Globe,
	Loader2,
	Network,
	ShieldCheck,
	Webhook,
} from "lucide-react";
import { z } from "zod";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	type SummarySection,
} from "@/components/wizard/parts";
import type { WizardApi, WizardStep } from "@/components/wizard/wizard";
import {
	KIND_LABEL,
	type Monitor,
	type MonitorConfig,
	type MonitorInput,
	type MonitorKind,
	monitorTarget,
	uptimeApi,
} from "@/lib/api/uptime";

// Answers are kept flat and as text, the way the wizard binds inputs; `toInput` builds the API body.
export type MonitorValues = {
	kind: MonitorKind | "";
	name: string;
	url: string;
	method: string;
	headers: string;
	statusCodes: string;
	keyword: string;
	keywordInvert: boolean;
	jsonPath: string;
	jsonEquals: string;
	maxLatencyMs: string;
	followRedirects: boolean;
	host: string;
	port: string;
	dnsHostname: string;
	recordType: string;
	resolver: string;
	expected: string;
	warnDays: string;
	graceSec: string;
	intervalSec: string;
	retryIntervalSec: string;
	timeoutMs: string;
	downAfter: string;
	upAfter: string;
	resendMinutes: string;
	autoIncident: boolean;
	domainId: string;
	serviceId: string;
	projectId: string;
};

export const emptyMonitor: MonitorValues = {
	kind: "",
	name: "",
	url: "https://",
	method: "GET",
	headers: "",
	statusCodes: "2xx",
	keyword: "",
	keywordInvert: false,
	jsonPath: "",
	jsonEquals: "",
	maxLatencyMs: "",
	followRedirects: true,
	host: "",
	port: "",
	dnsHostname: "",
	recordType: "A",
	resolver: "",
	expected: "",
	warnDays: "30, 14, 7, 1",
	graceSec: "60",
	intervalSec: "60",
	retryIntervalSec: "20",
	timeoutMs: "10000",
	downAfter: "3",
	upAfter: "1",
	resendMinutes: "0",
	autoIncident: true,
	domainId: "",
	serviceId: "",
	projectId: "",
};

/** The answers an existing monitor gives, for the edit flow. */
export function valuesOf(m: Monitor): MonitorValues {
	const c = m.config;
	const v: MonitorValues = {
		...emptyMonitor,
		kind: c.kind,
		name: m.name,
		intervalSec: String(m.intervalSec),
		retryIntervalSec: String(m.retryIntervalSec),
		timeoutMs: String(m.timeoutMs),
		downAfter: String(m.downAfter),
		upAfter: String(m.upAfter),
		resendMinutes: String(m.resendMinutes),
		autoIncident: m.autoIncident,
		domainId: m.domainId ?? "",
		serviceId: m.serviceId ?? "",
		projectId: m.projectId ?? "",
	};
	if (c.kind === "http")
		Object.assign(v, {
			url: c.http.url,
			method: c.http.method,
			headers: (c.http.headers ?? [])
				.map((h) => `${h.name}: ${h.value}`)
				.join("\n"),
			statusCodes: (c.http.statusCodes ?? ["2xx"]).join(", "),
			keyword: c.http.keyword?.value ?? "",
			keywordInvert: c.http.keyword?.invert ?? false,
			jsonPath: c.http.jsonPath?.path ?? "",
			jsonEquals: c.http.jsonPath?.equals ?? "",
			maxLatencyMs: c.http.maxLatencyMs ? String(c.http.maxLatencyMs) : "",
			followRedirects: c.http.followRedirects ?? true,
		});
	if (c.kind === "tcp")
		Object.assign(v, { host: c.tcp.host, port: String(c.tcp.port) });
	if (c.kind === "tls")
		Object.assign(v, {
			host: c.tls.host,
			port: String(c.tls.port ?? 443),
			warnDays: (c.tls.warnDays ?? [30, 14, 7, 1]).join(", "),
		});
	if (c.kind === "dns")
		Object.assign(v, {
			dnsHostname: c.dns.hostname,
			recordType: c.dns.recordType,
			resolver: c.dns.resolver ?? "",
			expected: c.dns.expected ?? "",
		});
	if (c.kind === "push") v.graceSec = String(c.push.graceSec ?? 60);
	return v;
}

const list = (s: string) =>
	s
		.split(/[,\s]+/)
		.map((x) => x.trim())
		.filter(Boolean);

const headerLines = (s: string) =>
	s
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const i = l.indexOf(":");
			return { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
		});

export function toConfig(v: MonitorValues): MonitorConfig {
	switch (v.kind) {
		case "tcp":
			return {
				kind: "tcp",
				tcp: { host: v.host.trim(), port: Number(v.port) },
			};
		case "tls":
			return {
				kind: "tls",
				tls: {
					host: v.host.trim(),
					port: Number(v.port || 443),
					warnDays: list(v.warnDays).map(Number),
				},
			};
		case "dns":
			return {
				kind: "dns",
				dns: {
					hostname: v.dnsHostname.trim(),
					recordType: v.recordType as "A",
					...(v.resolver.trim() && { resolver: v.resolver.trim() }),
					...(v.expected.trim() && { expected: v.expected.trim() }),
				},
			};
		case "push":
			return { kind: "push", push: { graceSec: Number(v.graceSec || 0) } };
		default:
			return {
				kind: "http",
				http: {
					url: v.url.trim(),
					method: v.method as "GET",
					headers: headerLines(v.headers),
					statusCodes: list(v.statusCodes),
					followRedirects: v.followRedirects,
					...(v.keyword && {
						keyword: {
							value: v.keyword,
							invert: v.keywordInvert,
							caseSensitive: false,
						},
					}),
					...(v.jsonPath.trim() && {
						jsonPath: { path: v.jsonPath.trim(), equals: v.jsonEquals },
					}),
					...(v.maxLatencyMs && { maxLatencyMs: Number(v.maxLatencyMs) }),
				},
			};
	}
}

export function toInput(v: MonitorValues): MonitorInput {
	return {
		name: v.name.trim(),
		config: toConfig(v),
		intervalSec: Number(v.intervalSec),
		retryIntervalSec: Number(v.retryIntervalSec),
		timeoutMs: Number(v.timeoutMs),
		downAfter: Number(v.downAfter),
		upAfter: Number(v.upAfter),
		resendMinutes: Number(v.resendMinutes),
		autoIncident: v.autoIncident,
		...(v.domainId && { domainId: v.domainId }),
		...(v.serviceId && { serviceId: v.serviceId }),
		...(v.projectId && { projectId: v.projectId }),
	};
}

const intIn = (min: number, max: number, what: string) =>
	z
		.string()
		.trim()
		.regex(/^\d+$/, `${what} is a whole number.`)
		.refine(
			(s) => Number(s) >= min && Number(s) <= max,
			`${what}: ${min} to ${max}.`,
		);

const hostname = z
	.string()
	.trim()
	.min(1, "Enter a hostname or IP address.")
	.regex(
		/^[a-zA-Z0-9.:[\]-]+$/,
		"A hostname like db.example.com, or an IP address.",
	);

const name = z.string().trim().min(1, "Name the monitor.").max(100);

function targetSchema(v: MonitorValues): z.ZodType {
	switch (v.kind) {
		case "tcp":
			return z.object({ name, host: hostname, port: intIn(1, 65_535, "Port") });
		case "tls":
			return z.object({
				name,
				host: hostname,
				port: intIn(1, 65_535, "Port"),
				warnDays: z
					.string()
					.refine(
						(s) =>
							list(s).length > 0 &&
							list(s).length <= 5 &&
							list(s).every((d) => /^\d+$/.test(d) && +d >= 1 && +d <= 365),
						"Up to five day counts between 1 and 365, like 30, 14, 7.",
					),
			});
		case "dns":
			return z.object({
				name,
				dnsHostname: hostname,
				resolver: z
					.string()
					.trim()
					.refine(
						(s) => !s || z.ipv4().or(z.ipv6()).safeParse(s).success,
						"An IP address, like 1.1.1.1.",
					),
			});
		case "push":
			return z.object({ name, graceSec: intIn(0, 86_400, "Grace") });
		default:
			return z.object({
				name,
				url: z
					.string()
					.trim()
					.refine(
						(s) => /^https?:\/\/[^/\s]+/.test(s),
						"A full URL starting with https:// or http://.",
					),
				statusCodes: z
					.string()
					.refine(
						(s) =>
							list(s).length > 0 &&
							list(s).every((p) =>
								/^([1-5]xx|[1-5]\d\d(-[1-5]\d\d)?)$/.test(p),
							),
						"Codes like 200, 200-299 or 2xx, separated by commas.",
					),
				headers: z
					.string()
					.refine(
						(s) =>
							headerLines(s).every((h) => /^[A-Za-z0-9-]{1,64}$/.test(h.name)),
						"One header per line, as Name: value.",
					),
				maxLatencyMs: z
					.string()
					.trim()
					.refine(
						(s) => !s || (/^\d+$/.test(s) && +s >= 1 && +s <= 60_000),
						"Milliseconds, 1 to 60000.",
					),
			});
	}
}

const KINDS = [
	{
		value: "http" as const,
		title: "Website or API",
		description:
			"Requests a URL and checks the status code, body or response time.",
		icon: Globe,
	},
	{
		value: "tcp" as const,
		title: "TCP port",
		description:
			"Opens a connection to a port, like a database or mail server.",
		icon: Network,
	},
	{
		value: "dns" as const,
		title: "DNS record",
		description: "Resolves a name and checks the answer is there and correct.",
		icon: Webhook,
	},
	{
		value: "tls" as const,
		title: "Certificate expiry",
		description:
			"Warns before a TLS certificate expires, and fails once it has.",
		icon: ShieldCheck,
	},
	{
		value: "push" as const,
		title: "Cron job heartbeat",
		description: "Your job calls a URL when it runs. Silence means it did not.",
		icon: CalendarClock,
	},
];

function TextField({
	w,
	k,
	label,
	hint,
	placeholder,
	optional,
	inputMode,
	className,
}: {
	w: WizardApi<MonitorValues>;
	k: keyof MonitorValues & string;
	label: string;
	hint?: string;
	placeholder?: string;
	optional?: boolean;
	inputMode?: "numeric";
	className?: string;
}) {
	return (
		<Field
			id={`wz-${k}`}
			label={label}
			hint={hint}
			error={w.error(k)}
			optional={optional}
			className={className}
		>
			<Input
				{...w.bind(k)}
				placeholder={placeholder}
				inputMode={inputMode}
				className={inputMode ? "max-w-40 tabular" : undefined}
			/>
		</Field>
	);
}

function Toggle({
	w,
	k,
	label,
	hint,
}: {
	w: WizardApi<MonitorValues>;
	k: "keywordInvert" | "followRedirects" | "autoIncident";
	label: string;
	hint: string;
}) {
	return (
		<label
			htmlFor={`wz-${k}`}
			className="flex cursor-pointer items-start justify-between gap-6 rounded-lg bg-muted/50 px-4 py-3 dark:bg-muted/30"
		>
			<span className="grid gap-0.5">
				<span className="text-sm font-medium">{label}</span>
				<span className="text-xs text-muted-foreground">{hint}</span>
			</span>
			<Switch
				id={`wz-${k}`}
				checked={w.values[k]}
				onCheckedChange={(c) => w.set(k, c)}
			/>
		</label>
	);
}

function Target({ w }: { w: WizardApi<MonitorValues> }) {
	const v = w.values;
	const nameField = (
		<TextField w={w} k="name" label="Name" placeholder="Storefront" />
	);
	switch (v.kind) {
		case "tcp":
			return (
				<div className="grid max-w-xl gap-5">
					{nameField}
					<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
						<TextField
							w={w}
							k="host"
							label="Host"
							placeholder="db.example.com"
						/>
						<TextField
							w={w}
							k="port"
							label="Port"
							placeholder="5432"
							inputMode="numeric"
						/>
					</div>
				</div>
			);
		case "tls":
			return (
				<div className="grid max-w-xl gap-5">
					{nameField}
					<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
						<TextField w={w} k="host" label="Host" placeholder="example.com" />
						<TextField w={w} k="port" label="Port" inputMode="numeric" />
					</div>
					<TextField
						w={w}
						k="warnDays"
						label="Warn before expiry"
						hint="Days, comma separated. Each sends one Certificate expiring notification."
					/>
				</div>
			);
		case "dns":
			return (
				<div className="grid max-w-xl gap-5">
					{nameField}
					<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
						<TextField
							w={w}
							k="dnsHostname"
							label="Name to resolve"
							placeholder="example.com"
						/>
						<Field id="wz-recordType" label="Record">
							<Select
								value={v.recordType}
								onValueChange={(r) => w.set("recordType", r)}
							>
								<SelectTrigger id="wz-recordType" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map((r) => (
										<SelectItem key={r} value={r}>
											{r}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					</div>
					<TextField
						w={w}
						k="expected"
						label="Expected answer"
						optional
						hint="Passes only when an answer contains this, like an IP address."
					/>
					<TextField
						w={w}
						k="resolver"
						label="Resolver"
						optional
						placeholder="1.1.1.1"
						hint="A public DNS server to ask. The system resolver when empty."
					/>
				</div>
			);
		case "push":
			return (
				<div className="grid max-w-xl gap-5">
					{nameField}
					<TextField
						w={w}
						k="graceSec"
						label="Grace period"
						inputMode="numeric"
						hint="Seconds of lateness allowed past the interval before a missed run counts."
					/>
					<Instructions>
						<p>
							After you create the monitor you get a <strong>push URL</strong>.
							Call it at the end of each run, for example{" "}
							<code className="font-mono text-foreground">curl -fsS URL</code>.
							Add{" "}
							<code className="font-mono text-foreground">
								?status=down&amp;msg=…
							</code>{" "}
							to report a failure.
						</p>
					</Instructions>
				</div>
			);
		default:
			return (
				<div className="grid max-w-2xl gap-5">
					{nameField}
					<div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
						<Field id="wz-method" label="Method">
							<Select
								value={v.method}
								onValueChange={(m) => w.set("method", m)}
							>
								<SelectTrigger id="wz-method" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{[
										"GET",
										"HEAD",
										"POST",
										"PUT",
										"PATCH",
										"DELETE",
										"OPTIONS",
									].map((m) => (
										<SelectItem key={m} value={m}>
											{m}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<TextField
							w={w}
							k="url"
							label="URL"
							placeholder="https://example.com/health"
						/>
					</div>
					<TextField
						w={w}
						k="statusCodes"
						label="Accepted status codes"
						hint="Comma separated: 200, 200-299 or 2xx."
					/>
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							w={w}
							k="keyword"
							label="Body contains"
							optional
							placeholder="Welcome"
						/>
						<TextField
							w={w}
							k="maxLatencyMs"
							label="Slower than this fails"
							optional
							inputMode="numeric"
							hint="Milliseconds."
						/>
					</div>
					{v.keyword && (
						<Toggle
							w={w}
							k="keywordInvert"
							label="Fail when the body contains it"
							hint="For error pages: the check fails if the text appears."
						/>
					)}
					<div className="grid gap-4 sm:grid-cols-2">
						<TextField
							w={w}
							k="jsonPath"
							label="JSON path"
							optional
							placeholder="$.status"
						/>
						<TextField
							w={w}
							k="jsonEquals"
							label="Equals"
							optional
							placeholder="ok"
						/>
					</div>
					<Field
						id="wz-headers"
						label="Request headers"
						optional
						hint="One per line, as Name: value."
						error={w.error("headers")}
					>
						<Textarea
							{...w.bind("headers")}
							rows={3}
							className="font-mono text-xs"
							placeholder="Authorization: Bearer …"
						/>
					</Field>
					<Toggle
						w={w}
						k="followRedirects"
						label="Follow redirects"
						hint="Up to five hops; each target is checked like the first."
					/>
				</div>
			);
	}
}

function Timing({ w }: { w: WizardApi<MonitorValues> }) {
	const v = w.values;
	const push = v.kind === "push";
	const confirmSec =
		Number(v.retryIntervalSec) * Math.max(0, Number(v.downAfter) - 1);
	return (
		<div className="grid max-w-2xl gap-5">
			<div className="grid gap-4 sm:grid-cols-3">
				<TextField
					w={w}
					k="intervalSec"
					label={push ? "Expected every" : "Check every"}
					inputMode="numeric"
					hint="Seconds."
				/>
				{!push && (
					<>
						<TextField
							w={w}
							k="retryIntervalSec"
							label="Retry after"
							inputMode="numeric"
							hint="Seconds, while confirming."
						/>
						<TextField
							w={w}
							k="timeoutMs"
							label="Timeout"
							inputMode="numeric"
							hint="Milliseconds."
						/>
					</>
				)}
			</div>
			<div className="grid gap-4 sm:grid-cols-3">
				<TextField
					w={w}
					k="downAfter"
					label="Down after"
					inputMode="numeric"
					hint="Failures in a row."
				/>
				<TextField
					w={w}
					k="upAfter"
					label="Up after"
					inputMode="numeric"
					hint="Successes in a row."
				/>
				<TextField
					w={w}
					k="resendMinutes"
					label="Remind every"
					inputMode="numeric"
					hint="Minutes while down; 0 never."
				/>
			</div>
			{!push && Number.isFinite(confirmSec) && (
				<p className="text-sm text-muted-foreground">
					A failure is confirmed about{" "}
					<span className="text-foreground tabular">{confirmSec} s</span> after
					the first failed check, then notifications go out. One pass in between
					starts the count over, so a flapping target stays quiet.
				</p>
			)}
			<Toggle
				w={w}
				k="autoIncident"
				label="Open an incident when it goes down"
				hint="Shown on status pages that list this monitor, and resolved when it recovers."
			/>
		</div>
	);
}

function TestStep({ w }: { w: WizardApi<MonitorValues> }) {
	const run = useMutation({
		mutationFn: () =>
			uptimeApi.testMonitor({
				config: toConfig(w.values),
				timeoutMs: Number(w.values.timeoutMs),
			}),
	});
	const r = run.data;
	return (
		<div
			className="max-w-2xl rounded-lg bg-muted/60 p-4 dark:bg-muted/40"
			aria-live="polite"
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
					{run.isPending ? (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					) : r?.ok ? (
						<CircleCheck className="t-reveal size-5 text-ok-text" />
					) : r || run.error ? (
						<CircleAlert className="t-reveal size-5 text-bad-text" />
					) : (
						<span className="size-2 rounded-full bg-idle" />
					)}
				</span>
				<div className="min-w-0 flex-1 text-sm">
					{run.isPending ? (
						<p className="text-muted-foreground">
							Checking {monitorTarget(toConfig(w.values))}…
						</p>
					) : run.error ? (
						<p className="text-bad-text">{run.error.message}</p>
					) : r ? (
						<div key={String(r.ok) + r.latencyMs} className="t-swap">
							<p className={r.ok ? "font-medium" : "font-medium text-bad-text"}>
								{r.ok ? "The check passes" : (r.error ?? "The check fails")}
							</p>
							<p className="mt-0.5 text-muted-foreground tabular">
								{r.latencyMs !== undefined && `Answered in ${r.latencyMs} ms. `}
								{r.certExpiresAt &&
									`Certificate valid until ${new Date(r.certExpiresAt).toLocaleDateString()}. `}
								{!r.ok &&
									"You can still create it; it starts as down until the target answers."}
							</p>
						</div>
					) : (
						<p className="text-muted-foreground">
							Runs the check once from this server, with the same rules as the
							real thing. Private addresses are refused unless an owner allows
							them in Settings.
						</p>
					)}
				</div>
				<Button
					type="button"
					variant="outline"
					onClick={() => run.mutate()}
					disabled={run.isPending}
				>
					{r || run.error ? "Test again" : "Run check"}
				</Button>
			</div>
		</div>
	);
}

export function monitorSteps(edit: boolean): WizardStep<MonitorValues>[] {
	return [
		{
			id: "type",
			title: "What to watch",
			description:
				"Pick what kind of check this is. It decides what the next step asks for.",
			when: () => !edit,
			schema: z.object({
				kind: z.enum(["http", "tcp", "dns", "tls", "push"], "Pick a type."),
			}),
			render: (w) => (
				<ChoiceGroup
					label="Monitor type"
					value={w.values.kind || undefined}
					invalid={!!w.error("kind")}
					onChange={(k) => {
						w.set("kind", k);
						// A heartbeat is a single missed run, not three failed requests.
						if (k === "push") {
							w.set("downAfter", "1");
							if (w.values.intervalSec === "60") w.set("intervalSec", "3600");
						}
						if (k === "tls" && w.values.intervalSec === "60")
							w.set("intervalSec", "3600");
						if (k === "tls" && !w.values.port) w.set("port", "443");
					}}
					choices={KINDS}
				/>
			),
		},
		{
			id: "target",
			title: "Target",
			description: "What to check, and what counts as a pass.",
			schema: targetSchema,
			render: (w) => <Target w={w} />,
		},
		{
			id: "timing",
			title: "Timing and alerts",
			description:
				"How often to check, and how many results in a row change the status.",
			schema: (v) =>
				z.object({
					intervalSec: intIn(20, 86_400, "Interval"),
					...(v.kind !== "push" && {
						retryIntervalSec: intIn(5, 3_600, "Retry"),
						timeoutMs: intIn(1_000, 60_000, "Timeout"),
					}),
					downAfter: intIn(1, 10, "Down after"),
					upAfter: intIn(1, 10, "Up after"),
					resendMinutes: intIn(0, 10_080, "Reminder"),
				}),
			render: (w) => <Timing w={w} />,
		},
		{
			id: "test",
			title: "Test",
			description: "Try the check before saving it. It does not have to pass.",
			when: (v) => v.kind !== "push",
			render: (w) => <TestStep w={w} />,
		},
		{
			id: "review",
			title: edit ? "Review and save" : "Review and create",
			description: edit
				? "Saving restarts the status from Checking when the target or interval changed."
				: "The first check runs within a few seconds.",
			render: (w) => <Summary w={w} sections={summary(w.values, edit)} />,
		},
	];
}

function summary(v: MonitorValues, edit: boolean): SummarySection[] {
	const kind = v.kind || "http";
	return [
		...(edit
			? []
			: [
					{
						stepId: "type",
						title: "Type",
						rows: [{ label: "Kind", value: KIND_LABEL[kind] }],
					},
				]),
		{
			stepId: "target",
			title: "Target",
			rows: [
				{ label: "Name", value: v.name },
				{ label: "Checks", value: monitorTarget(toConfig(v)) },
				...(kind === "http"
					? [
							{ label: "Status codes", value: v.statusCodes },
							...(v.keyword
								? [
										{
											label: v.keywordInvert ? "Body lacks" : "Body contains",
											value: v.keyword,
										},
									]
								: []),
							...(v.jsonPath
								? [{ label: "JSON", value: `${v.jsonPath} = ${v.jsonEquals}` }]
								: []),
							...(v.maxLatencyMs
								? [{ label: "Max latency", value: `${v.maxLatencyMs} ms` }]
								: []),
						]
					: []),
				...(kind === "tls"
					? [{ label: "Warn at", value: `${v.warnDays} days` }]
					: []),
			],
		},
		{
			stepId: "timing",
			title: "Timing",
			rows: [
				{ label: "Interval", value: `${v.intervalSec} s` },
				...(kind === "push"
					? []
					: [{ label: "Retry", value: `${v.retryIntervalSec} s` }]),
				{ label: "Down after", value: `${v.downAfter} in a row` },
				{ label: "Up after", value: `${v.upAfter} in a row` },
				{
					label: "Incident",
					value: v.autoIncident ? "Opened automatically" : "No",
				},
			],
		},
	];
}

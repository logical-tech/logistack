import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Loader2, Orbit } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
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
import { Switch } from "@/components/ui/switch";
import { Summary, TestPanel } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { useInvalidating } from "@/lib/api/networking";
import { projectsQuery } from "@/lib/api/projects";
import {
	type Tailscale,
	tailscaleApi,
	tailscaleQuery,
} from "@/lib/api/tailscale";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/integrations/tailscale_/new")({
	staticData: { crumb: "Set up Tailscale" },
	validateSearch: z.object({ step: stepParam }),
	component: SetUpTailscale,
});

type V = {
	authKey: string;
	serviceId: string;
	hostname: string;
	port: string;
	https: boolean;
	/** Set by the apply step once the publication exists. */
	publicationId: string;
};

type ServiceOption = { id: string; label: string; slug: string };

const MACHINE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The apply step: turns Tailscale on and publishes, then waits for the worker. */
function Apply({ w, ts }: { w: WizardApi<V>; ts: Tailscale | undefined }) {
	const enable = useInvalidating(tailscaleApi.enable, [["tailscale"]]);
	const publish = useInvalidating(tailscaleApi.publish, [["tailscale"]]);
	const [error, setError] = useState<string | null>(null);
	const busy = enable.isPending || publish.isPending;
	const { set } = w;
	const v = w.values;
	const pub = ts?.publications.find((p) => p.id === v.publicationId);
	const applied = Boolean(ts?.enabled && (!v.serviceId || pub));
	const run = async () => {
		setError(null);
		try {
			if (v.authKey) await enable.mutateAsync(v.authKey.trim());
			if (v.serviceId && !pub) {
				const created = await publish.mutateAsync({
					serviceId: v.serviceId,
					hostname: v.hostname,
					port: Number(v.port),
					https: v.https,
				});
				set("publicationId", created.id);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	const problem = error ?? ts?.statusMessage ?? pub?.statusMessage ?? null;
	const running = applied && ts?.nodesRunning && !problem;
	return (
		<div
			className="rounded-lg bg-muted/60 p-4 dark:bg-muted/40"
			aria-live="polite"
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
					{busy || (applied && !running && !problem) ? (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					) : running ? (
						<CircleCheck className="t-reveal size-5 text-ok-text" />
					) : problem ? (
						<CircleAlert className="t-reveal size-5 text-bad-text" />
					) : (
						<span className="size-2 rounded-full bg-idle" />
					)}
				</span>
				<div className="min-w-0 flex-1 text-sm">
					{running ? (
						<p key="ok" className="t-swap font-medium">
							tailscaled runs on every server
							{pub ? `, and ${pub.hostname} has its tailnet machine` : ""}
						</p>
					) : problem ? (
						<div key="bad" className="t-swap">
							<p className="font-medium text-bad-text">It didn't start</p>
							<p className="mt-0.5 text-pretty text-muted-foreground">
								{problem}
							</p>
						</div>
					) : applied ? (
						<p className="text-muted-foreground">
							The worker is starting tailscaled. This takes a few seconds.
						</p>
					) : (
						<p className="text-muted-foreground">Nothing has changed yet.</p>
					)}
				</div>
				{!applied && (
					<Button type="button" onClick={run} disabled={busy}>
						{ts?.enabled ? "Publish" : "Turn on"}
					</Button>
				)}
				{applied && problem && (
					<Button type="button" variant="outline" onClick={run} disabled={busy}>
						Try again
					</Button>
				)}
			</div>
		</div>
	);
}

function buildSteps(
	services: ServiceOption[],
	ts: Tailscale | undefined,
): WizardStep<V>[] {
	const label = (id: string) => services.find((s) => s.id === id)?.label ?? "";
	return [
		{
			id: "key",
			title: "Auth key",
			description:
				"In the Tailscale admin console, open Settings › Keys and generate an auth key. Make it reusable and ephemeral, so restarted servers rejoin and removed ones leave the tailnet.",
			when: () => !ts?.enabled,
			schema: z.object({
				authKey: z
					.string()
					.trim()
					.regex(
						/^tskey-[A-Za-z0-9-]+$/,
						"Paste a key that starts with tskey-.",
					),
			}),
			render: (w) => (
				<Field
					id="wz-authKey"
					label="Auth key"
					error={w.error("authKey")}
					hint="Stored encrypted. LogiStack never shows it again."
				>
					<Input
						{...w.bind("authKey")}
						type="password"
						autoComplete="off"
						spellCheck={false}
						placeholder="tskey-auth-…"
						className="max-w-md font-mono"
						autoFocus
					/>
				</Field>
			),
		},
		{
			id: "publish",
			title: "Publish a service",
			description:
				"Optional. The service gets its own tailnet machine; tailscale serve proxies it to the port you pick. Leave it empty to only join the servers.",
			schema: (v) =>
				z.object({
					serviceId: ts?.enabled
						? z.string().min(1, "Pick a service.")
						: z.string(),
					hostname: v.serviceId
						? z
								.string()
								.regex(MACHINE, "Use lowercase letters, digits and hyphens.")
						: z.string(),
					port: v.serviceId
						? z.coerce.number().int().min(1, "Enter a port.").max(65535)
						: z.string(),
				}),
			render: (w) => (
				<div className="grid max-w-md gap-4">
					<Field id="wz-serviceId" label="Service" error={w.error("serviceId")}>
						<Select
							value={w.values.serviceId || "none"}
							onValueChange={(id) => {
								const s = services.find((x) => x.id === id);
								w.set("serviceId", s ? id : "");
								if (s && !w.values.hostname) w.set("hostname", s.slug);
							}}
						>
							<SelectTrigger id="wz-serviceId" className="w-full">
								<SelectValue placeholder="Pick a service" />
							</SelectTrigger>
							<SelectContent>
								{!ts?.enabled && (
									<SelectItem value="none">
										None, only join the servers
									</SelectItem>
								)}
								{services.map((s) => (
									<SelectItem key={s.id} value={s.id}>
										{s.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					{w.values.serviceId && (
						<>
							<Field
								id="wz-hostname"
								label="Tailnet hostname"
								error={w.error("hostname")}
								hint="Devices reach it at this name under your tailnet's ts.net domain."
							>
								<Input
									{...w.bind("hostname")}
									placeholder="grafana"
									spellCheck={false}
								/>
							</Field>
							<Field
								id="wz-port"
								label="Container port"
								error={w.error("port")}
							>
								<Input
									{...w.bind("port")}
									inputMode="numeric"
									placeholder="3000"
									className="max-w-32 tabular-nums"
								/>
							</Field>
							<div className="flex items-start justify-between gap-4">
								<label htmlFor="wz-https" className="grid gap-0.5 text-sm">
									<span className="font-medium">
										HTTPS with a tailnet certificate
									</span>
									<span className="text-pretty text-muted-foreground">
										Needs HTTPS turned on in the Tailscale admin console. Off
										serves plain HTTP on port 80.
									</span>
								</label>
								<Switch
									id="wz-https"
									checked={w.values.https}
									onCheckedChange={(c) => w.set("https", c)}
								/>
							</div>
						</>
					)}
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"LogiStack runs tailscaled as a service on every server, and one more for each published service. Turning Tailscale off removes them all.",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						...(ts?.enabled
							? []
							: [
									{
										stepId: "key",
										title: "Tailnet",
										rows: [
											{
												label: "Auth key",
												value: "Provided, stored encrypted",
											},
											{ label: "Servers", value: "All, under their hostnames" },
										],
									},
								]),
						{
							stepId: "publish",
							title: "Published service",
							rows: w.values.serviceId
								? [
										{ label: "Service", value: label(w.values.serviceId) },
										{ label: "Hostname", value: w.values.hostname },
										{
											label: "Serves",
											value: `${w.values.https ? "HTTPS on 443" : "HTTP on 80"} → port ${w.values.port}`,
										},
									]
								: [{ label: "Service", value: "None" }],
						},
					]}
				/>
			),
		},
		{
			id: "apply",
			title: ts?.enabled ? "Publish" : "Turn on",
			description: "The worker starts the services and reports back here.",
			ready: (v) =>
				ts?.nodesRunning &&
				!ts.statusMessage &&
				(!v.serviceId || ts.publications.some((p) => p.id === v.publicationId))
					? true
					: "Wait for tailscaled to start",
			render: (w) => <Apply w={w} ts={ts} />,
		},
		{
			id: "test",
			title: "Test over the tailnet",
			description:
				"A server's tailscaled pings the published machine across the tailnet, or reports its own tailnet address when nothing is published.",
			test: async (v) => {
				// A fresh tailnet machine takes a few seconds to appear in the netmap.
				for (let i = 0; ; i++) {
					const r = await tailscaleApi.test(v.publicationId || undefined);
					if (r.ok || i >= 5) return r;
					await new Promise((ok) => setTimeout(ok, 4_000));
				}
			},
			testKeys: ["publicationId"],
			render: (w) => (
				<TestPanel
					w={w}
					action="Run test"
					idle="Nothing has been checked yet. This runs inside tailscaled on one of your servers."
				/>
			),
		},
	];
}

function SetUpTailscale() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: ts } = useQuery(tailscaleQuery);
	const { data: projects } = useQuery(projectsQuery);
	const services = useMemo(
		() =>
			(projects ?? []).flatMap((p) =>
				p.services.map((s) => ({
					id: s.id,
					// The environment only when the project has several, to tell same-named services apart.
					label: [
						p.name,
						p.environments.length > 1
							? p.environments.find((e) => e.id === s.environmentId)?.name
							: undefined,
						s.name,
					]
						.filter(Boolean)
						.join(" · "),
					slug: s.name
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-+|-+$/g, "")
						.slice(0, 63),
				})),
			),
		[projects],
	);
	const steps = useMemo(() => buildSteps(services, ts), [services, ts]);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	if (!ts || !projects) return null;
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title={ts.enabled ? "Publish on the tailnet" : "Set up Tailscale"}
				description="Reach servers and services from your own devices over Tailscale, without opening ports."
			/>
			<Wizard
				id="tailscale-new"
				steps={steps}
				defaultValues={{
					authKey: "",
					serviceId: "",
					hostname: "",
					port: "",
					https: true,
					publicationId: "",
				}}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Done"
				onComplete={async () => {
					toast.success("Tailscale is set up", {
						icon: <Orbit className="size-4" />,
					});
					await navigate({ to: "/integrations/tailscale" });
				}}
			/>
		</Page>
	);
}

import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useNavigate,
} from "@tanstack/react-router";
import {
	ArrowUpRight,
	Loader2,
	RotateCcw,
	Stethoscope,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
	ConfigFields,
	type ConfigSchema,
	type ConfigValues,
	hasFields,
	missingFields,
	toConfig,
} from "@/components/integrations/config-form";
import { Page, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { ManifestSummary } from "@/components/plugins/manifest-summary";
import { UpdateDialog } from "@/components/plugins/update-dialog";
import { useTogglePlugin } from "@/components/plugins/use-toggle-plugin";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api";
import { useInvalidating } from "@/lib/api/networking";
import { type PluginInstall, pluginQuery, pluginsApi } from "@/lib/api/plugins";
import { relativeTime } from "@/lib/format";
import { PLUGIN_STATUS } from "@/lib/status";

export const Route = createFileRoute("/_app/settings/plugins_/$installId")({
	loader: async ({ context, params }) => {
		try {
			const p = await context.queryClient.ensureQueryData(
				pluginQuery(params.installId),
			);
			return { crumb: p.name };
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
	component: PluginDetail,
});

/** Stored values as form strings; secrets arrive masked and go back masked to keep them. */
const toValues = (config: Record<string, unknown>): ConfigValues =>
	Object.fromEntries(
		Object.entries(config).map(([k, v]) => [k, v == null ? "" : String(v)]),
	);

function SettingsPanel({ p }: { p: PluginInstall }) {
	const schema = p.manifest.config as ConfigSchema;
	const [values, setValues] = useState<ConfigValues>(() => toValues(p.config));
	const [errors, setErrors] = useState<Record<string, string>>({});
	const save = useInvalidating(
		(config: Record<string, unknown>) => pluginsApi.update(p.id, { config }),
		[["plugins"]],
	);
	if (!hasFields(schema))
		return (
			<Panel title="Settings" id="settings">
				<p className="p-4 text-sm text-muted-foreground">
					This plugin has no settings.
				</p>
			</Panel>
		);
	const dirty =
		JSON.stringify(toConfig(schema, values)) !==
		JSON.stringify(toConfig(schema, toValues(p.config)));
	return (
		<Panel title="Settings" id="settings">
			<form
				className="grid gap-5 p-4 sm:p-5"
				onSubmit={async (e) => {
					e.preventDefault();
					const missing = missingFields(schema, values);
					setErrors(missing);
					if (Object.keys(missing).length) return;
					try {
						await save.mutateAsync(toConfig(schema, values));
						toast.success("Settings saved", {
							description: "The plugin gets them with its next request.",
						});
					} catch (err) {
						toast.error("Couldn't save the settings", {
							description: err instanceof Error ? err.message : String(err),
						});
					}
				}}
			>
				<ConfigFields
					schema={schema}
					values={values}
					onChange={setValues}
					errors={errors}
					idPrefix="plugin-config"
				/>
				<div className="flex justify-end">
					<Button type="submit" disabled={!dirty || save.isPending}>
						{save.isPending && <Loader2 className="animate-spin" />}
						Save settings
					</Button>
				</div>
			</form>
		</Panel>
	);
}

/** Shown when the plugin declares a deploy gate: how long deploys wait and what a silence means. */
function GatePanel({ p }: { p: PluginInstall }) {
	const [timeout, setTimeoutS] = useState(String(p.gate.timeoutSeconds));
	const [failMode, setFailMode] = useState(p.gate.failMode);
	const save = useInvalidating(
		(gate: PluginInstall["gate"]) => pluginsApi.update(p.id, { gate }),
		[["plugins"]],
	);
	const seconds = Number(timeout);
	const valid = Number.isInteger(seconds) && seconds >= 1 && seconds <= 60;
	const dirty =
		seconds !== p.gate.timeoutSeconds || failMode !== p.gate.failMode;
	return (
		<Panel title="Deploy gate" id="gate">
			<form
				className="grid gap-5 p-4 sm:p-5"
				onSubmit={async (e) => {
					e.preventDefault();
					if (!valid) return;
					try {
						await save.mutateAsync({ timeoutSeconds: seconds, failMode });
						toast.success("Deploy gate saved");
					} catch (err) {
						toast.error("Couldn't save the deploy gate", {
							description: err instanceof Error ? err.message : String(err),
						});
					}
				}}
			>
				<p className="text-sm text-pretty text-muted-foreground">
					{p.name} is asked before every rollout in this organization and can
					stop it. Its reason shows in the deployment log.
				</p>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="grid gap-1.5">
						<Label htmlFor="gate-timeout">Wait for an answer (seconds)</Label>
						<Input
							id="gate-timeout"
							type="number"
							inputMode="numeric"
							min={1}
							max={60}
							value={timeout}
							onChange={(e) => setTimeoutS(e.target.value)}
							aria-invalid={!valid}
							aria-describedby="gate-timeout-hint"
							className="tabular"
						/>
						<p
							id="gate-timeout-hint"
							className={
								valid
									? "text-xs text-muted-foreground"
									: "text-xs text-bad-text"
							}
						>
							Between 1 and 60.
						</p>
					</div>
					<div className="grid gap-1.5 content-start">
						<Label htmlFor="gate-fail-mode">If it doesn't answer</Label>
						<Select
							value={failMode}
							onValueChange={(v) => setFailMode(v as typeof failMode)}
						>
							<SelectTrigger id="gate-fail-mode" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="closed">Fail the deployment</SelectItem>
								<SelectItem value="open">Deploy anyway</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
				<div className="flex justify-end">
					<Button type="submit" disabled={!dirty || !valid || save.isPending}>
						{save.isPending && <Loader2 className="animate-spin" />}
						Save deploy gate
					</Button>
				</div>
			</form>
		</Panel>
	);
}

function TestButton({ p }: { p: PluginInstall }) {
	const [running, setRunning] = useState(false);
	return (
		<Button
			variant="outline"
			disabled={running || !p.enabled}
			onClick={async () => {
				setRunning(true);
				try {
					const t = await pluginsApi.test(p.id);
					if (t.ok)
						toast.success(`${p.name} is healthy`, {
							description:
								t.config === null
									? "It answered its health check."
									: "It answered its health check and accepted the settings.",
						});
					else
						toast.error(
							t.health.ok
								? `${p.name} rejected its settings`
								: `${p.name} doesn't answer its health check`,
							{ description: t.health.ok ? t.config?.error : t.health.error },
						);
				} catch (err) {
					toast.error("The test couldn't run", {
						description: err instanceof Error ? err.message : String(err),
					});
				} finally {
					setRunning(false);
				}
			}}
		>
			{running ? <Loader2 className="animate-spin" /> : <Stethoscope />}
			Test
		</Button>
	);
}

/** Marketplace installs: update from the index, or go back to the version before the last update. */
function Versions({ p }: { p: PluginInstall }) {
	const [updating, setUpdating] = useState(false);
	const [rollingBack, setRollingBack] = useState(false);
	const rollback = useInvalidating(pluginsApi.rollback, [["plugins"]]);
	if (!p.indexId && !p.previousVersion) return null;
	return (
		<div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
			{p.indexId && (
				<Button variant="outline" size="sm" onClick={() => setUpdating(true)}>
					Check for updates
				</Button>
			)}
			{p.previousVersion && (
				<Button variant="ghost" size="sm" onClick={() => setRollingBack(true)}>
					<RotateCcw />
					Roll back to {p.previousVersion}
				</Button>
			)}
			<UpdateDialog p={p} open={updating} onOpenChange={setUpdating} />
			<ConfirmDialog
				open={rollingBack}
				onOpenChange={setRollingBack}
				title={`Roll back ${p.name} to ${p.previousVersion}?`}
				description={`It restarts on the previous image with that version's permissions and a new API token. You can return to ${p.version} the same way.`}
				confirmLabel="Roll back"
				destructive={false}
				pending={rollback.isPending}
				onConfirm={async () => {
					try {
						const r = await rollback.mutateAsync(p.id);
						toast.success(`${p.name} is back on ${r.version}`);
						setRollingBack(false);
					} catch (err) {
						toast.error("Couldn't roll back", {
							description: err instanceof Error ? err.message : String(err),
						});
					}
				}}
			/>
		</div>
	);
}

function Uninstall({ p }: { p: PluginInstall }) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const navigate = useNavigate();
	const remove = useInvalidating(pluginsApi.remove, [["plugins"]]);
	return (
		<>
			<Button
				variant="ghost"
				className="text-bad-text hover:text-bad-text"
				onClick={() => {
					setTyped("");
					setOpen(true);
				}}
			>
				<Trash2 />
				Uninstall
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title={`Uninstall ${p.name}?`}
				description="Its container, service account and API key are removed, and so is every member's saved page state. Settings are deleted and can't be recovered."
				confirmLabel="Uninstall"
				pending={remove.isPending}
				confirmDisabled={typed.trim() !== p.name}
				onConfirm={async () => {
					try {
						await remove.mutateAsync(p.id);
						toast.success(`${p.name} uninstalled`);
						setOpen(false);
						await navigate({ to: "/settings/plugins" });
					} catch (err) {
						toast.error(`Couldn't uninstall ${p.name}`, {
							description: err instanceof Error ? err.message : String(err),
						});
					}
				}}
			>
				<div className="grid gap-2">
					<label htmlFor="uninstall-name" className="text-sm">
						Type <span className="font-medium">{p.name}</span> to confirm
					</label>
					<Input
						id="uninstall-name"
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						autoComplete="off"
						spellCheck={false}
					/>
				</div>
			</ConfirmDialog>
		</>
	);
}

function PluginDetail() {
	const { installId } = Route.useParams();
	const { data: p } = useQuery({
		...pluginQuery(installId),
		// Follow a starting container until it settles.
		refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
	});
	const { toggle, dialog, busy } = useTogglePlugin();
	if (!p) return null;
	const openable = p.manifest.contributes.pages.filter(
		(x) => x.location === "sidebar" || x.location === "settings",
	);
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title={p.name}
				description={p.description || undefined}
				actions={
					<>
						<TestButton p={p} />
						<Uninstall p={p} />
					</>
				}
			/>
			<div className="grid gap-8">
				{p.yanked && (
					<div
						role="alert"
						className="t-reveal flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm"
					>
						<TriangleAlert
							className="mt-0.5 size-4 shrink-0 text-warn-text"
							aria-hidden
						/>
						<p>
							<span className="font-medium">The index yanked {p.version}.</span>{" "}
							<span className="text-muted-foreground">
								It keeps running here. Update to a newer version
								{p.previousVersion ? " or roll back" : ""} when you can.
							</span>
						</p>
					</div>
				)}
				<Panel title="Status" id="status">
					<div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
						<div className="min-w-0 flex-1">
							<StatusLabel
								meta={PLUGIN_STATUS[p.enabled ? p.status : "disabled"]}
							/>
							<p
								className={
									p.status === "error"
										? "mt-1 text-sm text-bad-text"
										: "mt-1 text-sm text-muted-foreground"
								}
							>
								{p.statusMessage ??
									`Installed ${relativeTime(p.createdAt)}, changed ${relativeTime(p.updatedAt)}${p.serviceName ? ` · service ${p.serviceName}` : ""}.`}
							</p>
						</div>
						<div className="flex items-center gap-3 text-sm">
							<span aria-hidden>{p.enabled ? "On" : "Off"}</span>
							<Switch
								checked={p.enabled}
								aria-label={
									p.enabled ? `Turn off ${p.name}` : `Turn on ${p.name}`
								}
								disabled={busy}
								onCheckedChange={(on) => toggle(p, on)}
							/>
						</div>
					</div>
					<Versions p={p} />
					{p.enabled && openable.length > 0 && (
						<div className="flex flex-wrap gap-2 border-t px-4 py-3">
							{openable.map((x) => (
								<Button key={x.id} asChild variant="outline" size="sm">
									<Link
										to="/plugin/$installId/$pageId/$"
										params={{ installId: p.id, pageId: x.id, _splat: "" }}
									>
										{x.title}
										<ArrowUpRight data-icon="inline-end" />
									</Link>
								</Button>
							))}
						</div>
					)}
				</Panel>
				<SettingsPanel key={p.updatedAt} p={p} />
				{p.manifest.contributes.gates?.deploy && (
					<GatePanel key={`gate-${p.updatedAt}`} p={p} />
				)}
				<section aria-labelledby="manifest" className="grid gap-2.5">
					<h2
						id="manifest"
						className="text-sm font-semibold [font-stretch:100%]"
					>
						Manifest
					</h2>
					<ManifestSummary
						manifest={p.manifest}
						image={p.image}
						devUrl={p.devUrl}
						source={p}
					/>
				</section>
			</div>
			{dialog}
		</Page>
	);
}

import {
	type ApplicationSpec,
	type BuildPlatform,
	type Healthcheck,
	ServiceSpec,
} from "@logistack/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Panel } from "@/components/panel";
import { DeployTriggers } from "@/components/service/deploy-triggers";
import {
	MountRows,
	PortRows,
	ProcessFields,
} from "@/components/service/host-settings";
import { ServiceIconPicker } from "@/components/service/service-icon";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { archOf, buildPlatformsQuery } from "@/lib/api/builds";
import { nodesQuery } from "@/lib/api/monitoring";
import {
	type ServiceOverview,
	serviceKey,
	useServiceMutation,
} from "@/lib/api/service-ops";
import type { ProjectId } from "@/lib/api/types";

type Build = ApplicationSpec["build"];
const PIN = "node.hostname==";

/** Numbers typed into a field; an empty field means "not set". */
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
const lines = (v: string) =>
	v
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

function Section({
	title,
	id,
	description,
	children,
}: {
	title: string;
	id: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<Panel title={title} id={id} bodyClassName="grid gap-5 p-4 sm:p-5">
			<p className="-mb-1 max-w-[70ch] text-sm text-muted-foreground">
				{description}
			</p>
			{children}
		</Panel>
	);
}

function HealthcheckFields({
	value,
	onChange,
}: {
	value: Healthcheck | undefined;
	onChange: (h: Healthcheck | undefined) => void;
}) {
	const type = value?.type ?? "none";
	return (
		<div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
			<Field id="hc-type" label="Check">
				<Select
					value={type}
					onValueChange={(t) =>
						onChange(
							t === "http"
								? { type: "http", port: 80, path: "/" }
								: t === "tcp"
									? { type: "tcp", port: 80 }
									: t === "command"
										? { type: "command", command: ["true"] }
										: undefined,
						)
					}
				>
					<SelectTrigger id="hc-type" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">None</SelectItem>
						<SelectItem value="http">HTTP request</SelectItem>
						<SelectItem value="tcp">TCP connect</SelectItem>
						<SelectItem value="command">Command</SelectItem>
					</SelectContent>
				</Select>
			</Field>
			{value?.type === "http" && (
				<div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-4">
					<Field id="hc-port" label="Port">
						<Input
							id="hc-port"
							type="number"
							value={value.port || ""}
							onChange={(e) =>
								onChange({ ...value, port: num(e.target.value) ?? 0 })
							}
						/>
					</Field>
					<Field id="hc-path" label="Path">
						<Input
							id="hc-path"
							className="font-mono"
							value={value.path}
							onChange={(e) => onChange({ ...value, path: e.target.value })}
						/>
					</Field>
				</div>
			)}
			{value?.type === "tcp" && (
				<Field id="hc-port" label="Port">
					<Input
						id="hc-port"
						type="number"
						className="max-w-32"
						value={value.port || ""}
						onChange={(e) =>
							onChange({ ...value, port: num(e.target.value) ?? 0 })
						}
					/>
				</Field>
			)}
			{value?.type === "command" && (
				<Field
					id="hc-cmd"
					label="Command"
					hint="One argument per line; exit 0 is healthy."
				>
					<Textarea
						id="hc-cmd"
						rows={3}
						className="font-mono text-[13px]"
						value={value.command.join("\n")}
						onChange={(e) =>
							onChange({ type: "command", command: e.target.value.split("\n") })
						}
					/>
				</Field>
			)}
		</div>
	);
}

const ARCHS = {
	auto: undefined,
	amd64: ["linux/amd64"],
	arm64: ["linux/arm64"],
	both: ["linux/amd64", "linux/arm64"],
} as const satisfies Record<string, BuildPlatform[] | undefined>;
type Archs = keyof typeof ARCHS;

function PlatformsField({
	build,
	onChange,
}: {
	build: Extract<Build, { type: "dockerfile" | "railpack" }>;
	onChange: (b: Build) => void;
}) {
	const { data: p } = useQuery(buildPlatformsQuery);
	const current = build.platforms;
	const value: Archs = !current
		? "auto"
		: current.length > 1
			? "both"
			: current[0] === "linux/arm64"
				? "arm64"
				: "amd64";
	const targets = current ?? p?.swarm ?? [];
	const missing = p?.missing.filter((m) => targets.includes(m)) ?? [];
	const swarm = p?.swarm.length ? p.swarm.map(archOf).join(" and ") : null;
	return (
		<Field
			id="platforms"
			label="Architectures"
			hint={
				missing.length ? (
					<>
						BuildKit can't build {missing.map(archOf).join(" and ")} yet.{" "}
						<Link
							to="/settings/builds"
							className="font-medium text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground"
						>
							Set up emulation
						</Link>
					</>
				) : build.type === "railpack" ? (
					"Railpack builds one architecture per image; on a mixed swarm Automatic builds BuildKit's own."
				) : value === "both" ? (
					"One image for both kinds of server. Needs a registry."
				) : (
					"The service only runs on servers of the architectures it is built for."
				)
			}
		>
			<Select
				value={value}
				onValueChange={(v) => {
					const platforms = ARCHS[v as Archs];
					const { platforms: _, ...rest } = build;
					onChange(platforms ? { ...rest, platforms: [...platforms] } : rest);
				}}
			>
				<SelectTrigger id="platforms" className="w-full sm:max-w-72">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="auto">
						Automatic{swarm ? ` (${swarm})` : ""}
					</SelectItem>
					<SelectItem value="amd64">amd64 only</SelectItem>
					<SelectItem value="arm64">arm64 only</SelectItem>
					{build.type === "dockerfile" && (
						<SelectItem value="both">amd64 and arm64</SelectItem>
					)}
				</SelectContent>
			</Select>
		</Field>
	);
}

function BuildFields({
	spec,
	onChange,
}: {
	spec: ApplicationSpec;
	onChange: (patch: Partial<ApplicationSpec>) => void;
}) {
	const { source, build } = spec;
	if (source.type === "image")
		return (
			<Field
				id="image"
				label="Image"
				hint="Pulled at each deploy. Pin a tag or digest to keep deploys reproducible."
			>
				<Input
					id="image"
					className="font-mono"
					value={source.image}
					onChange={(e) =>
						onChange({ source: { ...source, image: e.target.value } })
					}
				/>
			</Field>
		);
	const setBuild = (b: Build) => onChange({ build: b });
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-3">
				<Field id="repo" label="Repository" className="sm:col-span-3">
					<Input
						id="repo"
						className="font-mono"
						value={source.repository}
						onChange={(e) =>
							onChange({ source: { ...source, repository: e.target.value } })
						}
					/>
				</Field>
				<Field id="branch" label="Branch">
					<Input
						id="branch"
						className="font-mono"
						value={source.branch}
						onChange={(e) =>
							onChange({ source: { ...source, branch: e.target.value } })
						}
					/>
				</Field>
				<Field id="path" label="Root directory">
					<Input
						id="path"
						className="font-mono"
						value={source.path}
						onChange={(e) =>
							onChange({ source: { ...source, path: e.target.value } })
						}
					/>
				</Field>
				<Field id="build-type" label="Builder">
					<Select
						value={build.type}
						onValueChange={(t) =>
							setBuild(
								t === "dockerfile"
									? {
											type: "dockerfile",
											dockerfilePath: "Dockerfile",
											context: ".",
										}
									: t === "static"
										? { type: "static", publishDir: "dist" }
										: { type: "railpack" },
							)
						}
					>
						<SelectTrigger id="build-type" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="railpack">Railpack (detect)</SelectItem>
							<SelectItem value="dockerfile">Dockerfile</SelectItem>
							<SelectItem value="static">Static site</SelectItem>
						</SelectContent>
					</Select>
				</Field>
			</div>
			{build.type === "dockerfile" && (
				<div className="grid gap-4 sm:grid-cols-3">
					<Field id="dockerfile" label="Dockerfile">
						<Input
							id="dockerfile"
							className="font-mono"
							value={build.dockerfilePath}
							onChange={(e) =>
								setBuild({ ...build, dockerfilePath: e.target.value })
							}
						/>
					</Field>
					<Field id="context" label="Build context">
						<Input
							id="context"
							className="font-mono"
							value={build.context}
							onChange={(e) => setBuild({ ...build, context: e.target.value })}
						/>
					</Field>
					<Field id="target" label="Target stage" optional>
						<Input
							id="target"
							className="font-mono"
							value={build.target ?? ""}
							onChange={(e) =>
								setBuild({ ...build, target: e.target.value || undefined })
							}
						/>
					</Field>
				</div>
			)}
			{(build.type === "dockerfile" || build.type === "railpack") && (
				<PlatformsField build={build} onChange={setBuild} />
			)}
			{build.type === "static" && (
				<Field
					id="publish"
					label="Publish directory"
					hint="Served by the static runtime after the build."
				>
					<Input
						id="publish"
						className="max-w-64 font-mono"
						value={build.publishDir}
						onChange={(e) => setBuild({ ...build, publishDir: e.target.value })}
					/>
				</Field>
			)}
		</>
	);
}

function DangerZone({
	service: o,
	projectId,
}: {
	service: ServiceOverview;
	projectId: ProjectId;
}) {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const remove = useServiceMutation(o.id, () => api.serviceOps.remove(o.id));
	return (
		<section aria-labelledby="danger" className="grid gap-2.5">
			<h2 id="danger" className="text-sm font-semibold [font-stretch:100%]">
				Danger zone
			</h2>
			<div className="flex flex-col gap-4 rounded-xl bg-[color-mix(in_oklch,var(--bad)_6%,var(--card))] p-4 ring-1 ring-[color-mix(in_oklch,var(--bad)_28%,var(--border))] sm:flex-row sm:items-center sm:justify-between sm:p-5">
				<div>
					<p className="text-sm font-medium">Delete this service</p>
					<p className="mt-0.5 max-w-[60ch] text-sm text-muted-foreground">
						Its replicas, domains, variables and deployment history go. Named
						volumes are kept until you remove them.
					</p>
				</div>
				<Button variant="destructive" onClick={() => setOpen(true)}>
					Delete service
				</Button>
			</div>
			<Dialog
				open={open}
				onOpenChange={(v) => {
					setOpen(v);
					setTyped("");
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Delete {o.name}?</DialogTitle>
						<DialogDescription>
							This cannot be undone. Type{" "}
							<span className="font-mono text-foreground">{o.name}</span> to
							confirm.
						</DialogDescription>
					</DialogHeader>
					<Input
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						aria-label="Service name"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
					/>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={typed !== o.name || remove.isPending}
							onClick={() =>
								remove.mutate(undefined, {
									onSuccess: () => {
										qc.removeQueries({ queryKey: serviceKey(o.id) });
										toast.success(`${o.name} deleted`);
										navigate({
											to: "/projects/$projectId",
											params: { projectId },
										});
									},
									onError: (e) =>
										toast.error("Couldn't delete", { description: e.message }),
								})
							}
						>
							Delete {o.name}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}

/** The form's state. Command and constraints stay as typed text until they are saved. */
type Draft = {
	name: string;
	spec: ServiceSpec;
	command: string;
	constraints: string;
	pin: string;
};

function draftOf(o: ServiceOverview): Draft {
	const app = o.spec.kind === "application" ? o.spec : null;
	return {
		name: o.name,
		spec: o.spec,
		command: app?.command?.join("\n") ?? "",
		constraints:
			app?.placement.filter((p) => !p.startsWith(PIN)).join("\n") ?? "",
		pin: app?.placement.find((p) => p.startsWith(PIN))?.slice(PIN.length) ?? "",
	};
}

export function SettingsForm({
	service: o,
	projectId,
}: {
	service: ServiceOverview;
	projectId: ProjectId;
}) {
	const { data: nodes = [] } = useQuery(nodesQuery);
	const [draft, setDraft] = useState(() => draftOf(o));
	const { name, spec, command, constraints, pin } = draft;
	const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
	const setSpec = (fn: (s: ServiceSpec) => ServiceSpec) =>
		setDraft((d) => ({ ...d, spec: fn(d.spec) }));
	const app = spec.kind === "application" ? spec : null;

	const next = (): ServiceSpec =>
		spec.kind === "application"
			? {
					...spec,
					command: lines(command).length ? lines(command) : undefined,
					placement: [...(pin ? [`${PIN}${pin}`] : []), ...lines(constraints)],
				}
			: spec;
	const parsed = ServiceSpec.safeParse(next());
	const issues = parsed.success ? [] : parsed.error.issues;
	const issue = issues[0];
	const dirty =
		name.trim() !== o.name || JSON.stringify(next()) !== JSON.stringify(o.spec);

	const save = useServiceMutation(o.id, () =>
		api.serviceOps.update(o.id, {
			name: name.trim(),
			...(parsed.success ? { spec: parsed.data } : {}),
		}),
	);
	const patchApp = (patch: Partial<ApplicationSpec>) =>
		setSpec((s) => (s.kind === "application" ? { ...s, ...patch } : s));
	const resources = spec.kind === "compose" ? null : spec.resources;
	const setResources = (r: Partial<ApplicationSpec["resources"]>) =>
		setSpec((s) =>
			s.kind === "compose" ? s : { ...s, resources: { ...s.resources, ...r } },
		);

	return (
		<div className="grid gap-8">
			<Section
				title="General"
				id="general"
				description="The name shows across the dashboard. Docker objects are named from the service id, so renaming moves nothing."
			>
				<Field id="name" label="Name">
					<Input
						id="name"
						className="max-w-sm"
						value={name}
						onChange={(e) => set({ name: e.target.value })}
					/>
				</Field>
				<Field
					id="service-icon"
					label="Icon"
					hint="Saved as soon as you pick one. The default follows the engine or image."
				>
					<ServiceIconPicker service={o} />
				</Field>
			</Section>

			{app && (
				<Section
					title="Source and build"
					id="build"
					description="Applies from the next deployment."
				>
					<BuildFields spec={app} onChange={patchApp} />
				</Section>
			)}

			{o.spec.kind === "application" && o.spec.source.type === "git" && (
				<DeployTriggers serviceId={o.id} branch={o.spec.source.branch} />
			)}

			{resources && (
				<Section
					title="Resources"
					id="resources"
					description="Limits per replica. Swarm only schedules a replica on a node with this much to spare."
				>
					<div className="grid gap-4 sm:grid-cols-3">
						{app && (
							<Field id="replicas" label="Replicas">
								<Input
									id="replicas"
									type="number"
									min={0}
									value={app.replicas}
									onChange={(e) =>
										patchApp({ replicas: num(e.target.value) ?? 0 })
									}
								/>
							</Field>
						)}
						<Field
							id="cpu"
							label="CPU"
							hint="Cores; 0.5 is half a core."
							optional
						>
							<Input
								id="cpu"
								type="number"
								step="0.25"
								min={0}
								value={resources.cpu ?? ""}
								onChange={(e) => setResources({ cpu: num(e.target.value) })}
							/>
						</Field>
						<Field id="memory" label="Memory" hint="Megabytes." optional>
							<Input
								id="memory"
								type="number"
								step="64"
								min={0}
								value={resources.memoryMb ?? ""}
								onChange={(e) =>
									setResources({ memoryMb: num(e.target.value) })
								}
							/>
						</Field>
					</div>
				</Section>
			)}

			{app && (
				<>
					<Section
						title="Healthcheck"
						id="healthcheck"
						description="A new replica takes traffic, and a rollout continues, only once this passes."
					>
						<HealthcheckFields
							value={app.healthcheck}
							onChange={(healthcheck) => patchApp({ healthcheck })}
						/>
					</Section>

					<Section
						title="Command and ports"
						id="runtime"
						description="Leave the command empty to run the image's own. A published port binds on the node running the replica, or on every node through the routing mesh. Domains do not need one."
					>
						<Field
							id="command"
							label="Command"
							hint="One argument per line, run without a shell."
							optional
						>
							<Textarea
								id="command"
								rows={3}
								className="font-mono text-[13px]"
								placeholder={"node\nserver.js"}
								value={command}
								onChange={(e) => set({ command: e.target.value })}
							/>
						</Field>
						<PortRows value={app} onChange={patchApp} issues={issues} />
					</Section>

					<Section
						title="Host access"
						id="host"
						description="Host directories mounted into the container, the user it runs as, its kernel capabilities, and when Swarm restarts it."
					>
						<MountRows value={app} onChange={patchApp} issues={issues} />
						<ProcessFields
							value={app}
							onChange={patchApp}
							issues={issues}
							idPrefix="host-"
						/>
					</Section>

					<Section
						title="Placement"
						id="placement"
						description="Where replicas may run. Pinning keeps a service with local data on one node."
					>
						<div className="grid gap-4 sm:grid-cols-[16rem_minmax(0,1fr)]">
							<Field id="pin" label="Node">
								<Select
									value={pin || "any"}
									onValueChange={(v) => set({ pin: v === "any" ? "" : v })}
								>
									<SelectTrigger id="pin" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="any">Any node</SelectItem>
										{[
											...new Set([
												...nodes.map((n) => n.hostname),
												...(pin ? [pin] : []),
											]),
										].map((h) => (
											<SelectItem key={h} value={h}>
												Pin to {h}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
							<Field
								id="constraints"
								label="Constraints"
								hint="Swarm constraints, one per line, e.g. node.labels.region==eu."
								optional
							>
								<Textarea
									id="constraints"
									rows={3}
									className="font-mono text-[13px]"
									value={constraints}
									onChange={(e) => set({ constraints: e.target.value })}
								/>
							</Field>
						</div>
					</Section>
				</>
			)}

			{spec.kind === "compose" && (
				<p className="text-sm text-muted-foreground">
					A Compose service takes its runtime settings from the Compose file.
				</p>
			)}

			{dirty && (
				<div className="t-reveal sticky bottom-4 z-20 flex flex-wrap items-center justify-end gap-2 rounded-xl bg-popover px-4 py-3 shadow-float ring-1 ring-border">
					<p
						className={
							issue
								? "mr-auto text-sm text-bad-text"
								: "mr-auto text-sm text-muted-foreground"
						}
						aria-live="polite"
					>
						{issue
							? `${issue.path.join(".") || "Settings"}: ${issue.message}`
							: "Unsaved changes"}
					</p>
					<Button
						variant="ghost"
						disabled={save.isPending}
						onClick={() => setDraft(draftOf(o))}
					>
						Discard
					</Button>
					<Button
						disabled={!!issue || !name.trim() || save.isPending}
						onClick={() =>
							save.mutate(undefined, {
								onSuccess: () => toast.success("Settings saved"),
								onError: (e) =>
									toast.error("Couldn't save", { description: e.message }),
							})
						}
					>
						Save
					</Button>
				</div>
			)}

			<DangerZone service={o} projectId={projectId} />
		</div>
	);
}

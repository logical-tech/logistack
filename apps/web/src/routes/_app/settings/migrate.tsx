import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	ArrowRightLeft,
	ChevronRight,
	CircleCheck,
	CircleX,
	Loader2,
	Undo2,
} from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot, StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import {
	cutoverOrder,
	isGitHubProvider,
	isOrgItem,
	type Migration,
	type MigrationItem,
	migrationSourceQuery,
	useCreateMigration,
	useItemAction,
	useMigration,
	useMigrationAction,
} from "@/lib/api/migrations";
import { stepParam } from "@/lib/search";
import {
	MIGRATION_ITEM_STATUS,
	MIGRATION_SUPPORT,
	type StatusMeta,
	TONE_DOT,
} from "@/lib/status";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/migrate")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Migrate" },
	component: Migrate,
});

/** What the people running Dokploy call each kind, in the order an inventory reads. */
const KIND: Record<string, string> = {
	application: "App",
	compose: "Compose",
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	registry: "Registry",
	s3Destination: "S3 destination",
	notificationChannel: "Notifications",
	sshKey: "SSH key",
	gitProvider: "GitHub App",
};

type Ctx = {
	mig: Migration | undefined;
	moving: ReadonlySet<string>;
	act: (
		items: MigrationItem[],
		action: "cutover" | "rollback" | "skip" | "unskip",
	) => void;
	/** Polls until a job that sends no item events (proxy switch, decommission) reports back. */
	awaitJob: (job: "proxy" | "decommission") => void;
};

const statusOf = (i: MigrationItem, moving: ReadonlySet<string>): StatusMeta =>
	moving.has(i.id)
		? MIGRATION_ITEM_STATUS.moving
		: MIGRATION_ITEM_STATUS[i.status];

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

function Migrate() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const source = useQuery(migrationSourceQuery);
	const migrationId = source.data?.migrationId;
	const query = useMigration(migrationId);
	const items = useItemAction(migrationId ?? "");
	const mig = query.data;

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	const act: Ctx["act"] = (targets, action) => {
		if (action === "cutover" || action === "rollback")
			query.mark(targets.map((t) => t.id));
		// The worker runs one cutover at a time, in the order they were asked for.
		for (const t of targets)
			items.mutate(
				{ itemId: t.id, action },
				{
					onError: (e) => {
						query.settle(t.id);
						toast.error(
							`Couldn't ${action === "cutover" ? "move" : action} ${t.name}`,
							{
								description: e.message,
							},
						);
					},
				},
			);
	};

	if (source.isPending)
		return (
			<Page className="max-w-5xl">
				<Header />
				<Panel title="Loading">
					<SkeletonRows rows={5} />
				</Panel>
			</Page>
		);

	if (!source.data?.source && !migrationId)
		return (
			<Page className="max-w-5xl">
				<Header />
				<EmptyState
					icon={ArrowRightLeft}
					title="No Dokploy on this server"
					description="install.sh looks for Dokploy when it installs LogiStack. Run it on a server where Dokploy runs and this page walks you through moving everything over."
				/>
			</Page>
		);

	const ctx: Ctx = { mig, moving: query.moving, act, awaitJob: query.await };
	return (
		<Page className="max-w-5xl">
			<Header mig={mig} moving={query.moving} />
			<Wizard
				id="migrate-dokploy"
				steps={steps(ctx)}
				defaultValues={{}}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Done"
				onComplete={async () => {
					await navigate({ to: "/" });
				}}
			/>
		</Page>
	);
}

function Header({
	mig,
	moving,
}: {
	mig?: Migration;
	moving?: ReadonlySet<string>;
}) {
	return (
		<PageHeader
			title="Migrate from Dokploy"
			description="Dokploy keeps serving every site until you move it. Each step is reversible until you switch traffic."
			actions={mig && <MigrationStrip mig={mig} moving={moving ?? new Set()} />}
		/>
	);
}

/**
 * The migration as a signal strip: one cell per Dokploy item, in cutover order, grey while it
 * waits and green once it runs on LogiStack.
 */
function MigrationStrip({
	mig,
	moving,
}: {
	mig: Migration;
	moving: ReadonlySet<string>;
}) {
	const ordered = [...mig.items.filter(isOrgItem), ...cutoverOrder(mig.items)];
	const done = mig.items.filter((i) => i.status === "cut_over").length;
	const staying = mig.items.filter((i) => i.status === "skipped").length;
	const total = mig.items.length - staying;
	return (
		<div className="flex flex-col items-start gap-1.5 sm:items-end">
			<div
				role="img"
				aria-label={`${done} of ${total} on LogiStack`}
				className="flex flex-wrap gap-[3px]"
			>
				{ordered.map((i) => {
					const meta = statusOf(i, moving);
					return (
						<span
							key={i.id}
							title={`${i.name} · ${meta.label}`}
							className={cn(
								"h-4 w-2 rounded-[2px] transition-colors duration-(--duration-slow)",
								TONE_DOT[meta.tone],
								i.status === "skipped" && "opacity-30",
								i.status === "planned" && "opacity-45",
								meta.live && "animate-pulse",
							)}
						/>
					);
				})}
			</div>
			<p className="text-xs text-muted-foreground tabular">
				{done} of {total} on LogiStack
				{staying > 0 && ` · ${staying} staying on Dokploy`}
			</p>
		</div>
	);
}

function steps(ctx: Ctx): WizardStep<Record<string, never>>[] {
	const { mig } = ctx;
	const services = mig ? cutoverOrder(mig.items) : [];
	const org = mig ? mig.items.filter(isOrgItem) : [];
	const active = (i: MigrationItem) => i.status !== "skipped";
	return [
		{
			id: "inventory",
			title: "Review what moves",
			description:
				"LogiStack read Dokploy without changing it. Turn off anything you want to leave where it is.",
			ready: () =>
				!mig
					? "Read Dokploy to continue"
					: mig.items.some(active)
						? true
						: "Choose at least one item to move",
			render: () => <InventoryStep ctx={ctx} />,
		},
		{
			id: "import",
			title: "Import into LogiStack",
			description:
				"Creates each project, service, domain and setting here. Nothing is deployed and Dokploy keeps serving.",
			ready: () => {
				const left = mig?.items.filter(
					(i) => i.status === "planned" || i.status === "failed",
				);
				if (!left?.length) return true;
				const failed = left.filter((i) => i.status === "failed").length;
				return failed
					? `${plural(failed, "item")} failed: retry, or leave on Dokploy`
					: "Import to continue";
			},
			render: () => <ImportStep ctx={ctx} />,
		},
		{
			id: "cutover",
			title: "Move services",
			description:
				"One at a time, databases first. A service without volumes starts here before Dokploy stops, so it never goes down; one with volumes pauses while Dokploy hands them over.",
			ready: () => {
				const left = [
					...services,
					...org.filter((o) => !isGitHubProvider(o)),
				].filter((i) => active(i) && i.status !== "cut_over");
				return left.length
					? `${plural(left.length, "item")} still on Dokploy`
					: true;
			},
			render: () => <CutoverStep ctx={ctx} />,
		},
		{
			id: "proxy",
			title: "Switch traffic",
			description:
				"Hands ports 80 and 443 from Dokploy's Traefik to LogiStack, with Traefik's certificates, so no domain waits for a new one.",
			ready: () => {
				if (mig?.proxy.status !== "switched")
					return "Switch traffic to continue";
				const hooks = org.filter(
					(o) => isGitHubProvider(o) && active(o) && o.status !== "cut_over",
				);
				return hooks.length ? "Move the GitHub webhooks to continue" : true;
			},
			render: () => <ProxyStep ctx={ctx} />,
		},
		{
			id: "summary",
			title: "Done",
			description:
				"Everything you chose runs on LogiStack. When you're ready, archive and remove Dokploy.",
			render: () => <SummaryStep ctx={ctx} />,
		},
	];
}

function InventoryStep({ ctx }: { ctx: Ctx }) {
	const create = useCreateMigration();
	const { mig } = ctx;
	if (!mig)
		return (
			<div className="rounded-xl bg-card px-5 py-6 shadow-card ring-1 ring-border">
				<p className="max-w-[62ch] text-sm text-pretty">
					LogiStack reads Dokploy's database and compose files, read-only, and
					lists every project, service and setting it found, with what carries
					over and what does not.
				</p>
				<Button
					type="button"
					className="mt-4"
					disabled={create.isPending}
					onClick={() =>
						create.mutate(undefined, {
							onError: (e) =>
								toast.error("Couldn't read Dokploy", {
									description: e.message,
								}),
						})
					}
				>
					{create.isPending && <Loader2 className="animate-spin" />}
					Read Dokploy
				</Button>
			</div>
		);
	return (
		<ItemGroups
			mig={mig}
			row={(i) => (
				<ItemRow
					item={i}
					status={<StatusLabel meta={MIGRATION_SUPPORT[i.support]} />}
					action={
						<Switch
							checked={i.status !== "skipped"}
							disabled={
								i.support === "unsupported" ||
								(i.status !== "planned" && i.status !== "skipped")
							}
							onCheckedChange={(on) => ctx.act([i], on ? "unskip" : "skip")}
							aria-label={`Move ${i.name}`}
						/>
					}
					showNotes
				/>
			)}
		/>
	);
}

function ImportStep({ ctx }: { ctx: Ctx }) {
	const { mig, moving } = ctx;
	const run = useMigrationAction(mig?.id ?? "");
	if (!mig) return null;
	const left = mig.items.filter(
		(i) => i.status === "planned" || i.status === "failed",
	);
	const failed = left.filter((i) => i.status === "failed").length;
	const importing = mig.status === "importing" || run.isPending;
	return (
		<div className="flex flex-col gap-6">
			{left.length || importing ? (
				<div>
					<Button
						type="button"
						disabled={importing}
						onClick={() =>
							run.mutate(
								{ kind: "import" },
								{
									onError: (e) =>
										toast.error("Couldn't start the import", {
											description: e.message,
										}),
								},
							)
						}
					>
						{importing && <Loader2 className="animate-spin" />}
						{importing
							? "Importing"
							: failed
								? `Retry ${plural(failed, "failed item")}`
								: `Import ${plural(left.length, "item")}`}
					</Button>
				</div>
			) : (
				<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<CircleCheck className="size-4 text-ok-text" aria-hidden />
					Everything is imported. Nothing runs on LogiStack yet.
				</p>
			)}
			<ItemGroups
				mig={mig}
				hideSkipped
				row={(i) => (
					<ItemRow
						item={i}
						status={
							<StatusLabel
								meta={
									importing && (i.status === "planned" || i.status === "failed")
										? MIGRATION_ITEM_STATUS.moving
										: statusOf(i, moving)
								}
							/>
						}
						action={
							i.status === "failed" ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => ctx.act([i], "skip")}
								>
									Leave on Dokploy
								</Button>
							) : null
						}
					/>
				)}
			/>
		</div>
	);
}

function CutoverStep({ ctx }: { ctx: Ctx }) {
	const { mig, moving, act } = ctx;
	const [confirm, setConfirm] = useState(false);
	if (!mig) return null;
	const orgWaiting = mig.items.filter(
		(i) => isOrgItem(i) && !isGitHubProvider(i) && i.status === "imported",
	);
	const order = cutoverOrder(mig.items).filter((i) => i.status !== "skipped");
	const waiting = order.filter(
		(i) =>
			(i.status === "imported" || i.status === "rolled_back") &&
			!moving.has(i.id),
	);
	const pausing = waiting.filter((i) =>
		i.services.some((s) => s.stateful),
	).length;
	const busy = order.some((i) => moving.has(i.id));
	const settings = mig.items.filter(
		(i) => isOrgItem(i) && !isGitHubProvider(i) && i.status !== "skipped",
	);
	return (
		<div className="flex flex-col gap-6">
			{waiting.length || orgWaiting.length ? (
				<div className="flex flex-wrap items-center gap-3">
					<Button type="button" onClick={() => setConfirm(true)}>
						{waiting.length
							? `Move ${plural(waiting.length, "service")} in order`
							: "Move the settings"}
					</Button>
					<p className="text-sm text-muted-foreground">
						Or move them one by one below.
					</p>
				</div>
			) : busy ? (
				<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" aria-hidden />
					Moving, one at a time
				</p>
			) : (
				<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<CircleCheck className="size-4 text-ok-text" aria-hidden />
					Every service you chose runs on LogiStack.
				</p>
			)}
			<Panel title="Services" bodyClassName="divide-y">
				{order.map((i) => (
					<ItemRow
						key={i.id}
						item={i}
						detail={
							i.services.every((s) => !s.running)
								? "Stopped on Dokploy: moves without starting"
								: i.services.some((s) => s.stateful)
									? "Pauses while its volumes move"
									: "No downtime"
						}
						status={<StatusLabel meta={statusOf(i, moving)} />}
						action={<CutoverAction item={i} ctx={ctx} />}
					/>
				))}
			</Panel>
			{settings.length > 0 && (
				<Panel title="Settings" bodyClassName="divide-y">
					{settings.map((i) => (
						<ItemRow
							key={i.id}
							item={i}
							detail="Already in use here: nothing to switch"
							status={<StatusLabel meta={statusOf(i, moving)} />}
							action={<CutoverAction item={i} ctx={ctx} />}
						/>
					))}
				</Panel>
			)}
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				destructive={false}
				title={
					waiting.length
						? `Move ${plural(waiting.length, "service")}?`
						: "Move the settings?"
				}
				description={
					pausing
						? `They move one at a time, databases first. ${plural(pausing, "service")} with volumes ${pausing === 1 ? "pauses" : "pause"} for a few seconds while Dokploy stops. Any that fails goes back to Dokploy on its own.`
						: "They move one at a time, databases first, without downtime. Any that fails goes back to Dokploy on its own."
				}
				confirmLabel={waiting.length ? "Move services" : "Move settings"}
				pending={false}
				onConfirm={() => {
					setConfirm(false);
					act([...orgWaiting, ...waiting], "cutover");
				}}
			/>
		</div>
	);
}

function CutoverAction({ item, ctx }: { item: MigrationItem; ctx: Ctx }) {
	if (ctx.moving.has(item.id))
		return (
			<Loader2
				className="size-4 animate-spin text-muted-foreground"
				aria-label="In progress"
			/>
		);
	if (item.status === "cut_over")
		return (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={() => ctx.act([item], "rollback")}
			>
				<Undo2 data-icon="inline-start" />
				Move back
			</Button>
		);
	if (item.status === "imported" || item.status === "rolled_back")
		return (
			<div className="flex items-center gap-1">
				{item.status === "rolled_back" && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => ctx.act([item], "skip")}
					>
						Leave on Dokploy
					</Button>
				)}
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => ctx.act([item], "cutover")}
				>
					{item.status === "rolled_back" ? "Try again" : "Move"}
				</Button>
			</div>
		);
	return null;
}

function ProxyStep({ ctx }: { ctx: Ctx }) {
	const { mig, moving, act } = ctx;
	const run = useMigrationAction(mig?.id ?? "");
	const [confirm, setConfirm] = useState(false);
	if (!mig) return null;
	const p = mig.proxy;
	const switching =
		run.isPending || (run.isSuccess && p.status === "not_started");
	const hooks = mig.items.filter(
		(i) => isGitHubProvider(i) && i.status !== "skipped",
	);
	return (
		<div className="flex flex-col gap-6">
			{p.status !== "switched" && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						type="button"
						disabled={switching}
						onClick={() => setConfirm(true)}
					>
						{switching && <Loader2 className="animate-spin" />}
						{switching ? "Switching traffic" : "Switch traffic"}
					</Button>
					{p.status === "fell_back" && (
						<p className="flex items-center gap-1.5 text-sm text-bad-text">
							<CircleX className="size-4" aria-hidden />
							{p.error}
						</p>
					)}
				</div>
			)}
			{p.certificates && (
				<Panel title="Certificates" bodyClassName="divide-y">
					{p.certificates.imported.map((h) => (
						<HostRow key={h} host={h} ok detail="Imported from Traefik" />
					))}
					{p.certificates.skipped.map((s) => (
						<HostRow
							key={s.hostname}
							host={s.hostname}
							ok={false}
							soft
							detail={`Issued fresh: ${s.reason}`}
						/>
					))}
					{p.certificates.error && (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							Traefik's certificates could not be read ({p.certificates.error}).
							Caddy issues them instead.
						</p>
					)}
				</Panel>
			)}
			{p.status === "switched" && (
				<Panel title="Domains" bodyClassName="divide-y">
					{p.probes.length ? (
						p.probes.map((pr) => (
							<HostRow
								key={pr.hostname}
								host={pr.hostname}
								ok={pr.ok}
								detail={pr.detail}
							/>
						))
					) : (
						<p className="px-4 py-3 text-sm text-muted-foreground">
							No moved service has a domain.
						</p>
					)}
				</Panel>
			)}
			{p.status === "switched" && hooks.length > 0 && (
				<Panel title="GitHub" bodyClassName="divide-y">
					{hooks.map((i) => (
						<ItemRow
							key={i.id}
							item={i}
							detail="Pushes reach LogiStack once its webhook moves"
							status={<StatusLabel meta={statusOf(i, moving)} />}
							action={
								i.status === "imported" && !moving.has(i.id) ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => act([i], "cutover")}
									>
										Move webhook
									</Button>
								) : null
							}
						/>
					))}
				</Panel>
			)}
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				destructive={false}
				title="Switch traffic to LogiStack?"
				description="Traefik stops and LogiStack takes ports 80 and 443, usually within seconds. If LogiStack does not come up in 90 seconds, Traefik starts again on its own."
				confirmLabel="Switch traffic"
				pending={run.isPending}
				onConfirm={() =>
					run.mutate(
						{ kind: "proxy" },
						{
							onSuccess: () => ctx.awaitJob("proxy"),
							onSettled: () => setConfirm(false),
							onError: (e) =>
								toast.error("Couldn't switch traffic", {
									description: e.message,
								}),
						},
					)
				}
			/>
		</div>
	);
}

function SummaryStep({ ctx }: { ctx: Ctx }) {
	const { mig, moving } = ctx;
	if (!mig) return null;
	const moved = mig.items.filter((i) => i.status === "cut_over");
	const staying = mig.items.filter((i) => i.status === "skipped");
	return (
		<div className="flex flex-col gap-6">
			<Panel title={`On LogiStack (${moved.length})`} bodyClassName="divide-y">
				{moved.map((i) => (
					<ItemRow
						key={i.id}
						item={i}
						status={<StatusLabel meta={statusOf(i, moving)} />}
					/>
				))}
			</Panel>
			{staying.length > 0 && (
				<Panel
					title={`Still on Dokploy (${staying.length})`}
					bodyClassName="divide-y"
				>
					{staying.map((i) => (
						<ItemRow key={i.id} item={i} showNotes />
					))}
				</Panel>
			)}
			<RemoveDokploy ctx={ctx} />
		</div>
	);
}

/** Archive, then remove: the last, deliberate step. Volumes and items left on Dokploy stay. */
function RemoveDokploy({ ctx }: { ctx: Ctx }) {
	const mig = ctx.mig as Migration;
	const run = useMigrationAction(mig.id);
	const [confirm, setConfirm] = useState(false);
	const [typed, setTyped] = useState("");
	const d = mig.decommission;
	const removing =
		run.isPending || (run.isSuccess && d.status === "not_started");
	if (d.status === "done")
		return (
			<Panel title="Dokploy removed" bodyClassName="divide-y">
				<div className="px-4 py-3 text-sm">
					<p>Archived on the server, readable by root only:</p>
					<p className="mt-1 font-mono text-xs break-all text-muted-foreground">
						{d.archivePath}
					</p>
					<p className="mt-2 text-xs text-muted-foreground">
						Database dump, a copy of /etc/dokploy and the inventory. Volumes are
						kept.
					</p>
				</div>
				<div className="px-4 py-3 text-sm">
					<p>
						Removed{" "}
						{plural(
							d.removed.length,
							"service or container",
							"services and containers",
						)}
					</p>
					<p className="mt-1 font-mono text-xs text-muted-foreground">
						{d.removed.join(", ")}
					</p>
				</div>
				{d.kept.map((k) => (
					<div
						key={k.name}
						className="flex flex-wrap gap-x-3 px-4 py-3 text-sm"
					>
						<span className="font-medium">{k.name}</span>
						<span className="text-muted-foreground">Kept: {k.reason}</span>
					</div>
				))}
			</Panel>
		);
	return (
		<section className="rounded-xl bg-card px-5 py-5 shadow-card ring-1 ring-border">
			<h3 className="text-sm font-semibold">Remove Dokploy</h3>
			<p className="mt-1 max-w-[62ch] text-sm text-muted-foreground text-pretty">
				Archives Dokploy's database and configuration on this server, then
				removes its services and Traefik. Volumes and anything you left on
				Dokploy stay.
			</p>
			{d.status === "failed" && (
				<p className="mt-3 flex gap-1.5 text-sm text-bad-text">
					<CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
					<span className="min-w-0 break-words">{d.error}</span>
				</p>
			)}
			<div className="mt-4 flex flex-wrap items-center gap-3">
				<Button
					type="button"
					variant="destructive"
					disabled={Boolean(mig.decommissionBlocker) || removing}
					onClick={() => setConfirm(true)}
				>
					{removing && <Loader2 className="animate-spin" />}
					{removing
						? "Archiving and removing"
						: d.status === "failed"
							? "Try again"
							: "Remove Dokploy"}
				</Button>
				{mig.decommissionBlocker && (
					<p className="text-sm text-muted-foreground">
						Not yet: {mig.decommissionBlocker}.
					</p>
				)}
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={(o) => {
					setConfirm(o);
					if (!o) setTyped("");
				}}
				title="Remove Dokploy?"
				description="Its services and Traefik are removed after its database and configuration are archived. This cannot be undone from LogiStack."
				confirmLabel="Remove Dokploy"
				pending={run.isPending}
				confirmDisabled={typed.trim() !== "dokploy"}
				onConfirm={() =>
					run.mutate(
						{ kind: "decommission" },
						{
							onSuccess: () => ctx.awaitJob("decommission"),
							onSettled: () => {
								setConfirm(false);
								setTyped("");
							},
							onError: (e) =>
								toast.error("Couldn't remove Dokploy", {
									description: e.message,
								}),
						},
					)
				}
			>
				<label className="mt-2 block text-sm" htmlFor="confirm-dokploy">
					Type <span className="font-mono">dokploy</span> to confirm
				</label>
				<Input
					id="confirm-dokploy"
					className="mt-1.5"
					autoComplete="off"
					value={typed}
					onChange={(e) => setTyped(e.target.value)}
				/>
			</ConfirmDialog>
		</section>
	);
}

/** Items by project and environment, organization resources first. */
function ItemGroups({
	mig,
	row,
	hideSkipped,
}: {
	mig: Migration;
	row: (i: MigrationItem) => ReactNode;
	hideSkipped?: boolean;
}) {
	const shown = mig.items.filter((i) => !hideSkipped || i.status !== "skipped");
	const groups = new Map<string, MigrationItem[]>();
	for (const i of shown) {
		const key = i.project ? `${i.project} · ${i.environment}` : "Organization";
		groups.set(key, [...(groups.get(key) ?? []), i]);
	}
	return (
		<div className="flex flex-col gap-6">
			{[...groups].map(([title, list]) => (
				<Panel key={title} title={title} bodyClassName="divide-y">
					{list.map((i) => (
						<div key={i.id}>{row(i)}</div>
					))}
				</Panel>
			))}
		</div>
	);
}

function ItemRow({
	item,
	status,
	action,
	detail,
	showNotes,
}: {
	item: MigrationItem;
	status?: ReactNode;
	action?: ReactNode;
	detail?: string;
	showNotes?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const domains = item.services.flatMap((s) => s.domains);
	const sub =
		detail ??
		[
			item.services.length > 1 ? plural(item.services.length, "service") : null,
			domains.length ? domains.join(", ") : null,
			item.services.length && item.services.every((s) => !s.running)
				? "Stopped on Dokploy"
				: null,
		]
			.filter(Boolean)
			.join(" · ");
	const notes = showNotes ? item.notes : [];
	return (
		<div
			className={cn("px-4 py-3", item.status === "skipped" && "bg-muted/30")}
		>
			{/* On a phone the name takes the first line and the status and action the second. */}
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
					<p className="flex items-baseline gap-2 text-sm">
						<span
							className={cn(
								"truncate font-medium",
								item.status === "skipped" && "text-muted-foreground",
							)}
						>
							{item.name}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">
							{KIND[item.kind] ?? item.kind}
						</span>
					</p>
					{sub && (
						<p className="mt-0.5 truncate text-xs text-muted-foreground">
							{sub}
						</p>
					)}
				</div>
				{notes.length > 0 && (
					<button
						type="button"
						onClick={() => setOpen((o) => !o)}
						aria-expanded={open}
						className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-(--duration-quick) hover:bg-muted hover:text-foreground"
					>
						{plural(notes.length, "note")}
						<ChevronRight
							className={cn(
								"size-3.5 transition-transform duration-(--duration-fast)",
								open && "rotate-90",
							)}
							aria-hidden
						/>
					</button>
				)}
				{status && (
					<div className="shrink-0 max-sm:flex-1 sm:w-36 sm:text-right">
						{status}
					</div>
				)}
				{action && <div className="flex shrink-0 justify-end">{action}</div>}
			</div>
			{item.lastError && (
				<p className="mt-2 flex gap-1.5 text-xs text-bad-text">
					<CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
					<span className="min-w-0 break-words">{item.lastError}</span>
				</p>
			)}
			{open && (
				<ul className="mt-2 flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
					{notes.map((n) => (
						<li key={n}>{n}</li>
					))}
				</ul>
			)}
		</div>
	);
}

function HostRow({
	host,
	ok,
	soft,
	detail,
}: {
	host: string;
	ok: boolean;
	soft?: boolean;
	detail: string;
}) {
	return (
		<div className="flex items-center gap-3 px-4 py-3 text-sm">
			{ok ? (
				<CircleCheck
					className="size-4 shrink-0 text-ok-text"
					aria-label="Done"
				/>
			) : soft ? (
				<StatusDot meta={{ label: "", tone: "idle" }} className="mx-1" />
			) : (
				<CircleX
					className="size-4 shrink-0 text-bad-text"
					aria-label="Failed"
				/>
			)}
			<span className="min-w-0 flex-1 truncate font-mono">{host}</span>
			<span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
		</div>
	);
}

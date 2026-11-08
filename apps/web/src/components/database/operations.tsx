import type {
	DatabaseAccessView,
	DatabaseEngine,
	DatabaseUpgradeView,
} from "@logistack/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Globe, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	accessQuery,
	upgradesQuery,
	useDatabaseOps,
} from "@/lib/api/database-ops";
import { overviewQuery, type ServiceOverview } from "@/lib/api/service-ops";
import type { StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import { UPGRADE_STEPS } from "./operations-wizards";

export type OperationsWizard = "public" | "forward" | "upgrade";

const ACCESS_STATUS: Record<DatabaseAccessView["status"], StatusMeta> = {
	pending: { label: "Starting", tone: "busy", live: true },
	waiting_certificate: {
		label: "Waiting for certificate",
		tone: "busy",
		live: true,
	},
	active: { label: "Open", tone: "ok" },
	error: { label: "Error", tone: "bad" },
};

const UPGRADE_STATUS: Record<DatabaseUpgradeView["status"], StatusMeta> = {
	running: { label: "Running", tone: "info", live: true },
	succeeded: { label: "Upgraded", tone: "ok" },
	rolled_back: { label: "Rolled back", tone: "warn" },
	failed: { label: "Failed", tone: "bad" },
};

const UPGRADABLE = new Set<DatabaseEngine>([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
]);

/** "in 42 min", ticking once a minute; `tabular-nums` keeps it from shifting. */
function useCountdown(iso: string | null) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!iso) return;
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, [iso]);
	if (!iso) return null;
	const min = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
	return min >= 60
		? `${Math.floor(min / 60)} h ${min % 60} min left`
		: `${min} min left`;
}

function Status({ meta }: { meta: StatusMeta }) {
	return (
		<span className="inline-flex items-center gap-2 text-sm">
			<StatusDot meta={meta} />
			{meta.label}
		</span>
	);
}

/** The connection URI with a copy button; the password stays a placeholder. */
function Uri({ uri }: { uri: string }) {
	return (
		<div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/60 py-1 pr-1 pl-3 dark:bg-muted/40">
			<code className="min-w-0 flex-1 truncate font-mono text-xs" title={uri}>
				{uri}
			</code>
			<CopyButton value={uri} label="Copy connection string" />
		</div>
	);
}

function AccessRow({
	a,
	onClose,
}: {
	a: DatabaseAccessView;
	onClose: () => void;
}) {
	const left = useCountdown(a.expiresAt);
	return (
		<li className="grid gap-3 px-4 py-4">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span className="font-mono text-sm">
					{a.host ?? "—"}:{a.port}
				</span>
				<Status meta={ACCESS_STATUS[a.status]} />
				{left && (
					<span className="text-sm tabular-nums text-muted-foreground">
						{left}
					</span>
				)}
				<Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
					Close
				</Button>
			</div>
			{a.statusMessage &&
				a.status !== "active" &&
				a.status !== "waiting_certificate" && (
					<p className="text-sm text-pretty text-muted-foreground">
						{a.statusMessage}
					</p>
				)}
			{a.uri && <Uri uri={a.uri} />}
			<p className="text-xs text-muted-foreground">
				{a.tlsRequired ? "TLS required" : "Plain, without TLS"} · open to{" "}
				<span className="font-mono">{a.allowedCidrs.join(", ")}</span>
			</p>
		</li>
	);
}

/** The Operations tab of a database: public access, port forwards and major-version upgrades. */
export function DatabaseOperations({
	service,
	onWizard,
}: {
	service: ServiceOverview;
	onWizard: (wizard: OperationsWizard) => void;
}) {
	const spec = service.spec.kind === "database" ? service.spec : null;
	const access = useQuery(accessQuery(service.id));
	const upgrades = useQuery(upgradesQuery(service.id));
	const ops = useDatabaseOps(service.id);
	const [closing, setClosing] = useState<DatabaseAccessView | null>(null);
	const rows = access.data?.access ?? [];
	const pub = rows.find((a) => a.kind === "public");
	const forwards = rows.filter((a) => a.kind === "forward");
	const exposable = access.data?.exposable ?? true;
	const running = upgrades.data?.find((u) => u.status === "running");
	const last = upgrades.data?.[0];
	const qc = useQueryClient();
	const lastState = last ? `${last.id}:${last.status}` : "";
	// A finished upgrade changed the version (or put it back): reread the service.
	useEffect(() => {
		if (lastState && !lastState.endsWith(":running"))
			qc.invalidateQueries({ queryKey: overviewQuery(service.id).queryKey });
	}, [lastState, qc, service.id]);
	if (!spec) return null;

	const close = async () => {
		if (!closing) return;
		try {
			if (closing.kind === "public") await ops.closePublic.mutateAsync();
			else await ops.closeForward.mutateAsync(closing.id);
			toast.success(
				closing.kind === "public"
					? "Public access closed"
					: "Port forward closed",
			);
			setClosing(null);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Could not close it");
		}
	};

	return (
		<div className="grid gap-8">
			<Panel
				title="Public access"
				id="db-public"
				actions={
					exposable && (
						<Button
							size="sm"
							variant={pub ? "outline" : "default"}
							onClick={() => onWizard("public")}
						>
							<Globe data-icon="inline-start" />
							{pub ? "Change" : "Expose publicly"}
						</Button>
					)
				}
			>
				{access.isPending ? (
					<SkeletonRows rows={1} />
				) : !exposable ? (
					<p className="px-4 py-5 text-sm text-muted-foreground">
						libSQL speaks HTTP with no TLS of its own, so it can't be exposed.
					</p>
				) : pub ? (
					<ul>
						<AccessRow a={pub} onClose={() => setClosing(pub)} />
					</ul>
				) : (
					<p className="px-4 py-5 text-sm text-pretty text-muted-foreground">
						Only services in this environment reach the database. Expose it on a
						hostname with a certificate: clients must use TLS and connect from
						addresses you allow.
					</p>
				)}
			</Panel>

			<Panel
				title="Port forwards"
				id="db-forwards"
				actions={
					exposable && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => onWizard("forward")}
						>
							<Timer data-icon="inline-start" />
							Open a port forward
						</Button>
					)
				}
			>
				{access.isPending ? (
					<SkeletonRows rows={1} />
				) : forwards.length ? (
					<ul className="divide-y">
						{forwards.map((f) => (
							<AccessRow key={f.id} a={f} onClose={() => setClosing(f)} />
						))}
					</ul>
				) : (
					<p className="px-4 py-5 text-sm text-pretty text-muted-foreground">
						Connect a local tool for a while: a port open to your address only,
						closed on its own when the time runs out.
					</p>
				)}
			</Panel>

			<Panel
				title="Version"
				id="db-version"
				actions={
					UPGRADABLE.has(spec.engine) && (
						<Button
							size="sm"
							variant="outline"
							disabled={!!running}
							onClick={() => onWizard("upgrade")}
						>
							<ArrowUpCircle data-icon="inline-start" />
							Upgrade
						</Button>
					)
				}
			>
				<div className="grid gap-4 px-4 py-4">
					<p className="text-sm">
						Running <span className="font-mono">{spec.version}</span>
						{!UPGRADABLE.has(spec.engine) && (
							<span className="text-muted-foreground">
								{" "}
								· {spec.engine === "redis" ? "Redis" : "libSQL"} upgrades go
								through a volume backup
							</span>
						)}
					</p>
					{last && <UpgradeProgress u={last} />}
				</div>
			</Panel>

			<ConfirmDialog
				open={!!closing}
				onOpenChange={(o) => !o && setClosing(null)}
				title={
					closing?.kind === "public"
						? "Close public access?"
						: "Close this port forward?"
				}
				description={
					closing?.kind === "public"
						? "The port closes within seconds and clients connected through it are cut off. Services in the environment are not affected."
						: "Tools connected through it are cut off now instead of at the deadline."
				}
				confirmLabel="Close"
				pending={ops.closePublic.isPending || ops.closeForward.isPending}
				onConfirm={close}
			/>
		</div>
	);
}

/** The steps of the last upgrade, the current one live, then the outcome in words. */
export function UpgradeProgress({ u }: { u: DatabaseUpgradeView }) {
	const failedAt =
		u.status === "running"
			? -1
			: UPGRADE_STEPS.findIndex((s) => s.id === u.step);
	const at = UPGRADE_STEPS.findIndex((s) => s.id === u.step);
	return (
		<div className="grid gap-3 rounded-lg bg-muted/40 p-4">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="text-sm font-medium">
					<span className="font-mono">{u.fromVersion}</span> to{" "}
					<span className="font-mono">{u.toVersion}</span>
				</span>
				<Status meta={UPGRADE_STATUS[u.status]} />
			</div>
			<ol className="grid gap-1.5 sm:grid-cols-6" aria-label="Upgrade steps">
				{UPGRADE_STEPS.map((s, i) => {
					const done =
						u.status === "succeeded" ||
						(u.status !== "failed" && i < at) ||
						(u.status === "failed" && i < failedAt);
					const current = u.status === "running" && i === at;
					return (
						<li
							key={s.id}
							aria-current={current ? "step" : undefined}
							className="grid gap-1.5"
						>
							<span
								className={cn(
									"h-1 rounded-full bg-muted-foreground/15 transition-colors duration-(--duration-fast)",
									done && "bg-ok",
									current && "t-skel bg-info",
								)}
							/>
							<span
								className={cn(
									"text-xs",
									done || current ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{s.label}
							</span>
						</li>
					);
				})}
			</ol>
			{u.message && (
				<p
					className={cn(
						"text-sm text-pretty",
						u.status === "failed" ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					{u.message}
				</p>
			)}
		</div>
	);
}

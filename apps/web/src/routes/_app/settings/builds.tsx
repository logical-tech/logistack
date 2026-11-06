import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { meQuery } from "@/lib/api/access";
import {
	archOf,
	type BuildPlatforms,
	buildPlatformsQuery,
	useCheckBuildkit,
} from "@/lib/api/builds";
import { relativeTime } from "@/lib/format";
import type { StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/builds")({
	staticData: { crumb: "Builds" },
	component: Builds,
});

const PLATFORMS = [
	{ id: "linux/amd64", servers: "Intel and AMD servers" },
	{
		id: "linux/arm64",
		servers: "ARM servers: Graviton, Ampere, Apple silicon",
	},
] as const;

/** How BuildKit stands toward one platform: on its own CPU, through QEMU, or not at all. */
function support(p: BuildPlatforms, id: string): StatusMeta {
	const all = p.buildkit.platforms;
	if (!all) return { label: "Not checked yet", tone: "idle" };
	if (all[0] === id) return { label: "Native", tone: "ok" };
	if (all.some((b) => b === id || b.startsWith(`${id}/`)))
		return { label: "Emulated", tone: "ok" };
	return {
		label: "Can't build",
		tone: p.swarm.includes(id as never) ? "warn" : "idle",
	};
}

function Footer({ p, admin }: { p: BuildPlatforms; admin: boolean }) {
	const e = p.buildkit.emulation;
	const needed = p.missing.some((m) => p.swarm.includes(m));
	const setup = (label: string) =>
		admin ? (
			<Button asChild variant={needed ? "default" : "outline"}>
				<Link to="/settings/builds/emulation">{label}</Link>
			</Button>
		) : (
			<p className="text-[13px] text-muted-foreground">
				An admin can set up emulation.
			</p>
		);
	const status: StatusMeta | null =
		e?.state === "installing"
			? { label: "Setting up emulation", tone: "busy", live: true }
			: e?.state === "failed"
				? { label: "Emulation setup failed", tone: "bad" }
				: p.buildkit.error
					? { label: "BuildKit didn't answer", tone: "bad" }
					: null;
	const detail =
		e?.state === "failed"
			? e.error
			: e?.state === "installing"
				? "Registering QEMU in the kernel, then restarting BuildKit."
				: p.buildkit.error
					? p.buildkit.error
					: p.buildkit.checkedAt
						? `Checked ${relativeTime(p.buildkit.checkedAt)}`
						: "BuildKit reports its platforms the first time it builds or is checked.";
	return (
		<div className="flex flex-col gap-3 border-t bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
			<div className="min-w-0">
				{status && <StatusLabel meta={status} />}
				<p
					className={cn(
						"text-[13px] text-pretty text-muted-foreground",
						status && "mt-0.5",
					)}
				>
					{detail}
				</p>
			</div>
			{e?.state !== "installing" &&
				p.missing.length > 0 &&
				setup(e?.state === "failed" ? "Try again" : "Set up emulation")}
		</div>
	);
}

function Builds() {
	const { data: p, isPending, error } = useQuery(buildPlatformsQuery);
	const { data: me } = useQuery(meQuery);
	const admin = !!me?.roles.some((r) => r === "owner" || r === "admin");
	const check = useCheckBuildkit();

	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="Builds"
				description="Which processor architectures your images are built for, and whether BuildKit can build them."
				actions={
					admin && (
						<Button
							variant="outline"
							disabled={!p || check.isPending}
							onClick={() =>
								check.mutate(undefined, {
									onError: (err) =>
										toast.error("Couldn't check BuildKit", {
											description: err.message,
										}),
								})
							}
						>
							<RefreshCw className={cn(check.isPending && "animate-spin")} />
							Check BuildKit
						</Button>
					)
				}
			/>
			<div className="grid gap-8">
				<Panel id="architectures" title="Architectures">
					{isPending ? (
						<SkeletonRows rows={2} />
					) : !p ? (
						<p className="p-4 text-sm text-bad-text">
							{error?.message ?? "The build platforms didn't load."}
						</p>
					) : (
						<>
							<table className="w-full text-sm">
								<thead className="sr-only">
									<tr>
										<th>Architecture</th>
										<th>Servers in this swarm</th>
										<th>BuildKit</th>
									</tr>
								</thead>
								<tbody className="divide-y">
									{PLATFORMS.map((row) => (
										<tr key={row.id}>
											<td className="px-4 py-3.5 sm:px-5">
												<div className="font-mono font-medium">
													{archOf(row.id)}
												</div>
												<div className="mt-0.5 text-[13px] text-muted-foreground">
													{row.servers}
												</div>
											</td>
											<td className="hidden px-4 py-3.5 text-[13px] text-muted-foreground sm:table-cell">
												{p.swarm.includes(row.id)
													? "In this swarm"
													: "No servers"}
											</td>
											<td className="px-4 py-3.5 text-right sm:px-5">
												<StatusLabel meta={support(p, row.id)} />
											</td>
										</tr>
									))}
								</tbody>
							</table>
							<Footer p={p} admin={admin} />
						</>
					)}
				</Panel>

				<Panel id="how" title="How a build picks its architectures">
					<dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:px-5">
						<dt className="font-medium">Automatic</dt>
						<dd className="max-w-[62ch] text-pretty text-muted-foreground">
							A service builds for every architecture in the swarm
							{p?.swarm.length
								? `, today ${p.swarm.map(archOf).join(" and ")}`
								: ""}
							. Pick one or both under the service's Build settings to override
							it.
						</dd>
						<dt className="font-medium">Both at once</dt>
						<dd className="max-w-[62ch] text-pretty text-muted-foreground">
							A Dockerfile built for amd64 and arm64 becomes one image that
							every server pulls its own half of. BuildKit pushes it straight to
							the registry, so it needs one. Railpack builds one architecture
							per image.
						</dd>
						<dt className="font-medium">Placement</dt>
						<dd className="max-w-[62ch] text-pretty text-muted-foreground">
							A service only runs on servers of the architectures its image was
							built for. A single-architecture image never lands on the other
							kind.
						</dd>
						<dt className="font-medium">Emulation</dt>
						<dd className="max-w-[62ch] text-pretty text-muted-foreground">
							BuildKit builds a foreign architecture through QEMU, several times
							slower than on its own CPU. Nothing is set up without you asking.
						</dd>
					</dl>
				</Panel>
			</div>
		</Page>
	);
}

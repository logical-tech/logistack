import { filterNetworkMap } from "@logistack/core/network-map";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search, Waypoints } from "lucide-react";
import { useMemo } from "react";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { NetworkMapCanvas } from "@/components/network/network-map";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { networkMapQuery } from "@/lib/api/network-map";
import { section } from "@/lib/nav";

const ALL = "\u0000all";
const opt = z.string().optional().catch(undefined);

export const Route = createFileRoute("/_app/network")({
	staticData: { crumb: "Network" },
	validateSearch: z.object({ project: opt, env: opt, q: opt }),
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(networkMapQuery);
	},
	component: NetworkPage,
});

function NetworkPage() {
	const s = section("/network");
	const { project, env, q } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { data, isPending } = useQuery(networkMapQuery);

	// Projects and their environments as the map has them, for the two pickers.
	const scopes = useMemo(() => {
		const projects = new Map<
			string,
			{ name: string; envs: Map<string, string> }
		>();
		for (const n of data?.nodes ?? [])
			if (n.type === "service") {
				const p = projects.get(n.projectId) ?? {
					name: n.projectName,
					envs: new Map(),
				};
				p.envs.set(n.environmentId, n.environmentName);
				projects.set(n.projectId, p);
			}
		return projects;
	}, [data]);
	const envs = project ? scopes.get(project)?.envs : undefined;
	const map = useMemo(
		() =>
			data &&
			filterNetworkMap(data, {
				projectId: project,
				environmentId: env,
				query: q,
			}),
		[data, project, env, q],
	);
	const set = (next: { project?: string; env?: string; q?: string }) =>
		navigate({
			search: (prev) => ({ ...prev, ...next }),
			replace: true,
		});
	const services = map?.nodes.filter((n) => n.type === "service").length ?? 0;
	const domains = map?.nodes.filter((n) => n.type === "domain").length ?? 0;
	const tasks = map?.nodes.filter((n) => n.type === "task").length ?? 0;

	return (
		<Page className="flex max-w-none flex-col lg:h-[calc(100dvh-3.5rem)]">
			<PageHeader title={s.title} description={s.description} />
			{isPending ? (
				<Skeleton className="h-[480px] w-full flex-1 rounded-xl" />
			) : !data?.nodes.some((n) => n.type === "service") ? (
				<EmptyState
					icon={Waypoints}
					title={s.empty?.title ?? "Nothing to map yet"}
					description={s.empty?.body}
				/>
			) : (
				<div className="relative flex h-[640px] min-h-[480px] flex-col overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border lg:h-auto lg:flex-1">
					<NetworkMapCanvas
						map={map ?? data}
						toolbar={
							<>
								<Select
									value={project ?? ALL}
									onValueChange={(v) =>
										set({ project: v === ALL ? undefined : v, env: undefined })
									}
								>
									<SelectTrigger
										size="sm"
										className="w-44"
										aria-label="Project shown on the map"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ALL}>All projects</SelectItem>
										{[...scopes].map(([id, p]) => (
											<SelectItem key={id} value={id}>
												{p.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{envs && envs.size > 1 && (
									<Select
										value={env ?? ALL}
										onValueChange={(v) =>
											set({ env: v === ALL ? undefined : v })
										}
									>
										<SelectTrigger
											size="sm"
											className="w-40"
											aria-label="Environment shown on the map"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ALL}>All environments</SelectItem>
											{[...envs].map(([id, name]) => (
												<SelectItem key={id} value={id}>
													{name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
								<div className="relative">
									<Search
										className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
										aria-hidden
									/>
									<Input
										type="search"
										value={q ?? ""}
										onChange={(e) => set({ q: e.target.value || undefined })}
										placeholder="Service, domain or node"
										aria-label="Search the map"
										className="h-8 w-56 pl-8 text-sm"
									/>
								</div>
								<p className="px-1 text-xs text-muted-foreground tabular">
									{services} {services === 1 ? "service" : "services"} ·{" "}
									{domains} {domains === 1 ? "domain" : "domains"} · {tasks}{" "}
									{tasks === 1 ? "task" : "tasks"}
								</p>
							</>
						}
					/>
					{map && map.nodes.length === 0 && (
						<p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-muted-foreground">
							Nothing matches. Clear the search or pick another project.
						</p>
					)}
				</div>
			)}
		</Page>
	);
}

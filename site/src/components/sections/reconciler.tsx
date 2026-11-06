import { Dot, Section, SectionHead } from "../ui";

const compare = [
	[
		"Someone edits a container by hand",
		"It stays edited until the next deploy",
		"Reverted to the desired state",
	],
	[
		"You add a domain",
		"The proxy reloads or the app redeploys",
		"One admin API call, nothing restarts",
	],
	[
		"A backup or cron job runs",
		"On the control node, over SSH",
		"On the node that holds the data",
	],
	[
		"You need SSO, roles and an audit log",
		"Often a paid plan",
		"In the open-source build, free",
	],
] as const;

function Box({
	title,
	lines,
	accent = false,
}: {
	title: string;
	lines: string[];
	accent?: boolean;
}) {
	return (
		<div
			className={`flex flex-col gap-2.5 rounded-2xl bg-surface p-5 ${accent ? "shadow-[inset_0_0_0_1px_rgb(110_156_247/0.35)]" : ""}`}
		>
			<p className="text-[15px] font-semibold">{title}</p>
			{lines.map((l) => (
				<code key={l} className="block font-mono text-[13px] text-muted">
					{l}
				</code>
			))}
		</div>
	);
}

export function Reconciler() {
	return (
		<Section label="reconciler-title">
			<div className="flex flex-col gap-14">
				<SectionHead
					id="reconciler-title"
					title="Change it by hand. It changes back."
				>
					Postgres holds what should be running. A reconciler compares it with
					what Docker and Caddy report and fixes the difference. A container
					scaled from a shell at 3 a.m. goes back to the size you set.
				</SectionHead>

				<figure
					data-ui
					aria-label="The reconcile loop: desired state, reconciler, Docker and Caddy, with actual state reported back"
					className="relative overflow-hidden rounded-[28px] bg-deep p-5 sm:p-14"
				>
					<p className="mb-8 inline-flex flex-col gap-1 rounded-[10px] bg-bad/10 px-3.5 py-2.5">
						<code className="font-mono text-xs text-bad">
							$ docker service scale api=5
						</code>
						<span className="text-xs text-faint">
							03:12, run by hand on node-2
						</span>
					</p>
					<div className="grid items-center gap-5 lg:grid-cols-[260px_1fr_240px_1fr_380px]">
						<Box
							title="Desired state"
							accent
							lines={[
								"postgres",
								"api  replicas 2",
								"api  memory 512M",
								"api.acme.dev → api",
							]}
						/>
						<span aria-hidden className="hidden h-px bg-white/25 lg:block" />
						<Box
							title="Reconciler"
							lines={[
								"diff desired, actual",
								"apply the smallest fix",
								"write it to the audit log",
							]}
						/>
						<span aria-hidden className="hidden h-px bg-white/25 lg:block" />
						<div className="flex flex-col gap-5">
							<Box
								title="Docker Engine API"
								lines={["unix socket, no shell", "service api  replicas 5 → 2"]}
							/>
							<Box
								title="Caddy admin API"
								lines={[
									"PATCH /config/apps/http",
									"route unchanged, no reload",
								]}
							/>
						</div>
					</div>
					<figcaption className="mt-8 flex items-center gap-2 text-[13px] text-ok">
						<Dot />
						Actual state flows back to the reconciler on every change
					</figcaption>
				</figure>

				<div className="overflow-hidden rounded-[20px] bg-step">
					<table className="w-full text-left">
						<caption className="sr-only">
							How LogiStack compares with most self-hosted PaaS tools
						</caption>
						<thead className="bg-deep text-[13px] text-faint max-md:hidden">
							<tr>
								<th scope="col" className="px-7 py-4 font-medium">
									<span className="sr-only">Situation</span>
								</th>
								<th scope="col" className="px-7 py-4 font-medium">
									Most self-hosted PaaS tools
								</th>
								<th scope="col" className="px-7 py-4 font-medium">
									LogiStack
								</th>
							</tr>
						</thead>
						<tbody className="text-[15px]">
							{compare.map(([situation, others, ours]) => (
								<tr
									key={situation}
									className="border-t border-line first:border-t-0 max-md:block max-md:py-4"
								>
									<th
										scope="row"
										className="px-7 py-[18px] font-medium max-md:block max-md:px-6 max-md:py-1 md:w-[34%]"
									>
										{situation}
									</th>
									<td className="px-7 py-[18px] text-muted max-md:block max-md:px-6 max-md:py-1">
										<span className="md:hidden">Most tools: </span>
										{others}
									</td>
									<td className="px-7 py-[18px] max-md:block max-md:px-6 max-md:py-1">
										<span className="text-muted md:hidden">LogiStack: </span>
										{ours}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</Section>
	);
}

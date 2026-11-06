import { Dither } from "../dither";
import { Dot, Section, SectionHead } from "../ui";

const plane = [
	["api", "REST, MCP, WebSocket", "bg-ok"],
	["worker", "reconciler, builds, cron", "bg-ok"],
	["postgres", "desired state", "bg-brand"],
	["redis", "queues", "bg-brand"],
	["caddy", "ingress :443", "bg-ok"],
] as const;

const nodes = [
	{
		name: "node-1",
		ip: "10.0.0.2 · manager",
		cpu: 42,
		mem: 61,
		containers: 11,
	},
	{ name: "node-2", ip: "10.0.0.7 · worker", cpu: 68, mem: 74, containers: 9 },
	{ name: "node-3", ip: "10.0.0.9 · worker", cpu: 91, mem: 52, containers: 6 },
];

const logs = [
	["14:32:07", "node-1", "GET /v1/orders 200 18ms", "text-muted"],
	["14:32:07", "node-2", "GET /v1/orders 200 21ms", "text-muted"],
	["14:32:08", "node-3", "POST /v1/pay 502 3012ms", "text-bad"],
	["14:32:08", "node-3", "upstream timeout, retry 1", "text-warn"],
	["14:32:09", "node-3", "POST /v1/pay 200 140ms", "text-muted"],
	["14:32:10", "node-1", "GET /healthz 200 2ms", "text-muted"],
	["14:32:11", "node-2", "GET /v1/me 200 9ms", "text-muted"],
] as const;

const HOT = 85;

function Meter({ label, value }: { label: string; value: number }) {
	const hot = value > HOT;
	return (
		<div className="flex items-center gap-2.5">
			<span className="w-14 text-xs text-faint">{label}</span>
			{/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot take the status colour across browsers */}
			<span
				className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"
				role="meter"
				aria-label={label}
				aria-valuenow={value}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<span
					className={`block h-full rounded-full ${hot ? "bg-warn" : "bg-fg"}`}
					style={{ width: `${value}%` }}
				/>
			</span>
			<span
				className={`w-10 text-right text-[13px] tabular-nums ${hot ? "text-warn" : "text-fg"}`}
			>
				{value}%
			</span>
		</div>
	);
}

export function Servers() {
	return (
		<Section label="servers-title">
			<div id="servers" className="flex flex-col gap-14">
				<SectionHead id="servers-title" title="Every server on one screen.">
					An agent runs on each node and dials the server over one outbound
					WebSocket. Logs, CPU, memory, disk and container health arrive from
					every machine, with no ports to open on the workers.
				</SectionHead>

				<figure
					data-ui
					aria-label="Topology: one control plane and three nodes connected by their agents"
					className="relative overflow-hidden rounded-[28px] bg-deep p-5 sm:p-14"
				>
					<svg
						aria-hidden
						viewBox="0 0 1360 620"
						preserveAspectRatio="none"
						className="absolute inset-0 hidden size-full lg:block"
						fill="none"
					>
						<path
							d="M440 310 H600 Q640 310 640 270 V165 Q640 125 680 125 H900 M600 310 H900 M600 310 Q640 310 640 350 V445 Q640 485 680 485 H900"
							stroke="rgb(255 255 255 / 0.2)"
							strokeWidth="1.5"
							vectorEffect="non-scaling-stroke"
						/>
					</svg>
					<div className="relative grid gap-5 lg:grid-cols-[380px_1fr_400px] lg:items-center">
						<div className="flex flex-col gap-3.5 rounded-2xl bg-surface p-5">
							<p className="flex items-center justify-between">
								<span className="text-[15px] font-semibold">Control plane</span>
								<span className="text-[13px] text-faint">on node-1</span>
							</p>
							<ul className="flex flex-col gap-2">
								{plane.map(([name, role, dot]) => (
									<li
										key={name}
										className="flex items-center justify-between rounded-[9px] bg-raised px-3 py-2.5"
									>
										<span className="flex items-center gap-2 text-[13px]">
											<Dot className={dot} />
											<code className="font-mono">{name}</code>
										</span>
										<span className="text-xs text-faint">{role}</span>
									</li>
								))}
							</ul>
						</div>

						<p className="justify-self-center rounded-lg bg-deep px-3 py-2 text-center lg:-translate-y-[86px]">
							<code className="block font-mono text-[13px]">
								wss :443 outbound
							</code>
							<span className="block text-xs text-faint">
								agent dials in, nothing listens
							</span>
						</p>

						<ul className="flex flex-col gap-[30px]">
							{nodes.map((n) => (
								<li
									key={n.name}
									className="flex flex-col gap-3 rounded-2xl bg-surface p-5"
								>
									<p className="flex items-center justify-between">
										<span className="text-[15px] font-semibold">{n.name}</span>
										<code className="font-mono text-[13px] text-faint">
											{n.ip}
										</code>
									</p>
									<Meter label="CPU" value={n.cpu} />
									<Meter label="Memory" value={n.mem} />
									<p className="flex items-center gap-2 text-xs text-muted">
										<Dot className={n.cpu > HOT ? "bg-warn" : "bg-ok"} />
										{n.containers} containers · agent connected
									</p>
								</li>
							))}
						</ul>
					</div>
					<figcaption className="relative mt-8 flex flex-wrap gap-6 text-[13px] text-muted">
						<span className="flex items-center gap-2">
							<Dot /> healthy
						</span>
						<span className="flex items-center gap-2">
							<Dot className="bg-warn" /> above {HOT}% CPU
						</span>
						<span className="flex items-center gap-2">
							<Dot className="bg-brand" /> state store
						</span>
					</figcaption>
				</figure>

				<div className="grid gap-5 lg:grid-cols-[1fr_460px]">
					<figure
						data-ui
						className="relative isolate h-[300px] overflow-hidden rounded-[28px] bg-step"
					>
						<Dither
							shape="wave"
							cell={7}
							gain={1.1}
							seed={4}
							className="absolute inset-x-0 bottom-0 -z-10 h-[230px] w-full"
						/>
						<figcaption className="flex justify-between gap-4 p-7">
							<span className="text-[15px] font-medium">
								CPU across 3 nodes, last hour
							</span>
							<span className="text-[13px] text-muted tabular-nums">
								peak 91% on node-3 at 14:32
							</span>
						</figcaption>
					</figure>
					<figure
						data-ui
						className="flex flex-col gap-2.5 overflow-hidden rounded-[28px] bg-deep p-7"
					>
						<figcaption className="text-[15px] font-medium">
							api · production · live
						</figcaption>
						<pre className="flex flex-col gap-2.5 overflow-hidden font-mono text-[13px]">
							{logs.map(([t, node, msg, tone]) => (
								<code
									key={`${t}${msg}`}
									className="flex gap-2.5 whitespace-nowrap"
								>
									<span className="text-faint">{t}</span>
									<span className="text-brand">{node}</span>
									<span className={`truncate ${tone}`}>{msg}</span>
								</code>
							))}
						</pre>
					</figure>
				</div>
			</div>
		</Section>
	);
}

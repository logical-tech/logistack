import { Dither } from "../dither";
import { Dot, Section } from "../ui";

const steps = [
	[
		"Build",
		"0:00",
		"buildkit, linux/amd64 and arm64",
		"registry/acme/api:4f2c91a",
	],
	["Push", "0:21", "3 new layers, 41 MB", "82% of layers from cache"],
	["Start", "0:26", "2 new tasks next to the old 2", "waiting for /healthz"],
	[
		"Switch",
		"0:37",
		"Caddy points api.acme.dev at the new tasks",
		"old tasks drain for 10 s",
	],
	[
		"Settle",
		"0:38",
		"desired state matches actual state",
		"nothing left to fix",
	],
] as const;

export function Deploy() {
	return (
		<Section label="deploy-title">
			<div className="flex flex-col gap-5">
				<div className="relative isolate grid overflow-hidden rounded-[28px] bg-surface lg:min-h-[540px] lg:grid-cols-[620px_1fr]">
					<div className="relative h-[320px] lg:h-auto">
						<Dither
							shape="rings"
							cell={8}
							ramp="green"
							gain={1.15}
							seed={21}
							className="absolute inset-5 size-[calc(100%-40px)]"
						/>
					</div>
					<div className="flex flex-col justify-between gap-10 p-6 sm:p-14 lg:pl-4">
						<div className="flex flex-col gap-5">
							<h2
								id="deploy-title"
								className="text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
							>
								git push, then nothing else.
							</h2>
							<p className="max-w-[52ch] text-lg leading-relaxed text-fg/90">
								A push to main builds an image tagged with the deployment ID and
								starts the new tasks next to the old ones. Traffic moves when
								/healthz answers. If it never does, the old version keeps
								serving and you get a notification.
							</p>
						</div>
						<div
							data-ui
							className="flex flex-col gap-3 rounded-[14px] bg-raised px-[18px] py-4 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="flex items-center gap-3.5">
								<span className="flex size-10 items-center justify-center rounded-full bg-fg text-bg">
									<svg
										viewBox="0 0 24 24"
										aria-hidden
										className="size-[18px]"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
									>
										<circle cx="12" cy="12" r="3" />
										<path d="M3 12h6m6 0h6" />
									</svg>
								</span>
								<span className="flex flex-col gap-0.5">
									<span className="text-sm font-medium">
										fix: retry the payment webhook on 502
									</span>
									<code className="font-mono text-[13px] text-faint">
										4f2c91a · main
									</code>
								</span>
							</div>
							<span className="flex items-center gap-2 text-sm font-medium text-ok">
								<Dot />
								Live in 38 s
							</span>
						</div>
					</div>
				</div>
				<ol
					data-ui
					aria-label="Deployment 4f2c91a, step by step"
					className="overflow-hidden rounded-[20px] bg-step"
				>
					{steps.map(([name, at, what, detail], i) => (
						<li
							key={name}
							className="grid gap-1 px-7 py-[18px] odd:bg-deep/40 lg:grid-cols-[200px_100px_1fr_1fr] lg:items-center"
						>
							<span className="flex items-center gap-2.5 text-[15px] font-medium">
								<Dot
									className={i === steps.length - 1 ? "bg-ok" : "bg-faint"}
								/>
								{name}
							</span>
							<span className="text-[13px] text-faint tabular-nums">{at}</span>
							<span className="text-[15px]">{what}</span>
							<span className="text-[15px] text-muted">{detail}</span>
						</li>
					))}
				</ol>
			</div>
		</Section>
	);
}

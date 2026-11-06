import type { Shape } from "@/lib/dither";
import { Dither, type Ramp } from "../dither";
import { Section } from "../ui";

const rows: {
	title: string;
	body: string;
	note: string;
	shape: Shape;
	ramp: Ramp;
}[] = [
	{
		title: "Domains and HTTPS",
		body: "Bring a wildcard domain and a DNS token. LogiStack creates the records and requests one certificate over DNS-01, so new services get HTTPS without waiting.",
		note: "Cloudflare, Route 53, Hetzner",
		shape: "diamond",
		ramp: "blue",
	},
	{
		title: "Backups",
		body: "Encrypted with your key, sent to any S3-compatible bucket, restored into a fresh service in one step.",
		note: "R2, B2, MinIO, AWS",
		shape: "bloom",
		ramp: "mint",
	},
	{
		title: "Preview environments",
		body: "Every pull request gets its own copy of the project and a URL, removed when the branch merges.",
		note: "Commit status on GitHub",
		shape: "stripes",
		ramp: "sky",
	},
	{
		title: "Schedules",
		body: "Cron jobs that run inside the service's container, on the node where it lives, with logs for every run.",
		note: "Timezone aware",
		shape: "orb",
		ramp: "grass",
	},
	{
		title: "Access",
		body: "Organisations, custom roles, SSO over OIDC or SAML, passkeys and an audit log you can export.",
		note: "Every write audited",
		shape: "plus",
		ramp: "indigo",
	},
];

export function Included() {
	return (
		<Section label="included-title">
			<h2
				id="included-title"
				className="mb-10 text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
			>
				Included in every install.
			</h2>
			<ul className="flex flex-col gap-2">
				{rows.map((r, i) => (
					<li
						key={r.title}
						className={`grid grid-cols-[72px_1fr] items-center gap-x-5 gap-y-2 rounded-[20px] p-4 lg:grid-cols-[104px_300px_1fr_220px] lg:gap-8 lg:px-5 ${i % 2 === 0 ? "bg-step" : ""}`}
					>
						<div className="relative row-span-2 size-[72px] overflow-hidden rounded-[18px] bg-deep lg:row-span-1 lg:size-[104px]">
							<Dither
								shape={r.shape}
								cell={5}
								ramp={r.ramp}
								gain={1.15}
								seed={i * 7}
								className="absolute inset-0 size-full"
							/>
						</div>
						<h3 className="text-2xl font-medium tracking-[-0.02em]">
							{r.title}
						</h3>
						<p className="col-start-2 text-base leading-normal text-fg/90 lg:col-start-auto">
							{r.body}
						</p>
						<p className="hidden text-right text-sm text-muted lg:block">
							{r.note}
						</p>
					</li>
				))}
			</ul>
		</Section>
	);
}

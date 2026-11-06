import { type Brand, BrandIcon, brandTitle } from "../brand-icon";
import { Dither } from "../dither";
import { Check, Section } from "../ui";

const items: [Brand, string][] = [
	["postgres", "Relational database"],
	["libsql", "SQLite over HTTP"],
	["mongodb", "Document store"],
	["redis", "Cache and queues"],
	["mysql", "Relational database"],
	["mariadb", "MySQL compatible"],
	["clickhouse", "Column store"],
	["minio", "S3 object storage"],
	["meilisearch", "Search engine"],
];
const chips = ["All", "Databases", "Analytics", "Automation", "Storage"];

export function Templates({ templates }: { templates: number }) {
	return (
		<Section label="templates-title">
			<div
				id="templates"
				className="grid items-center gap-14 lg:grid-cols-[440px_1fr] lg:gap-20"
			>
				<div className="flex flex-col gap-7">
					<h2
						id="templates-title"
						className="text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
					>
						{templates} apps, one click each.
					</h2>
					<p className="text-lg leading-relaxed text-fg/90">
						Pick an app from the catalog. LogiStack creates its services,
						volumes, domain and secrets, then asks only for what it can't
						generate, such as an admin email.
					</p>
					<ul className="flex flex-col gap-3.5">
						<Check>
							Databases in one click: Postgres, MySQL, MariaDB, MongoDB, Redis,
							libSQL
						</Check>
						<Check>
							Passwords generated and stored encrypted, never shown in a log
						</Check>
						<Check>
							Each template is a plain manifest you can open and edit
						</Check>
					</ul>
					<a
						href="/templates/"
						className="pressable inline-flex h-12 w-fit items-center gap-2 rounded-full bg-fg px-[22px] text-[15px] font-semibold text-bg hover:bg-white"
					>
						Browse all {templates} templates
					</a>
				</div>

				<div className="relative isolate overflow-hidden rounded-[28px] bg-step p-4 sm:p-[70px]">
					<Dither
						shape="mosaic"
						cell={9}
						ramp="cobalt"
						gain={0.6}
						seed={11}
						className="absolute inset-0 -z-10 size-full"
					/>
					<figure
						data-ui
						aria-label="The template picker filtered to databases"
						className="overflow-hidden rounded-[18px] bg-surface shadow-[0_30px_60px_-12px_rgb(0_0_0/0.65)]"
					>
						<div className="flex flex-col gap-4 p-5">
							<div className="flex h-11 items-center gap-2.5 rounded-[10px] bg-bg px-3.5">
								<svg
									viewBox="0 0 24 24"
									aria-hidden
									className="size-4 text-faint"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
								>
									<circle cx="11" cy="11" r="7" />
									<path d="m20 20-3.5-3.5" />
								</svg>
								<span className="text-[15px]">data</span>
								<span
									aria-hidden
									className="h-[18px] w-[1.5px] animate-pulse bg-brand"
								/>
							</div>
							<div className="flex flex-wrap gap-2">
								{chips.map((c) => (
									<span
										key={c}
										className={`rounded-full px-3 py-1.5 text-[13px] font-medium ${c === "Databases" ? "bg-fg text-bg" : "bg-raised text-muted"}`}
									>
										{c}
									</span>
								))}
							</div>
						</div>
						<ul className="grid grid-cols-1 gap-2.5 px-5 pb-5 sm:grid-cols-3">
							{items.map(([brand, desc], i) => (
								<li
									key={brand}
									className={`flex items-center gap-3 rounded-xl p-3.5 ${i === 0 ? "bg-brand/12 shadow-[inset_0_0_0_1px_rgb(110_156_247/0.5)]" : "bg-raised"} ${i > 3 ? "hidden sm:flex" : ""}`}
								>
									<span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-bg">
										<BrandIcon name={brand} className="size-5" />
									</span>
									<span className="flex min-w-0 flex-col">
										<span className="text-sm font-medium">
											{brandTitle(brand) === "Turso"
												? "libSQL"
												: brandTitle(brand)}
										</span>
										<span className="truncate text-xs text-faint">{desc}</span>
									</span>
								</li>
							))}
						</ul>
						<figcaption className="flex items-center justify-between gap-4 bg-step px-5 py-3.5">
							<span className="text-[13px] text-muted">
								Postgres 17 · 1 service · 1 volume · daily backup
							</span>
							<span className="rounded-full bg-fg px-4 py-2 text-[13px] font-semibold text-bg">
								Deploy
							</span>
						</figcaption>
					</figure>
				</div>
			</div>
		</Section>
	);
}

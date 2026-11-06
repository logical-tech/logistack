import { Dither } from "../dither";
import { Check, Section, SectionHead } from "../ui";

const buckets = [
	["media", "2,418 objects · 3.1 GB", true],
	["backups", "96 objects · 18.4 GB", false],
	["uploads", "12,903 objects · 7.7 GB", false],
] as const;

const files = [
	["folder", "2025", "", "", false],
	["image", "chair-oak.webp", "184 KB", "2 min ago", false],
	["image", "chair-walnut.webp", "201 KB", "2 min ago", true],
	["doc", "catalog-2026.pdf", "4.2 MB", "yesterday", false],
	["image", "lamp-brass.webp", "96 KB", "3 days ago", false],
	["video", "showroom.mp4", "48.1 MB", "last week", false],
] as const;

const ICON = {
	folder: (
		<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
	),
	image: (
		<>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3-3a2 2 0 0 0-2.8 0L6 21" />
		</>
	),
	doc: (
		<>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
			<path d="M14 2v6h6M8 13h8M8 17h5" />
		</>
	),
	video: (
		<>
			<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
			<rect x="2" y="6" width="14" height="12" rx="2" />
		</>
	),
};

function StorageBrowser() {
	return (
		<figure
			data-ui
			aria-label="The S3 storage browser with a bucket open"
			className="flex overflow-hidden rounded-2xl bg-surface shadow-[0_30px_60px_-12px_rgb(0_0_0/0.7),inset_0_0_0_1px_rgb(255_255_255/0.08)]"
		>
			<div className="hidden w-[190px] shrink-0 flex-col gap-1 bg-step px-2.5 py-4 sm:flex">
				<p className="px-2 pb-2.5 text-sm font-semibold">Buckets</p>
				{buckets.map(([name, meta, active]) => (
					<div
						key={name}
						className={`flex flex-col gap-0.5 rounded-[9px] px-2.5 py-2 ${active ? "bg-raised" : ""}`}
					>
						<span
							className={`text-[13px] font-medium ${active ? "text-fg" : "text-muted"}`}
						>
							{name}
						</span>
						<span className="text-[11px] text-faint">{meta}</span>
					</div>
				))}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center justify-between px-4 py-3.5">
					<code className="font-mono text-[13px] text-muted">
						media <span className="text-faint">/</span>{" "}
						<span className="text-fg">products</span>
					</code>
					<span className="rounded-full bg-fg px-3 py-1.5 text-xs font-semibold text-bg">
						Upload
					</span>
				</div>
				<ul>
					{files.map(([icon, name, size, when, selected]) => (
						<li
							key={name}
							className={`flex items-center gap-2.5 px-4 py-2.5 text-[13px] ${selected ? "bg-brand/8" : ""}`}
						>
							<svg
								viewBox="0 0 24 24"
								aria-hidden
								className={`size-[15px] shrink-0 ${icon === "folder" ? "text-brand" : "text-muted"}`}
								fill="none"
								stroke="currentColor"
								strokeWidth="1.75"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								{ICON[icon]}
							</svg>
							<span className="min-w-0 flex-1 truncate">{name}</span>
							{selected && (
								<span className="hidden rounded-full bg-raised px-2 py-1 text-[11px] text-brand sm:inline">
									Share link
								</span>
							)}
							<span className="w-16 text-right text-xs text-faint tabular-nums">
								{size}
							</span>
							<span className="hidden w-20 text-right text-xs text-faint sm:inline">
								{when}
							</span>
						</li>
					))}
				</ul>
			</div>
		</figure>
	);
}

export function DataTools() {
	return (
		<Section label="data-title">
			<div id="data" className="flex flex-col gap-14">
				<SectionHead id="data-title" title="Your data, in the same dashboard.">
					No other self-hosted PaaS ships a table editor and an S3 browser. Edit
					a row in Postgres, run a query, upload a file to a bucket or hand out
					an access key, without installing pgAdmin or opening another login.
				</SectionHead>

				<div className="relative isolate overflow-hidden rounded-[28px] bg-deep p-4 sm:p-12 lg:min-h-[860px]">
					<Dither
						shape="signal"
						cell={9}
						ramp="sky"
						gain={1.1}
						seed={17}
						className="absolute bottom-6 left-12 -z-10 hidden h-[110px] w-[620px] lg:block"
					/>
					<picture>
						<source
							type="image/avif"
							srcSet="/shots/database-800.avif 800w, /shots/database-1600.avif 1600w"
							sizes="(min-width: 1024px) 900px, 100vw"
						/>
						<img
							src="/shots/database-1600.webp"
							srcSet="/shots/database-800.webp 800w, /shots/database-1600.webp 1600w"
							sizes="(min-width: 1024px) 900px, 100vw"
							width={1620}
							height={1170}
							loading="lazy"
							decoding="async"
							alt="LogiStack database editor showing the customers table of a Postgres service, with column types, filters and inline editing"
							className="w-full rounded-2xl outline outline-1 -outline-offset-1 outline-white/10 lg:w-[900px]"
						/>
					</picture>
					<div className="mt-4 lg:absolute lg:right-10 lg:bottom-10 lg:mt-0 lg:w-[620px]">
						<StorageBrowser />
					</div>
				</div>

				<div className="grid gap-5 md:grid-cols-2">
					<div className="flex flex-col gap-3.5 rounded-[20px] bg-step p-7">
						<h3 className="text-2xl font-medium tracking-tight">
							Database editor
						</h3>
						<ul className="flex flex-col gap-3">
							<Check>
								Edit cells, add rows and filter, with types shown on every
								column
							</Check>
							<Check>
								Run SQL, read the schema as a diagram, dump and restore
							</Check>
							<Check>Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL</Check>
							<Check>
								Roles with per-table permissions, created in a wizard
							</Check>
						</ul>
					</div>
					<div className="flex flex-col gap-3.5 rounded-[20px] bg-step p-7">
						<h3 className="text-2xl font-medium tracking-tight">
							Storage browser
						</h3>
						<ul className="flex flex-col gap-3">
							<Check>Buckets and folders, upload and bulk delete</Check>
							<Check>
								Share links for single objects, without making the bucket public
							</Check>
							<Check>Access keys you create and revoke per bucket</Check>
							<Check>
								Connection details for any S3 client, copied in one click
							</Check>
						</ul>
					</div>
				</div>
			</div>
		</Section>
	);
}

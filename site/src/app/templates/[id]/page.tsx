import type { Metadata } from "next";
import { CopyCommand } from "@/components/copy-command";
import { PageShell } from "@/components/page-shell";
import { FinalCta } from "@/components/sections/closing";
import { TemplateLogo } from "@/components/template-logo";
import { Check, Dot } from "@/components/ui";
import { site } from "@/content/site";
import {
	catalogIndex,
	categoryLabel,
	generatedTypes,
	imageName,
	readTemplate,
} from "@/lib/catalog";

type Props = { params: Promise<{ id: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
	return catalogIndex().map(({ id }) => ({ id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const t = readTemplate((await params).id);
	return {
		title: `Self-host ${t.name} in one click`,
		description:
			`Deploy ${t.name} on your own server with LogiStack: ${t.description}`.slice(
				0,
				300,
			),
		alternates: { canonical: `/templates/${t.id}/` },
	};
}

const upstream = {
	dokploy: "https://github.com/Dokploy/templates/tree/HEAD/",
	coolify: "https://github.com/coollabsio/coolify/tree/HEAD/",
} as const;

export default async function TemplatePage({ params }: Props) {
	const t = readTemplate((await params).id);
	const summary = catalogIndex().find((s) => s.id === t.id);
	const asked = t.inputs.filter(
		(i) => !generatedTypes.has(i.type) && i.type !== "domain",
	);
	const generated = t.inputs.filter((i) => generatedTypes.has(i.type));
	const domains = t.inputs.filter((i) => i.type === "domain");
	const volumes = t.services.reduce((n, s) => n + s.volumes.length, 0);
	const related = catalogIndex()
		.filter((s) => s.category === t.category && s.id !== t.id)
		.slice(0, 8);

	return (
		<PageShell>
			<div className="mx-auto w-full max-w-[1440px] px-4 pt-10 sm:px-10 sm:pt-14">
				<a
					href="/templates/"
					className="inline-flex h-10 items-center gap-2 rounded-full text-sm text-muted transition-colors hover:text-fg"
				>
					<svg
						viewBox="0 0 24 24"
						aria-hidden
						className="size-4"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="m15 18-6-6 6-6" />
					</svg>
					All templates
				</a>
			</div>

			<div className="mx-auto grid w-full max-w-[1440px] gap-14 px-4 pt-8 sm:px-10 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-14 xl:grid-cols-[minmax(0,1fr)_560px] xl:gap-20">
				<div className="rise flex flex-col gap-7">
					<TemplateLogo
						name={t.name}
						logo={summary?.logo}
						size="size-20"
						priority
					/>
					<h1 className="text-[44px] leading-[1.02] font-medium tracking-[-0.04em] sm:text-[64px]">
						{t.name}
					</h1>
					<p className="max-w-[56ch] text-lg leading-relaxed text-fg/90">
						{t.description}
					</p>
					<p className="flex flex-wrap items-center gap-2 text-sm">
						<a
							href={`/templates/?c=${t.category}`}
							className="rounded-full bg-raised px-3 py-1.5 font-medium text-fg transition-colors hover:bg-tile"
						>
							{categoryLabel(t.category)}
						</a>
						{t.tags
							.filter((tag) => tag !== t.category)
							.slice(0, 6)
							.map((tag) => (
								<a
									key={tag}
									href={`/templates/?q=${encodeURIComponent(tag)}`}
									className="rounded-full px-3 py-1.5 text-muted transition-colors hover:bg-raised hover:text-fg"
								>
									{tag}
								</a>
							))}
					</p>
					<div className="flex flex-wrap gap-3">
						{t.website && (
							<a
								href={t.website}
								rel="noopener"
								className="pressable inline-flex h-11 items-center rounded-full bg-tile px-5 text-[15px] font-medium hover:bg-raised"
							>
								Website
							</a>
						)}
						{t.docs && (
							<a
								href={t.docs}
								rel="noopener"
								className="pressable inline-flex h-11 items-center rounded-full bg-tile px-5 text-[15px] font-medium hover:bg-raised"
							>
								Documentation
							</a>
						)}
					</div>
					<div className="mt-4 flex flex-col gap-4 rounded-[24px] bg-step p-6 sm:p-8">
						<h2 className="text-2xl font-medium tracking-tight">
							Deploy it in three steps
						</h2>
						<ol className="flex flex-col gap-3 text-[15px] leading-relaxed text-fg/90">
							<li>
								<span className="font-medium text-fg">Install LogiStack</span>{" "}
								on a server with Docker-ready Linux and 2 GB of RAM.
							</li>
							<li>
								<span className="font-medium text-fg">
									Open a project, choose Templates
								</span>{" "}
								and search for {t.name}.
							</li>
							<li>
								<span className="font-medium text-fg">Click Deploy.</span>{" "}
								{asked.length > 0
									? `Fill in ${asked.map((i) => i.label.toLowerCase()).join(", ")}; the rest is generated.`
									: "Everything else is generated for you."}
							</li>
						</ol>
						<CopyCommand command={site.install} />
					</div>
				</div>

				<figure
					data-ui
					aria-label={`What the ${t.name} template creates`}
					className="rise self-start overflow-hidden rounded-[24px] bg-surface [animation-delay:100ms] lg:sticky lg:top-[96px]"
				>
					<figcaption className="flex items-center justify-between gap-4 bg-step px-6 py-4">
						<span className="text-[15px] font-medium">What gets created</span>
						<span className="text-[13px] text-muted tabular-nums">
							{t.services.length}{" "}
							{t.services.length === 1 ? "service" : "services"} · {volumes}{" "}
							{volumes === 1 ? "volume" : "volumes"}
						</span>
					</figcaption>
					<ul className="flex flex-col gap-2 p-4">
						{t.services.map((s) => (
							<li
								key={s.name}
								className="flex items-center gap-3 rounded-xl bg-raised px-4 py-3"
							>
								<Dot className={s.kind === "database" ? "bg-brand" : "bg-ok"} />
								<span className="flex min-w-0 flex-1 flex-col">
									<code className="truncate font-mono text-[13px]">
										{s.name}
									</code>
									<span className="truncate text-xs text-faint">
										{s.kind === "database"
											? `${s.engine} ${s.version} · managed database with backups`
											: imageName(s.image)}
									</span>
								</span>
								{s.kind === "application" && s.public && (
									<span className="shrink-0 rounded-full bg-ok/12 px-2.5 py-1 text-[11px] font-medium text-ok">
										HTTPS
									</span>
								)}
							</li>
						))}
					</ul>
					<div className="flex flex-col gap-5 px-6 pt-2 pb-6">
						{(asked.length > 0 || domains.length > 0) && (
							<div className="flex flex-col gap-2.5">
								<p className="text-sm font-medium">You choose</p>
								<ul className="flex flex-col gap-2">
									{domains.map((i) => (
										<Check key={i.key}>
											{i.label}, or a generated one if you leave it empty
										</Check>
									))}
									{asked.map((i) => (
										<Check key={i.key}>
											{i.label}
											{i.default ? ` (default ${i.default})` : ""}
										</Check>
									))}
								</ul>
							</div>
						)}
						{generated.length > 0 && (
							<div className="flex flex-col gap-2.5">
								<p className="text-sm font-medium">Generated for you</p>
								<ul className="flex flex-wrap gap-2">
									{generated.map((i) => (
										<li
											key={i.key}
											className="rounded-full bg-raised px-3 py-1.5 text-[13px] text-muted"
										>
											{i.label}
										</li>
									))}
								</ul>
								<p className="text-[13px] leading-relaxed text-faint">
									Stored as encrypted secrets, never printed in a log.
								</p>
							</div>
						)}
					</div>
				</figure>
			</div>

			{related.length > 0 && (
				<section
					aria-labelledby="related-title"
					className="mx-auto w-full max-w-[1440px] px-4 pt-32 sm:px-10"
				>
					<div className="mb-8 flex flex-wrap items-end justify-between gap-4">
						<h2
							id="related-title"
							className="text-[32px] leading-[1.05] font-medium tracking-[-0.03em] sm:text-[40px]"
						>
							More in {categoryLabel(t.category)}
						</h2>
						<a
							href={`/templates/?c=${t.category}`}
							className="text-[15px] text-muted underline transition-colors hover:text-fg"
						>
							See all
						</a>
					</div>
					<ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
						{related.map((r) => (
							<li key={r.id} className="min-w-0">
								<a
									href={`/templates/${r.id}/`}
									className="flex h-full items-center gap-3.5 rounded-[18px] bg-step p-4 transition-colors duration-150 hover:bg-tile"
								>
									<TemplateLogo name={r.name} logo={r.logo} />
									<span className="flex min-w-0 flex-col">
										<span className="truncate text-[15px] font-medium">
											{r.name}
										</span>
										<span className="truncate text-xs text-faint">
											{r.description}
										</span>
									</span>
								</a>
							</li>
						))}
					</ul>
				</section>
			)}

			<p className="mx-auto w-full max-w-[1440px] px-4 pt-16 text-[13px] text-faint sm:px-10">
				Template adapted from the{" "}
				<a
					href={`${upstream[t.source.kind]}${t.source.path}`}
					rel="noopener"
					className="underline hover:text-fg"
				>
					{t.source.kind === "dokploy" ? "Dokploy" : "Coolify"} catalog
				</a>{" "}
				({t.source.license}). {t.name} is a trademark of its owners; LogiStack
				only deploys it.
			</p>

			<FinalCta />
		</PageShell>
	);
}

import type { Metadata } from "next";
import { PageHead, PageShell } from "@/components/page-shell";
import { FinalCta } from "@/components/sections/closing";
import { areas } from "@/content/features";
import { site } from "@/content/site";
import { templateCount } from "@/lib/catalog";

export const metadata: Metadata = {
	title: "Every feature, page by page",
	description:
		"What you can do from the LogiStack dashboard: Git deploys, templates, a database editor, S3 storage, backups with restore checks, HTTPS and DNS, previews, monitoring, game servers, SSO, an API and an MCP server.",
	alternates: { canonical: "/features/" },
};

export default function Features() {
	const list = areas(templateCount());
	const total = list.reduce((n, a) => n + a.items.length, 0);
	return (
		<PageShell>
			<PageHead
				title="Everything you can do from the dashboard."
				actions={
					<>
						<a
							href="/#install"
							className="pressable inline-flex h-12 items-center rounded-full bg-fg px-[22px] text-[15px] font-semibold text-bg hover:bg-white"
						>
							Install LogiStack
						</a>
						<a
							href="/templates/"
							className="pressable inline-flex h-12 items-center rounded-full bg-tile px-5 text-[15px] font-medium hover:bg-raised"
						>
							Browse templates
						</a>
					</>
				}
			>
				<p>
					{total} things LogiStack does across {list.length} areas, all in one
					install, all free under Apache 2.0. Nothing below sits behind a paid
					plan, and each one has a page in the dashboard, so you click instead
					of SSH.
				</p>
			</PageHead>

			<nav
				aria-label="Feature areas"
				className="mx-auto w-full max-w-[1440px] px-4 sm:px-10"
			>
				<ul className="flex flex-wrap gap-2">
					{list.map((a) => (
						<li key={a.id}>
							<a
								href={`#${a.id}`}
								className="pressable inline-flex h-9 items-center rounded-full bg-raised px-3.5 text-[13px] font-medium text-muted hover:text-fg"
							>
								{a.title}
							</a>
						</li>
					))}
				</ul>
			</nav>

			<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-2 px-4 pt-16 sm:px-10 sm:pt-24">
				{list.map((a, i) => (
					<section
						key={a.id}
						id={a.id}
						aria-labelledby={`${a.id}-title`}
						className={`grid gap-8 rounded-[28px] p-6 sm:p-10 lg:grid-cols-[300px_1fr] lg:gap-12 xl:grid-cols-[400px_1fr] xl:gap-16 ${i % 2 === 0 ? "bg-step" : ""}`}
					>
						<div className="flex flex-col gap-4 lg:sticky lg:top-[96px] lg:self-start">
							<h2
								id={`${a.id}-title`}
								className="reveal text-[32px] leading-[1.05] font-medium tracking-[-0.03em] sm:text-[40px]"
							>
								{a.title}
							</h2>
							<p className="reveal text-[17px] leading-relaxed text-fg/90">
								{a.intro}
							</p>
							<p className="text-sm text-faint">
								In the dashboard: <span className="text-muted">{a.where}</span>
							</p>
						</div>
						<dl className="grid gap-x-10 gap-y-7 sm:grid-cols-2">
							{a.items.map(([title, body]) => (
								<div key={title} className="reveal flex flex-col gap-1.5">
									<dt className="text-[17px] font-medium tracking-[-0.01em]">
										{title}
									</dt>
									<dd className="text-[15px] leading-relaxed text-muted">
										{body}
									</dd>
								</div>
							))}
						</dl>
					</section>
				))}
			</div>

			<section
				aria-labelledby="missing-title"
				className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 pt-32 sm:px-10"
			>
				<h2
					id="missing-title"
					className="text-[32px] leading-[1.05] font-medium tracking-[-0.03em] sm:text-[40px]"
				>
					Missing something you need?
				</h2>
				<p className="max-w-[60ch] text-lg leading-relaxed text-fg/90">
					Open an issue and say what you are trying to run. The roadmap follows
					what people deploy.
				</p>
				<a
					href={`${site.github}/issues`}
					className="pressable inline-flex h-12 w-fit items-center rounded-full bg-tile px-5 text-[15px] font-medium hover:bg-raised"
				>
					Open an issue on GitHub
				</a>
			</section>

			<FinalCta />
		</PageShell>
	);
}

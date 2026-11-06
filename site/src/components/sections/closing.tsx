import { site } from "@/content/site";
import { CopyCommand } from "../copy-command";
import { Dither } from "../dither";

export function FinalCta() {
	return (
		<section
			aria-labelledby="final-title"
			className="relative isolate mx-auto mt-32 w-full max-w-[1440px] overflow-hidden sm:mt-52"
		>
			<div className="flex flex-col items-center gap-6 px-4 pt-20 text-center">
				<h2
					id="final-title"
					className="max-w-[16ch] text-[44px] leading-none font-medium tracking-[-0.04em] sm:text-[56px]"
				>
					One command, then a browser.
				</h2>
				<p className="max-w-[46ch] text-lg leading-relaxed text-muted">
					Runs on Ubuntu 22.04 or Debian 12 with 2 GB of RAM. The setup wizard
					asks for a domain and an email, then you deploy.
				</p>
				<CopyCommand command={site.install} />
			</div>
			<Dither
				shape="sunrise"
				cell={12}
				gain={1.1}
				seed={9}
				className="mt-12 h-[280px] w-full sm:h-[380px]"
			/>
		</section>
	);
}

const columns = [
	[
		"Product",
		[
			["Templates", "#templates"],
			["Database editor", "#data"],
			["Servers", "#servers"],
			["FAQ", "#faq"],
		],
	],
	[
		"Docs",
		[
			["Install", `${site.github}#quick-start`],
			["Migrate", `${site.github}#migrate-from-dokploy`],
			["Releases", `${site.github}/releases`],
			["Security", `${site.github}/security`],
		],
	],
	[
		"Project",
		[
			["GitHub", site.github],
			["Sponsor", "#sponsor"],
			["License", `${site.github}/blob/main/LICENSE`],
			["Logical", site.company.url],
		],
	],
] as const;

export function Footer() {
	return (
		<footer className="overflow-hidden bg-step">
			<div className="mx-auto flex max-w-[1440px] flex-col gap-12 px-4 pt-16 sm:px-10">
				<div className="flex flex-col justify-between gap-12 sm:flex-row">
					<nav
						aria-label="Footer"
						className="grid grid-cols-2 gap-x-16 gap-y-10 sm:flex sm:gap-24"
					>
						{columns.map(([heading, links]) => (
							<div key={heading} className="flex flex-col gap-3">
								<p className="text-sm font-semibold">{heading}</p>
								<ul className="flex flex-col gap-3">
									{links.map(([label, href]) => (
										<li key={label}>
											<a
												href={href}
												className="text-sm text-muted transition-colors hover:text-fg"
											>
												{label}
											</a>
										</li>
									))}
								</ul>
							</div>
						))}
					</nav>
					<div className="flex flex-col gap-2.5 sm:items-end">
						<p className="flex items-center gap-2.5 text-[15px] font-medium">
							<span
								aria-hidden
								className="flex h-4 w-6 overflow-hidden rounded-[3px]"
							>
								<span className="flex-1 bg-[#009246]" />
								<span className="flex-1 bg-[#F4F5F0]" />
								<span className="flex-1 bg-[#CE2B37]" />
							</span>
							Made in Italy
						</p>
						<p className="text-sm text-muted">
							by{" "}
							<a href={site.company.url} className="text-fg underline">
								{site.company.name}
							</a>
						</p>
					</div>
				</div>
				<svg
					aria-hidden
					viewBox="0 10 1000 272"
					className="mb-6 w-full fill-[#1F2025]"
				>
					<text
						x="0"
						y="200"
						fontSize="250"
						fontWeight="600"
						textLength="1000"
						lengthAdjust="spacingAndGlyphs"
						fontFamily="var(--font-mona), sans-serif"
					>
						LogiStack
					</text>
				</svg>
			</div>
		</footer>
	);
}

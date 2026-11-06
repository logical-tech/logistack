import { siGithub } from "simple-icons";
import { site } from "@/content/site";
import { LogoMark } from "../ui";

const links = [
	["Templates", "/#templates"],
	["Data", "/#data"],
	["Servers", "/#servers"],
	["FAQ", "/#faq"],
	["Docs", `${site.github}#readme`],
] as const;

export function Nav() {
	return (
		<header className="sticky top-0 z-30 bg-bg">
			<nav
				aria-label="Main"
				className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between gap-6 px-4 sm:px-10"
			>
				<a
					href="/"
					className="flex items-center gap-2.5 rounded-md"
					aria-label="LogiStack home"
				>
					<LogoMark />
					<span className="text-base font-semibold tracking-tight">
						LogiStack
					</span>
				</a>
				<ul className="hidden items-center gap-8 lg:flex">
					{links.map(([label, href]) => (
						<li key={label}>
							<a
								href={href}
								className="text-sm text-muted transition-colors duration-150 hover:text-fg"
							>
								{label}
							</a>
						</li>
					))}
				</ul>
				<div className="flex items-center gap-2">
					<a
						href={site.github}
						className="hidden size-10 items-center justify-center rounded-full text-muted transition-colors hover:text-fg sm:inline-flex"
					>
						<span className="sr-only">LogiStack on GitHub</span>
						<svg
							viewBox="0 0 24 24"
							aria-hidden
							className="size-[18px]"
							fill="currentColor"
						>
							<path d={siGithub.path} />
						</svg>
					</a>
					<a
						href="/#sponsor"
						className="pressable hidden h-10 items-center gap-2 rounded-full bg-tile px-4 text-sm font-medium hover:bg-raised sm:inline-flex"
					>
						<svg
							viewBox="0 0 24 24"
							aria-hidden
							className="size-[15px] text-pink"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
						</svg>
						Sponsor
					</a>
					<a
						href="/#install"
						className="pressable inline-flex h-10 items-center rounded-full bg-fg px-[18px] text-sm font-medium text-bg hover:bg-white"
					>
						Install
					</a>
				</div>
			</nav>
		</header>
	);
}

import type { ReactNode } from "react";
import { Footer } from "./sections/closing";
import { Nav } from "./sections/nav";

/** Skip link, nav, main and footer for every page but the home page. */
export function PageShell({ children }: { children: ReactNode }) {
	return (
		<>
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-fg focus:px-4 focus:py-2 focus:text-bg"
			>
				Skip to content
			</a>
			<Nav />
			<main id="main">{children}</main>
			<Footer />
		</>
	);
}

/** The large opening heading of an inner page, with its paragraph and optional actions. */
export function PageHead({
	title,
	children,
	actions,
}: {
	title: string;
	children: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-7 px-4 pt-20 pb-14 sm:px-10 sm:pt-28 sm:pb-20">
			<h1 className="rise max-w-[18ch] text-[44px] leading-[1.02] font-medium tracking-[-0.04em] sm:text-[72px]">
				{title}
			</h1>
			<div className="rise flex max-w-[60ch] flex-col gap-4 text-lg leading-relaxed text-fg/90 [animation-delay:80ms]">
				{children}
			</div>
			{actions && (
				<div className="rise flex flex-wrap items-center gap-3 [animation-delay:160ms]">
					{actions}
				</div>
			)}
		</div>
	);
}

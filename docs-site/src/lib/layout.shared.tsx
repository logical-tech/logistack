import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { site } from "./shared";

function LogoMark() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden className="size-6">
			<rect width="24" height="24" rx="6" className="fill-fd-foreground" />
			<rect
				x="6"
				y="6"
				width="12"
				height="3"
				rx="1"
				className="fill-fd-background"
			/>
			<rect
				x="6"
				y="10.5"
				width="8.5"
				height="3"
				rx="1"
				className="fill-fd-background"
			/>
			<rect x="6" y="15" width="5" height="3" rx="1" fill="#4FD08B" />
		</svg>
	);
}

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: (
				<span className="flex items-center gap-2.5">
					<LogoMark />
					<span className="font-semibold tracking-tight">LogiStack</span>
					<span className="text-fd-muted-foreground font-normal">Docs</span>
				</span>
			),
			url: "/",
		},
		githubUrl: site.github,
		links: [{ text: "Website", url: `${site.origin}/`, external: true }],
	};
}

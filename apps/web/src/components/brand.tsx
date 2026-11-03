import { cn } from "@/lib/utils";

/** The mark: three service cells stacked into a block, the signal strip's vocabulary. */
export function LogoMark({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden
			className={cn("size-6 shrink-0", className)}
			fill="none"
		>
			<rect width="24" height="24" rx="6" className="fill-foreground" />
			<rect
				x="6"
				y="6"
				width="12"
				height="3"
				rx="1"
				className="fill-background"
			/>
			<rect
				x="6"
				y="10.5"
				width="8.5"
				height="3"
				rx="1"
				className="fill-background"
			/>
			<rect x="6" y="15" width="5" height="3" rx="1" className="fill-ok" />
		</svg>
	);
}

export function Wordmark({ className }: { className?: string }) {
	return (
		<span className={cn("inline-flex items-center gap-2", className)}>
			<LogoMark />
			<span className="text-md font-semibold tracking-tight [font-stretch:112%]">
				LogiStack
			</span>
		</span>
	);
}

export function GitHubMark({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden
			className={cn("size-4", className)}
			fill="currentColor"
		>
			<path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
		</svg>
	);
}

export function GoogleMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden className={cn("size-4", className)}>
			<path
				fill="#4285F4"
				d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z"
			/>
			<path
				fill="#34A853"
				d="M12 24c3.24 0 5.96-1.07 7.94-2.92l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24Z"
			/>
			<path
				fill="#FBBC05"
				d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.28a12 12 0 0 0 0 10.76l4.01-3.1Z"
			/>
			<path
				fill="#EA4335"
				d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77Z"
			/>
		</svg>
	);
}

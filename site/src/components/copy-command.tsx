"use client";

import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		await navigator.clipboard.writeText(command);
		setCopied(true);
		setTimeout(() => setCopied(false), 1600);
	};
	return (
		<div className="flex max-w-full items-center gap-3 rounded-full bg-tile py-2 pr-2 pl-5">
			<code className="min-w-0 truncate font-mono text-[13px] text-fg sm:text-sm">
				{command}
			</code>
			<button
				type="button"
				onClick={copy}
				className="pressable inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-fg px-4 text-sm font-medium text-bg hover:bg-white"
			>
				<svg
					viewBox="0 0 24 24"
					aria-hidden
					className="size-3.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					{copied ? (
						<path d="M20 6 9 17l-5-5" />
					) : (
						<>
							<rect x="9" y="9" width="13" height="13" rx="2" />
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
						</>
					)}
				</svg>
				<span aria-live="polite" className="tabular-nums">
					{copied ? "Copied" : "Copy"}
				</span>
			</button>
		</div>
	);
}

import type { ReactNode } from "react";

export function LogoMark({ className = "size-6" }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" aria-hidden className={className}>
			<rect width="24" height="24" rx="6" fill="#F1F2F4" />
			<rect x="6" y="6" width="12" height="3" rx="1" fill="#111214" />
			<rect x="6" y="10.5" width="8.5" height="3" rx="1" fill="#111214" />
			<rect x="6" y="15" width="5" height="3" rx="1" fill="#4FD08B" />
		</svg>
	);
}

/** Section heading on the left, the supporting paragraph on the right, stacked on phones. */
export function SectionHead({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
			<h2
				id={id}
				className="max-w-[16ch] text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
			>
				{title}
			</h2>
			<p className="max-w-[52ch] text-lg leading-relaxed text-fg/90">
				{children}
			</p>
		</div>
	);
}

export function Section({
	label,
	children,
	className = "",
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-labelledby={label}
			className={`mx-auto w-full max-w-[1440px] px-4 pt-32 sm:px-10 sm:pt-52 [&_figure]:reveal [&_h2]:reveal [&_h2+p]:reveal [&_li]:reveal [&_picture]:reveal ${className}`}
		>
			{children}
		</section>
	);
}

export function Check({ children }: { children: ReactNode }) {
	return (
		<li className="flex gap-3 text-[15px] leading-relaxed text-muted">
			<svg
				viewBox="0 0 24 24"
				aria-hidden
				className="mt-1 size-4 shrink-0 stroke-ok"
				fill="none"
				strokeWidth="2.25"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M20 6 9 17l-5-5" />
			</svg>
			<span>{children}</span>
		</li>
	);
}

export function Dot({ className = "bg-ok" }: { className?: string }) {
	return (
		<span
			aria-hidden
			className={`inline-block size-2 shrink-0 rounded-full ${className}`}
		/>
	);
}

"use client";

import { useState } from "react";

const AMOUNTS = [5, 15, 50] as const;
type Frequency = "monthly" | "once";

/** GitHub Sponsors takes the amount and frequency in the URL; "Other" lets the visitor type it there. */
export function SponsorPicker({ url }: { url: string }) {
	const [frequency, setFrequency] = useState<Frequency>("monthly");
	const [amount, setAmount] = useState<number | null>(15);
	const href = amount
		? `${url}/sponsorships?frequency=${frequency === "monthly" ? "recurring" : "one-time"}&amount=${amount}`
		: url;
	const label = amount
		? `Sponsor €${amount}${frequency === "monthly" ? " a month" : " once"}`
		: "Choose an amount on GitHub";

	return (
		<div className="flex flex-col gap-4">
			<fieldset className="flex w-fit gap-1 rounded-full bg-bg p-1">
				<legend className="sr-only">How often</legend>
				{(["monthly", "once"] as const).map((f) => (
					<label
						key={f}
						className={`pressable cursor-pointer rounded-full px-[18px] py-2 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand ${frequency === f ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
					>
						<input
							type="radio"
							name="frequency"
							value={f}
							checked={frequency === f}
							onChange={() => setFrequency(f)}
							className="sr-only"
						/>
						{f === "monthly" ? "Monthly" : "Once"}
					</label>
				))}
			</fieldset>
			<fieldset className="flex flex-wrap gap-2">
				<legend className="sr-only">Amount</legend>
				{[...AMOUNTS, null].map((a) => (
					<label
						key={a ?? "other"}
						className={`pressable flex h-[52px] w-[84px] cursor-pointer items-center justify-center rounded-[14px] text-base font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand ${amount === a ? "bg-pink/12 shadow-[inset_0_0_0_1.5px_var(--color-pink)]" : "bg-raised hover:bg-tile"}`}
					>
						<input
							type="radio"
							name="amount"
							checked={amount === a}
							onChange={() => setAmount(a)}
							className="sr-only"
						/>
						{a ? `€${a}` : "Other"}
					</label>
				))}
			</fieldset>
			<div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
				<a
					href={href}
					className="pressable inline-flex h-12 w-fit items-center gap-2 rounded-full bg-fg px-[22px] text-[15px] font-semibold text-bg hover:bg-white"
				>
					<svg
						viewBox="0 0 24 24"
						aria-hidden
						className="size-4 text-[#D9466F]"
						fill="currentColor"
					>
						<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
					</svg>
					<span className="tabular-nums">{label}</span>
				</a>
				<span className="text-sm text-muted">
					Through GitHub Sponsors. Cancel any time.
				</span>
			</div>
		</div>
	);
}

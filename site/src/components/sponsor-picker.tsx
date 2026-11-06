"use client";

import { useState } from "react";
import {
	customAmountLink,
	type Frequency,
	manageSponsorshipLink,
	SPONSOR_AMOUNTS,
	type SponsorAmount,
	sponsorLinks,
} from "@/content/sponsor";

type Choice = SponsorAmount | "other";

function target(frequency: Frequency, choice: Choice) {
	if (choice === "other")
		return {
			href: customAmountLink,
			label: "Choose your amount",
			note: "A one-time gift of any amount, through Stripe.",
		};
	const monthly = frequency === "monthly";
	return {
		href: sponsorLinks[frequency][choice],
		label: `Sponsor €${choice}${monthly ? " a month" : " once"}`,
		note: monthly
			? "Billed monthly through Stripe. Cancel any time."
			: "A one-time gift, paid through Stripe.",
	};
}

export function SponsorPicker() {
	const [frequency, setFrequency] = useState<Frequency>("monthly");
	const [choice, setChoice] = useState<Choice>(15);
	const { href, label, note } = target(frequency, choice);

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
				{[...SPONSOR_AMOUNTS, "other" as const].map((c) => (
					<label
						key={c}
						className={`pressable flex h-[52px] w-[84px] cursor-pointer items-center justify-center rounded-[14px] text-base font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand ${choice === c ? "bg-pink/12 shadow-[inset_0_0_0_1.5px_var(--color-pink)]" : "bg-raised hover:bg-tile"}`}
					>
						<input
							type="radio"
							name="amount"
							checked={choice === c}
							onChange={() => setChoice(c)}
							className="sr-only"
						/>
						{c === "other" ? "Other" : `€${c}`}
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
				<span aria-live="polite" className="text-sm text-muted">
					{note}
				</span>
			</div>
			<a
				href={manageSponsorshipLink}
				className="w-fit text-sm text-muted underline transition-colors hover:text-fg"
			>
				Already a sponsor? Manage or cancel
			</a>
		</div>
	);
}

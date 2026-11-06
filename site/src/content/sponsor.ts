/**
 * Stripe Payment Links on the LogiStack account (live mode), one per frequency and amount.
 * Product prod_VZtBGNkNDsUJTC; each price has a lookup_key such as sponsor_monthly_15.
 * Every link redirects to /thanks/ after payment.
 */
export const SPONSOR_AMOUNTS = [5, 15, 50] as const;
export type SponsorAmount = (typeof SPONSOR_AMOUNTS)[number];
export type Frequency = "monthly" | "once";

export const sponsorLinks: Record<Frequency, Record<SponsorAmount, string>> = {
	monthly: {
		5: "https://buy.stripe.com/5kQ7sFbPX2YIcX4bPz1gs00",
		15: "https://buy.stripe.com/fZu14hbPXara4qy7zj1gs01",
		50: "https://buy.stripe.com/9B65kx2fnbve9KS5rb1gs02",
	},
	once: {
		5: "https://donate.stripe.com/7sYfZb4nv7eYcX4bPz1gs03",
		15: "https://donate.stripe.com/cNidR3bPX7eYe186vf1gs04",
		50: "https://donate.stripe.com/7sY9AN5rz2YIaOWg5P1gs05",
	},
};

/** Stripe only offers a visitor-chosen amount on one-time payments. */
export const customAmountLink =
	"https://donate.stripe.com/8x2aERf299n6e18g5P1gs06";

/** Stripe customer portal (bpc_1UYjmh7MyJvf14A3LqNjEzWo): sponsors sign in by email to cancel or change card. */
export const manageSponsorshipLink =
	"https://billing.stripe.com/p/login/5kQ7sFbPX2YIcX4bPz1gs00";

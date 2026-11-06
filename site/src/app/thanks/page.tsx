import type { Metadata } from "next";
import { Footer } from "@/components/sections/closing";
import { Nav } from "@/components/sections/nav";
import { site } from "@/content/site";
import { manageSponsorshipLink } from "@/content/sponsor";

export const metadata: Metadata = {
	title: "Thank you",
	description: "Thank you for sponsoring LogiStack.",
	robots: { index: false, follow: true },
	alternates: { canonical: "/thanks/" },
};

export default function Thanks() {
	return (
		<>
			<Nav />
			<main
				id="main"
				className="mx-auto flex min-h-[70dvh] max-w-[1440px] flex-col justify-center gap-6 px-4 py-32 sm:px-10"
			>
				<h1 className="max-w-[14ch] text-[44px] leading-none font-medium tracking-[-0.04em] sm:text-[72px]">
					Thank you for sponsoring LogiStack.
				</h1>
				<p className="max-w-[52ch] text-lg leading-relaxed text-fg/90">
					Your payment went through. It pays for the hours behind releases,
					security fixes and the template catalog. To change your card or cancel
					a monthly sponsorship, sign in to the{" "}
					<a href={manageSponsorshipLink} className="underline">
						Stripe billing portal
					</a>{" "}
					with the email you paid with.
				</p>
				<div className="flex flex-wrap gap-3 pt-2">
					<a
						href="/"
						className="pressable inline-flex h-12 items-center rounded-full bg-fg px-[22px] text-[15px] font-semibold text-bg hover:bg-white"
					>
						Back to the site
					</a>
					<a
						href={site.github}
						className="pressable inline-flex h-12 items-center rounded-full px-5 text-[15px] font-medium hover:bg-tile"
					>
						Star it on GitHub
					</a>
				</div>
			</main>
			<Footer />
		</>
	);
}

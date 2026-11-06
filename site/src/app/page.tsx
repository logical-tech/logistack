import { FinalCta, Footer } from "@/components/sections/closing";
import { DataTools } from "@/components/sections/data-tools";
import { Deploy } from "@/components/sections/deploy";
import { Faq } from "@/components/sections/faq";
import { Hero } from "@/components/sections/hero";
import { Included } from "@/components/sections/included";
import { Manifest } from "@/components/sections/manifest";
import { Migrate } from "@/components/sections/migrate";
import { Nav } from "@/components/sections/nav";
import { Reconciler } from "@/components/sections/reconciler";
import { Servers } from "@/components/sections/servers";
import { Sponsor } from "@/components/sections/sponsor";
import { Templates } from "@/components/sections/templates";
import { templateCount } from "@/lib/catalog";

export default function Home() {
	const templates = templateCount();
	return (
		<>
			<a
				href="#main"
				className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-fg focus:px-4 focus:py-2 focus:text-bg"
			>
				Skip to content
			</a>
			<Nav />
			<main id="main">
				<Hero templates={templates} />
				<Templates templates={templates} />
				<DataTools />
				<Servers />
				<Reconciler />
				<Deploy />
				<Manifest />
				<Included />
				<Migrate />
				<Sponsor />
				<Faq />
				<FinalCta />
			</main>
			<Footer />
		</>
	);
}

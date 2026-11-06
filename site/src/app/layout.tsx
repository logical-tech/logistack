import type { Metadata, Viewport } from "next";
import { Geist_Mono, Mona_Sans } from "next/font/google";
import { faq } from "@/content/faq";
import { site } from "@/content/site";
import "./globals.css";

const mona = Mona_Sans({
	subsets: ["latin"],
	variable: "--font-mona",
	display: "optional",
});
const mono = Geist_Mono({
	subsets: ["latin"],
	variable: "--font-geist-mono",
	display: "swap",
	preload: false,
});

export const metadata: Metadata = {
	metadataBase: new URL(site.url),
	title: { default: site.title, template: `%s | ${site.name}` },
	description: site.description,
	applicationName: site.name,
	keywords: [
		"self-hosted PaaS",
		"open source PaaS",
		"PaaS",
		"platform as a service",
		"Docker Swarm",
		"deploy Docker apps",
		"self-hosted deployment platform",
		"one-click apps",
		"database GUI",
		"S3 storage browser",
	],
	authors: [{ name: site.company.name, url: site.company.url }],
	creator: site.company.name,
	publisher: site.company.name,
	alternates: { canonical: "/" },
	openGraph: {
		type: "website",
		url: "/",
		siteName: site.name,
		title: site.title,
		description: site.description,
		locale: "en_US",
	},
	twitter: {
		card: "summary_large_image",
		title: site.title,
		description: site.description,
	},
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-image-preview": "large",
			"max-snippet": -1,
		},
	},
	category: "technology",
};

export const viewport: Viewport = {
	themeColor: "#111214",
	colorScheme: "dark",
};

const structuredData = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "Organization",
			"@id": `${site.url}/#org`,
			name: site.company.name,
			url: site.company.url,
			address: {
				"@type": "PostalAddress",
				addressCountry: site.company.country,
			},
		},
		{
			"@type": "WebSite",
			"@id": `${site.url}/#website`,
			url: site.url,
			name: site.name,
			publisher: { "@id": `${site.url}/#org` },
			inLanguage: "en",
		},
		{
			"@type": "SoftwareApplication",
			"@id": `${site.url}/#app`,
			name: site.name,
			description: site.description,
			url: site.url,
			applicationCategory: "DeveloperApplication",
			applicationSubCategory: "Platform as a service",
			operatingSystem: "Linux",
			license: "https://www.apache.org/licenses/LICENSE-2.0",
			isAccessibleForFree: true,
			offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
			publisher: { "@id": `${site.url}/#org` },
			sameAs: [site.github],
		},
		{
			"@type": "FAQPage",
			"@id": `${site.url}/#faq`,
			mainEntity: faq.map(({ q, a }) => ({
				"@type": "Question",
				name: q,
				acceptedAnswer: { "@type": "Answer", text: a },
			})),
		},
	],
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={`${mona.variable} ${mono.variable}`}>
			<body className="min-h-dvh bg-bg font-sans text-fg antialiased">
				<script
					type="application/ld+json"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from constants
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
					}}
				/>
				{children}
			</body>
		</html>
	);
}

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Metadata, Viewport } from "next";
import { Geist_Mono, Mona_Sans } from "next/font/google";
import { Provider } from "@/components/provider";
import { baseOptions } from "@/lib/layout.shared";
import { site } from "@/lib/shared";
import { source } from "@/lib/source";
import "./global.css";

const mona = Mona_Sans({
	subsets: ["latin"],
	variable: "--font-mona",
	display: "swap",
});
const mono = Geist_Mono({
	subsets: ["latin"],
	variable: "--font-geist-mono",
	display: "swap",
});

export const metadata: Metadata = {
	metadataBase: new URL(site.origin),
	title: { default: site.docsName, template: `%s | ${site.docsName}` },
	description:
		"Step-by-step guides for LogiStack, the open-source self-hosted PaaS: install it, deploy apps from Git, images, compose files and templates, add domains and HTTPS, run databases, backups, storage and more.",
	applicationName: site.docsName,
	authors: [{ name: site.company.name, url: site.company.url }],
	publisher: site.company.name,
	openGraph: { type: "website", siteName: site.docsName, locale: "en_US" },
	twitter: { card: "summary_large_image" },
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
	alternates: {
		types: { "text/plain": `${site.url}/llms.txt` },
	},
};

export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: dark)", color: "#111214" },
		{ media: "(prefers-color-scheme: light)", color: "#f7f7f8" },
	],
};

export default function Layout({ children }: LayoutProps<"/">) {
	return (
		<html
			lang="en"
			className={`${mona.variable} ${mono.variable}`}
			suppressHydrationWarning
		>
			<body className="flex min-h-screen flex-col font-sans antialiased">
				<Provider>
					<DocsLayout tree={source.getPageTree()} {...baseOptions()}>
						{children}
					</DocsLayout>
				</Provider>
			</body>
		</html>
	);
}

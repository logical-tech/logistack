/*
 * Brand marks. Paths come from simple-icons, imported one by one so the bundle carries only
 * these; brands simple-icons dropped (Slack, Teams, AWS) or never had are drawn here on its
 * 24×24 grid, one filled path each.
 */
import type { ServiceIcon } from "@logistack/contracts";
import { createLucideIcon, type LucideIcon } from "lucide-react";
import {
	si1password,
	siAngular,
	siApachekafka,
	siAppwrite,
	siAstro,
	siAuthentik,
	siBackblaze,
	siBitbucket,
	siBookstack,
	siBun,
	siCaddy,
	siClickhouse,
	siCloudflare,
	siCounterstrike,
	siDatadog,
	siDeno,
	siDigitalocean,
	siDirectus,
	siDiscord,
	siDjango,
	siDocker,
	siDotnet,
	siElasticsearch,
	siElixir,
	siExcalidraw,
	siExpress,
	siFastapi,
	siFlask,
	siForgejo,
	siGhost,
	siGitea,
	siGithub,
	siGitlab,
	siGo,
	siGrafana,
	siHetzner,
	siHomeassistant,
	siHono,
	siImmich,
	siInfluxdb,
	siJellyfin,
	siKeycloak,
	siLaravel,
	siListmonk,
	siMariadb,
	siMattermost,
	siMeilisearch,
	siMetabase,
	siMinio,
	siMongodb,
	siMumble,
	siMysql,
	siN8n,
	siNeo4j,
	siNextcloud,
	siNextdotjs,
	siNginx,
	siNodedotjs,
	siNodered,
	siNtfy,
	siNuxt,
	siOdoo,
	siOllama,
	siOpenjdk,
	siOpentelemetry,
	siOutline,
	siOvh,
	siPaperlessngx,
	siPenpot,
	siPhp,
	siPlausibleanalytics,
	siPocketbase,
	siPorkbun,
	siPortainer,
	siPostgresql,
	siPosthog,
	siPrometheus,
	siPython,
	siQdrant,
	siRabbitmq,
	siReact,
	siRedis,
	siRubyonrails,
	siRust,
	siRustfs,
	siSentry,
	siSpring,
	siSqlite,
	siStrapi,
	siSupabase,
	siSvelte,
	siTeamspeak,
	siTelegram,
	siTraefikproxy,
	siTurso,
	siUmami,
	siUptimekuma,
	siVault,
	siVaultwarden,
	siVite,
	siVuedotjs,
	siWasabi,
	siWordpress,
} from "simple-icons";
import { cn } from "@/lib/utils";

type Brand = {
	title: string;
	hex: string;
	path: string;
	/** Drawn marks with counters (a letter cut from a tile) need even-odd filling. */
	evenOdd?: boolean;
};

/** Brands simple-icons does not carry; simplified to read at 16px. */
const drawn = {
	slack: {
		title: "Slack",
		hex: "4A154B",
		path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
	},
	microsoftteams: {
		title: "Microsoft Teams",
		hex: "6264A7",
		// The T runs counter to the tile, so non-zero filling cuts it out.
		path: "M22.6 6.2a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0zM18.2 9.4h4.9a.9.9 0 0 1 .9.9v4a3.4 3.4 0 0 1-3.4 3.4 3.4 3.4 0 0 1-2.4-1zM16.9 4.9a3.1 3.1 0 1 1-6.2 0 3.1 3.1 0 0 1 6.2 0zM12.5 9.4h4.7a1 1 0 0 1 1 1v5.9a5 5 0 0 1-5 5 5 5 0 0 1-2.6-.7V18.5h.6a1.3 1.3 0 0 0 1.3-1.3zM1.3 6h9.9a1.3 1.3 0 0 1 1.3 1.3v9.9a1.3 1.3 0 0 1-1.3 1.3H1.3A1.3 1.3 0 0 1 0 17.2V7.3A1.3 1.3 0 0 1 1.3 6zM2.8 8.7v1.9h2.5v5.8h1.9v-5.8h2.5V8.7z",
	},
	aws: {
		title: "Amazon Web Services",
		hex: "FF9900",
		// The smile and its arrow, without the wordmark that would not read at icon size.
		path: "M.4 10.4 2.2 8.6c5.4 4.6 12.8 5.1 18 1.9l1.3 2.4C15.4 17.4 6.6 16.5.4 10.4zM16.8 9.3l7-1.7-1.6 7z",
	},
	garage: {
		title: "Garage",
		hex: "FF9329",
		evenOdd: true,
		path: "M12 1.5 1 8v14.5h22V8zM5 11h14v11.5H5zM6.5 13h11v1.6h-11zM6.5 16.5h11v1.6h-11zM6.5 20h11v1.6h-11z",
	},
	seaweedfs: {
		title: "SeaweedFS",
		hex: "2E9E5B",
		path: "M12 23c-1.6-3.2 1.8-5.6.2-9-1.4-3 1.5-5.3.3-9.5C14.5 7 16 10 14.2 13.5c-1.7 3.4 1.4 6-.4 9.5zM6.5 23C5 20.5 7.6 18.4 6.4 15.6 5.4 13.3 7.2 11.4 6.7 8.6c1.8 2 2.6 4.6 1.4 7.2-1.1 2.5.9 4.6-.2 7.2zM17.5 23c-1.3-2.3.8-4.2-.1-6.6-.8-2 .6-3.8.3-6.2 1.6 1.8 2.3 4 1.3 6.3-.9 2.2.8 4.1-.1 6.5z",
	},
	gotify: {
		title: "Gotify",
		hex: "3F9CDF",
		evenOdd: true,
		path: "M12 1.5C6.2 1.5 1.5 5.7 1.5 11c0 2.7 1.2 5.1 3.2 6.8l-1.2 4.7 5-2.6c1.1.3 2.3.5 3.5.5 5.8 0 10.5-4.2 10.5-9.5S17.8 1.5 12 1.5zM8.3 7.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM15.7 7.6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM7.6 12.6h1.7a2.8 2.8 0 0 0 5.4 0h1.7a4.5 4.5 0 0 1-8.8 0z",
	},
	pushover: {
		title: "Pushover",
		hex: "249DF1",
		evenOdd: true,
		path: "M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24zM9.6 5.2h4.6c2.6 0 4.3 1.6 3.9 4-.4 2.6-2.6 4.1-5.3 4.1h-1.6l-1.1 5.5H7.2zM11.6 7.6l-.8 3.6h1.5c1.2 0 2.1-.7 2.3-1.8.2-1.1-.5-1.8-1.6-1.8z",
	},
} satisfies Record<string, Brand>;

/** Every service icon the contracts allow, plus the integrations' brands. */
const BRANDS = {
	postgresql: siPostgresql,
	mysql: siMysql,
	mariadb: siMariadb,
	mongodb: siMongodb,
	redis: siRedis,
	turso: siTurso,
	sqlite: siSqlite,
	minio: siMinio,
	counterstrike: siCounterstrike,
	teamspeak: siTeamspeak,
	mumble: siMumble,
	rustfs: siRustfs,
	garage: drawn.garage,
	seaweedfs: drawn.seaweedfs,
	clickhouse: siClickhouse,
	elasticsearch: siElasticsearch,
	influxdb: siInfluxdb,
	neo4j: siNeo4j,
	qdrant: siQdrant,
	meilisearch: siMeilisearch,
	rabbitmq: siRabbitmq,
	apachekafka: siApachekafka,
	docker: siDocker,
	vault: siVault,
	onepassword: si1password,
	nginx: siNginx,
	caddy: siCaddy,
	traefikproxy: siTraefikproxy,
	nodedotjs: siNodedotjs,
	bun: siBun,
	deno: siDeno,
	python: siPython,
	go: siGo,
	rust: siRust,
	php: siPhp,
	openjdk: siOpenjdk,
	dotnet: siDotnet,
	elixir: siElixir,
	rubyonrails: siRubyonrails,
	django: siDjango,
	laravel: siLaravel,
	spring: siSpring,
	fastapi: siFastapi,
	flask: siFlask,
	express: siExpress,
	hono: siHono,
	nextdotjs: siNextdotjs,
	nuxt: siNuxt,
	astro: siAstro,
	react: siReact,
	vuedotjs: siVuedotjs,
	svelte: siSvelte,
	angular: siAngular,
	vite: siVite,
	wordpress: siWordpress,
	ghost: siGhost,
	strapi: siStrapi,
	directus: siDirectus,
	supabase: siSupabase,
	appwrite: siAppwrite,
	pocketbase: siPocketbase,
	n8n: siN8n,
	nodered: siNodered,
	grafana: siGrafana,
	prometheus: siPrometheus,
	uptimekuma: siUptimekuma,
	umami: siUmami,
	plausibleanalytics: siPlausibleanalytics,
	posthog: siPosthog,
	sentry: siSentry,
	metabase: siMetabase,
	gitea: siGitea,
	forgejo: siForgejo,
	nextcloud: siNextcloud,
	vaultwarden: siVaultwarden,
	keycloak: siKeycloak,
	authentik: siAuthentik,
	ollama: siOllama,
	portainer: siPortainer,
	homeassistant: siHomeassistant,
	jellyfin: siJellyfin,
	immich: siImmich,
	mattermost: siMattermost,
	listmonk: siListmonk,
	outline: siOutline,
	bookstack: siBookstack,
	paperlessngx: siPaperlessngx,
	penpot: siPenpot,
	excalidraw: siExcalidraw,
	odoo: siOdoo,
	// Integrations
	slack: drawn.slack,
	microsoftteams: drawn.microsoftteams,
	discord: siDiscord,
	telegram: siTelegram,
	ntfy: siNtfy,
	gotify: drawn.gotify,
	pushover: drawn.pushover,
	cloudflare: siCloudflare,
	aws: drawn.aws,
	hetzner: siHetzner,
	digitalocean: siDigitalocean,
	ovh: siOvh,
	porkbun: siPorkbun,
	backblaze: siBackblaze,
	wasabi: siWasabi,
	github: siGithub,
	gitlab: siGitlab,
	bitbucket: siBitbucket,
	datadog: siDatadog,
	opentelemetry: siOpentelemetry,
} satisfies Record<ServiceIcon, Brand> & Record<string, Brand>;

export type BrandSlug = keyof typeof BRANDS;

export const brandTitle = (slug: BrandSlug) => BRANDS[slug].title;

export function BrandIcon({
	slug,
	brandColor = false,
	title,
	className,
}: {
	slug: BrandSlug;
	/** Paint the brand's own hex instead of currentColor. */
	brandColor?: boolean;
	/** Announced to screen readers; without it the mark is decorative. */
	title?: string;
	className?: string;
}) {
	const b: Brand = BRANDS[slug];
	return (
		<svg
			viewBox="0 0 24 24"
			role={title ? "img" : undefined}
			aria-hidden={title ? undefined : true}
			aria-label={title}
			fill={brandColor ? `#${b.hex}` : "currentColor"}
			className={cn("size-4 shrink-0", className)}
		>
			<path d={b.path} fillRule={b.evenOdd ? "evenodd" : undefined} />
		</svg>
	);
}

const marks = new Map<BrandSlug, LucideIcon>();

/**
 * The mark as a LucideIcon, for slots that take one (wizard choices, kind tiles). Shrunk to
 * 20/24 so a filled mark sits at the optical size of the stroke icons beside it.
 */
export function brandMark(slug: BrandSlug): LucideIcon {
	let icon = marks.get(slug);
	if (!icon) {
		const b: Brand = BRANDS[slug];
		icon = createLucideIcon(`brand-${slug}`, [
			[
				"path",
				{
					d: b.path,
					fill: "currentColor",
					stroke: "none",
					fillRule: b.evenOdd ? "evenodd" : "nonzero",
					transform: "translate(2 2) scale(0.8333)",
					key: slug,
				},
			],
		]);
		marks.set(slug, icon);
	}
	return icon;
}

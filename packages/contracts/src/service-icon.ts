import { z } from "zod";
import type { DatabaseEngine } from "./enums.ts";
import type { ServiceSpec } from "./service-spec.ts";
import type { StorageEngine } from "./storage.ts";

/** Brand icons a service may show; the web keeps one path per slug (most from simple-icons). */
export const serviceIcons = [
	// Database and storage engines
	"postgresql",
	"mysql",
	"mariadb",
	"mongodb",
	"redis",
	"turso",
	"sqlite",
	"minio",
	"rustfs",
	"garage",
	"seaweedfs",
	"clickhouse",
	"elasticsearch",
	"influxdb",
	"neo4j",
	"qdrant",
	"meilisearch",
	"rabbitmq",
	"apachekafka",
	// Runtimes and frameworks
	"docker",
	"nginx",
	"caddy",
	"traefikproxy",
	"nodedotjs",
	"bun",
	"deno",
	"python",
	"go",
	"rust",
	"php",
	"openjdk",
	"dotnet",
	"elixir",
	"rubyonrails",
	"django",
	"laravel",
	"spring",
	"fastapi",
	"flask",
	"express",
	"hono",
	"nextdotjs",
	"nuxt",
	"astro",
	"react",
	"vuedotjs",
	"svelte",
	"angular",
	"vite",
	// Apps
	"wordpress",
	"ghost",
	"strapi",
	"directus",
	"supabase",
	"appwrite",
	"pocketbase",
	"n8n",
	"nodered",
	"grafana",
	"prometheus",
	"uptimekuma",
	"umami",
	"plausibleanalytics",
	"posthog",
	"sentry",
	"metabase",
	"gitea",
	"forgejo",
	"nextcloud",
	"vaultwarden",
	"keycloak",
	"authentik",
	"ollama",
	"portainer",
	"homeassistant",
	"jellyfin",
	"immich",
	"mattermost",
	"listmonk",
	"outline",
	"bookstack",
	"paperlessngx",
	"penpot",
	"excalidraw",
	"odoo",
] as const;

export const ServiceIcon = z.enum(serviceIcons);
export type ServiceIcon = z.infer<typeof ServiceIcon>;

export const isServiceIcon = (s: string): s is ServiceIcon =>
	(serviceIcons as readonly string[]).includes(s);

export const databaseIcon: Record<DatabaseEngine, ServiceIcon> = {
	postgres: "postgresql",
	mysql: "mysql",
	mariadb: "mariadb",
	mongo: "mongodb",
	redis: "redis",
	libsql: "turso",
};

export const storageIcon: Record<StorageEngine, ServiceIcon> = {
	minio: "minio",
	rustfs: "rustfs",
	garage: "garage",
	seaweedfs: "seaweedfs",
};

/** Image names that differ from their brand slug. */
const imageAlias: Record<string, ServiceIcon> = {
	postgres: "postgresql",
	postgis: "postgresql",
	mongo: "mongodb",
	node: "nodedotjs",
	valkey: "redis",
	"uptime-kuma": "uptimekuma",
	"node-red": "nodered",
	"paperless-ngx": "paperlessngx",
	"home-assistant": "homeassistant",
	"immich-server": "immich",
	plausible: "plausibleanalytics",
	traefik: "traefikproxy",
	"eclipse-temurin": "openjdk",
	kafka: "apachekafka",
};

/** `ghcr.io/org/name:tag@sha256:…` → the brand of `name`, when we draw it. */
export function imageIcon(image: string): ServiceIcon | null {
	const name = image.split("@")[0]?.split("/").pop()?.split(":")[0] ?? "";
	const icon = imageAlias[name] ?? name;
	return isServiceIcon(icon) ? icon : null;
}

/** The icon a service shows when none was picked: its engine's, or its image's when we know it. */
export function defaultServiceIcon(spec: ServiceSpec): ServiceIcon | null {
	if (spec.kind === "database") return databaseIcon[spec.engine];
	if (spec.kind === "storage") return storageIcon[spec.engine];
	if (spec.kind !== "application" || spec.source.type !== "image") return null;
	return imageIcon(spec.source.image);
}

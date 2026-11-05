/**
 * The migration inventory every source reader produces: one item per source service, each
 * `full`, `partial` (with notes) or `unsupported` (with notes), carrying the LogiStack drafts that
 * replace it, plus organization resources. Notes name keys, paths and hosts, never values.
 */
import type {
	ApplicationSpec,
	BackupRetention,
	DatabaseSpec,
	DomainInput,
	EventType,
	MigrationSource,
	NotificationChannelKind,
} from "@logistack/contracts";
import type { SourceDescriptor } from "@logistack/core";
import type { githubConfig } from "@logistack/providers";
import type { z } from "zod";
import type { RegistryInput } from "../routes/registries.ts";
import type { Connection } from "../routes/s3-destinations.ts";

export type Status = "full" | "partial" | "unsupported";

export type EnvDraft = { key: string; value: string; isSecret: boolean };

/** A database backup policy; MIG-3 points it at the destination imported from `destination`. */
export type BackupDraft = {
	/** The source's id of the destination (Dokploy's `destinationId`, Coolify's S3 storage id). */
	destination: string;
	cron: string;
	retention: BackupRetention;
	enabled: boolean;
};

export type ServiceDraft = {
	name: string;
	/**
	 * DNS name on the environment network: the name other services already use (Dokploy's
	 * `appName`, a Coolify database's uuid), the service name for compose services.
	 */
	slug: string;
	/** Slugs of the services in the same item this one starts after. */
	dependsOn: string[];
	/** `<source>:<id>`; a re-import skips a service that carries it. */
	importedFrom: string;
	spec: ApplicationSpec | DatabaseSpec;
	mounts: (
		| { kind: "volume"; name: string; target: string }
		| { kind: "config"; target: string; content: string }
	)[];
	adoptedVolumes: {
		target: string;
		volume: string;
		source: MigrationSource;
	}[];
	/** Service-scope env; for a database it replaces the credentials LogiStack would mint. */
	env: EnvDraft[];
	domains: DomainInput[];
	basicAuth: { username: string; password: string }[];
	/** The source's git provider the build needs; the import binds the imported one. */
	gitProvider?: {
		type: "github" | "gitlab" | "gitea" | "bitbucket";
		sourceId: string;
	};
	/**
	 * Names the source's proxy and remaining services reach it by until the source is removed
	 * (`migration_bridge`); `routes` when that proxy routes its domains by labels.
	 */
	bridge?: { aliases: string[]; routes: boolean };
	/** The source last ran it; a stopped or never-deployed service stays stopped. */
	running: boolean;
	backups: BackupDraft[];
};

export type InventoryItem = {
	/** `application`, `compose`, `service` or a database engine. */
	kind: string;
	sourceId: string;
	/** The source's own name for it (Dokploy's `appName`, Coolify's uuid); shown as its id. */
	appName: string;
	/** Where it runs on the source; the cutover stops and restarts exactly this. */
	source: SourceDescriptor;
	name: string;
	project: string;
	environment: string;
	status: Status;
	notes: string[];
	services: ServiceDraft[];
};

export type Inventory = { items: InventoryItem[]; org: OrgItem[] };

export type OrgDraft =
	| { kind: "registry"; input: z.input<typeof RegistryInput> }
	| {
			kind: "s3Destination";
			input: z.input<typeof Connection> & { name: string };
	  }
	| {
			kind: "notificationChannel";
			input: { name: string; kind: NotificationChannelKind; config: unknown };
			/** One rule over the whole organization; none when no event maps. */
			events: EventType[];
	  }
	| { kind: "sshKey"; input: { name: string; privateKey: string } }
	| {
			kind: "gitProvider";
			/** Stored as is: a GitHub App keeps its key, webhook secret and installation. */
			input: {
				name: string;
				kind: "github";
				config: z.input<typeof githubConfig>;
			};
	  };

export type OrgItem = {
	kind: OrgDraft["kind"];
	/** The source's id: what services and backups reference (`githubId`, `destinationId`...). */
	sourceId: string;
	name: string;
	status: Status;
	notes: string[];
	draft?: OrgDraft;
};

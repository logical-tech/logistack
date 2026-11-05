/**
 * Pure mapping of Dokploy's organization-level resources (registries, S3 destinations, notification
 * channels, SSH keys, git providers) to the bodies of LogiStack's create routes. Each becomes an
 * `OrgItem`, `full`, `partial` or `unsupported`, like services. Notes name things, never values.
 */
import {
	type EventType,
	eventTypes,
	type NotificationChannelKind,
} from "@logistack/contracts";
import { githubConfig, notificationChannels } from "@logistack/providers";
import type { z } from "zod";
import { RegistryInput } from "../../routes/registries.ts";
import { Connection } from "../../routes/s3-destinations.ts";
import type { OrgDraft, OrgItem } from "../types.ts";
import type {
	DokployDestination,
	DokployGitProvider,
	DokployNotification,
	DokployNotificationTarget,
	DokployRegistry,
	DokploySnapshot,
} from "./snapshot.ts";

export type { OrgDraft, OrgItem };

const item = (
	kind: OrgItem["kind"],
	sourceId: string,
	name: string,
	notes: string[],
	draft: OrgDraft | undefined,
): OrgItem => ({
	kind,
	sourceId,
	name,
	notes,
	status: !draft ? "unsupported" : notes.length ? "partial" : "full",
	...(draft && { draft }),
});

/** Zod messages for a body the LogiStack route would refuse, or none. */
const refused = (schema: z.ZodType, input: unknown, notes: string[]) => {
	const parsed = schema.safeParse(input);
	if (parsed.success) return false;
	notes.push(
		...parsed.error.issues.map(
			(i) => `${i.path.join(".") || "input"}: ${i.message}`,
		),
	);
	return true;
};

const DOCKER_HUB = /^((index|registry-1)\.)?docker\.io$/;

function mapRegistry(r: DokployRegistry): OrgItem {
	const notes: string[] = [];
	const host = r.registryUrl
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/v[12]\/?$/, "")
		.replace(/\/+$/, "")
		.toLowerCase();
	const prefix = r.imagePrefix?.trim().replace(/^\/+|\/+$/g, "");
	const hub = !host || DOCKER_HUB.test(host);
	const input = {
		kind: hub
			? ("dockerhub" as const)
			: host === "ghcr.io"
				? ("ghcr" as const)
				: host === "registry.gitlab.com"
					? ("gitlab" as const)
					: ("generic" as const),
		url: hub
			? `docker.io/${(prefix || r.username).toLowerCase()}`
			: prefix
				? `${host}/${prefix}`
				: host,
		username: r.username,
		password: r.password,
	};
	const draft = refused(RegistryInput, input, notes)
		? undefined
		: { kind: "registry" as const, input };
	return item("registry", r.registryId, r.registryName, notes, draft);
}

function mapDestination(d: DokployDestination): OrgItem {
	const notes: string[] = [];
	const flags = d.additionalFlags ?? [];
	const pathStyle = flags.some((f) => /force[-_]path[-_]style/i.test(f));
	const other = flags.filter((f) => !/force[-_]path[-_]style/i.test(f));
	if (other.length)
		notes.push(`rclone flags ${other.join(" ")} are not carried over`);
	const input = {
		name: d.name,
		endpoint: /^https?:\/\//.test(d.endpoint)
			? d.endpoint
			: `https://${d.endpoint}`,
		region: d.region || "us-east-1",
		bucket: d.bucket,
		accessKeyId: d.accessKey,
		secretAccessKey: d.secretAccessKey,
		// rclone addresses non-AWS endpoints path-style unless told otherwise; so does MinIO.
		forcePathStyle: pathStyle || (d.provider !== "AWS" && d.provider !== null),
	};
	const draft = refused(Connection, input, notes)
		? undefined
		: { kind: "s3Destination" as const, input };
	return item("s3Destination", d.destinationId, d.name, notes, draft);
}

/** Dokploy's switches as LogiStack events; the ones LogiStack has no event for are named. */
const EVENTS: Record<string, { events: EventType[]; label: string }> = {
	appDeploy: {
		events: ["deployment.succeeded"],
		label: "deploys",
	},
	appBuildError: { events: ["deployment.failed"], label: "build errors" },
	databaseBackup: {
		events: ["backup.succeeded", "backup.failed"],
		label: "database backups",
	},
	volumeBackup: {
		events: ["backup.succeeded", "backup.failed"],
		label: "volume backups",
	},
	serverThreshold: { events: ["metric.threshold"], label: "server threshold" },
	dokployRestart: { events: [], label: "Dokploy restarts" },
	dokployBackup: { events: [], label: "Dokploy backups" },
	dockerCleanup: { events: [], label: "Docker cleanup" },
};

/** The channel config LogiStack's channel of that kind takes, or why there is none. */
function channelOf(
	t: DokployNotificationTarget,
	notes: string[],
): { kind: NotificationChannelKind; config: unknown } | undefined {
	const webhook = (kind: NotificationChannelKind) => ({
		kind,
		config: { webhookUrl: t.webhookUrl },
	});
	switch (t.type) {
		case "slack":
			if (t.channel) notes.push(`Slack channel override ${t.channel} dropped`);
			return webhook("slack");
		case "discord":
			return webhook("discord");
		case "teams":
			return webhook("teams");
		case "mattermost":
			if (t.channel || t.username)
				notes.push("Mattermost channel and username overrides dropped");
			return webhook("mattermost");
		case "telegram":
			if (t.messageThreadId) notes.push("Telegram topic thread dropped");
			return {
				kind: "telegram",
				config: { botToken: t.botToken, chatId: t.chatId },
			};
		case "email":
			return {
				kind: "email",
				config: {
					transport: "smtp",
					host: t.smtpServer,
					port: t.smtpPort,
					secure: t.smtpPort === 465,
					...(t.username && { username: t.username, password: t.password }),
					from: t.fromAddress,
					to: t.toAddress,
				},
			};
		case "resend":
			return {
				kind: "email",
				config: {
					transport: "resend",
					apiKey: t.apiKey,
					from: t.fromAddress,
					to: t.toAddress,
				},
			};
		case "gotify":
			return {
				kind: "gotify",
				config: { serverUrl: t.serverUrl, appToken: t.appToken },
			};
		case "ntfy":
			return {
				kind: "ntfy",
				config: {
					serverUrl: t.serverUrl,
					topic: t.topic,
					...(t.accessToken && { token: t.accessToken }),
				},
			};
		case "pushover":
			return {
				kind: "pushover",
				config: { appToken: t.apiToken, userKey: t.userKey },
			};
		case "custom":
			notes.push(
				"custom webhook: LogiStack webhooks are signed and take no headers; recreate it",
			);
			return undefined;
		case "lark":
			notes.push("Lark is not a LogiStack channel");
			return undefined;
	}
}

function mapNotification(
	n: DokployNotification,
	targets: DokployNotificationTarget[],
): OrgItem {
	const notes: string[] = [];
	const done = (draft?: OrgDraft) =>
		item("notificationChannel", n.notificationId, n.name, notes, draft);
	const target = targets.find(
		(t) => t.type === n.notificationType && t.targetId === n.targetId,
	);
	if (!target) {
		notes.push(`${n.notificationType} settings not found`);
		return done();
	}
	const channel = channelOf(target, notes);
	if (!channel) return done();
	const events = new Set<EventType>();
	const dropped: string[] = [];
	for (const [column, { events: mapped, label }] of Object.entries(EVENTS)) {
		if (!n[column as keyof DokployNotification]) continue;
		for (const e of mapped) events.add(e);
		if (!mapped.length) dropped.push(label);
	}
	if (dropped.length)
		notes.push(`LogiStack sends no event for ${dropped.join(", ")}`);
	if (!events.size) notes.push("no event to send; the channel gets no rule");
	if (
		refused(
			notificationChannels[channel.kind].configSchema,
			channel.config,
			notes,
		)
	)
		return done();
	return done({
		kind: "notificationChannel",
		input: { name: n.name, ...channel },
		events: eventTypes.filter((e) => events.has(e)),
	});
}

function mapGitProvider(g: DokployGitProvider, name: string): OrgItem {
	const notes: string[] = [];
	const done = (draft?: OrgDraft) =>
		item("gitProvider", g.id, name, notes, draft);
	if (g.type !== "github") {
		notes.push(
			`${g.type} is connected through OAuth in Dokploy; LogiStack needs an access token, reconnect it`,
		);
		return done();
	}
	if (g.url && g.url.replace(/\/+$/, "") !== "https://github.com") {
		notes.push(`GitHub Enterprise (${g.url}) is not supported`);
		return done();
	}
	if (!g.githubInstallationId) {
		notes.push("the GitHub App was never installed; create it in LogiStack");
		return done();
	}
	const config = {
		appId: String(g.githubAppId ?? ""),
		privateKey: g.githubPrivateKey ?? "",
		webhookSecret: g.githubWebhookSecret ?? "",
		installationId: g.githubInstallationId,
	};
	if (refused(githubConfig, config, notes)) return done();
	// The app's webhook still points at Dokploy: the cutover moves it (MIG-3).
	return done({
		kind: "gitProvider",
		input: { name, kind: "github", config },
	});
}

export function buildOrgItems(s: DokploySnapshot): OrgItem[] {
	const names = new Map(
		s.gitProviderNames.map((g) => [g.gitProviderId, g.name]),
	);
	return [
		...s.registries.map(mapRegistry),
		...s.destinations.map(mapDestination),
		...s.notifications.map((n) => mapNotification(n, s.notificationTargets)),
		...s.sshKeys.map((k) =>
			item(
				"sshKey",
				k.sshKeyId,
				k.name,
				k.privateKey ? [] : ["only the public key is stored"],
				k.privateKey
					? {
							kind: "sshKey",
							input: { name: k.name.slice(0, 64), privateKey: k.privateKey },
						}
					: undefined,
			),
		),
		...s.gitProviders.map((g) =>
			mapGitProvider(g, names.get(g.gitProviderId) ?? g.type),
		),
	];
}

/**
 * Pure mapping of Coolify's team-level resources (S3 storages, deploy keys, GitHub Apps,
 * notifications) to the bodies of LogiStack's create routes, as `OrgItem`s. Notes name things,
 * never values.
 */
import {
	type EventType,
	eventTypes,
	type NotificationChannelKind,
} from "@logistack/contracts";
import { githubConfig, notificationChannels } from "@logistack/providers";
import { Connection } from "../../routes/s3-destinations.ts";
import { orgItem as item, refused } from "../shared.ts";
import type { OrgDraft, OrgItem } from "../types.ts";
import type { CoolifyNotification, CoolifySnapshot } from "./snapshot.ts";

function mapS3(s: CoolifySnapshot["s3"][number]): OrgItem {
	const notes: string[] = [];
	const endpoint = s.endpoint ?? "";
	const input = {
		name: s.name,
		endpoint: /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`,
		region: s.region || "us-east-1",
		bucket: s.bucket ?? "",
		accessKeyId: s.key ?? "",
		secretAccessKey: s.secret ?? "",
		// Coolify addressed every endpoint path-style before it had the switch (4.x, 2026).
		forcePathStyle: s.use_path_style_endpoint ?? true,
	};
	if (!s.key || !s.secret)
		notes.push("its keys could not be decrypted with Coolify's APP_KEY");
	const draft =
		notes.length || refused(Connection, input, notes)
			? undefined
			: { kind: "s3Destination" as const, input };
	return item("s3Destination", String(s.id), s.name, notes, draft);
}

/** Coolify's switches as LogiStack events; the ones LogiStack has no event for are named. */
const EVENTS: Record<string, { events: EventType[]; label: string }> = {
	deployment_success: { events: ["deployment.succeeded"], label: "deploys" },
	deployment_failure: {
		events: ["deployment.failed"],
		label: "failed deploys",
	},
	backup_success: { events: ["backup.succeeded"], label: "backups" },
	backup_failure: { events: ["backup.failed"], label: "failed backups" },
	server_disk_usage: { events: ["metric.threshold"], label: "disk usage" },
	status_change: { events: [], label: "container status changes" },
	scheduled_task_success: { events: [], label: "scheduled tasks" },
	scheduled_task_failure: { events: [], label: "failed scheduled tasks" },
	docker_cleanup_success: { events: [], label: "Docker cleanup" },
	docker_cleanup_failure: { events: [], label: "failed Docker cleanup" },
	server_unreachable: { events: [], label: "server reachability" },
};

const LABEL: Record<CoolifyNotification["type"], string> = {
	discord: "Discord",
	slack: "Slack",
	telegram: "Telegram",
	email: "Email",
	pushover: "Pushover",
	webhook: "Webhook",
};

function channelOf(
	n: CoolifyNotification,
	notes: string[],
):
	| { kind: Exclude<NotificationChannelKind, "plugin">; config: unknown }
	| undefined {
	switch (n.type) {
		case "discord":
		case "slack":
			return { kind: n.type, config: { webhookUrl: n.webhook_url } };
		case "telegram":
			return {
				kind: "telegram",
				config: { botToken: n.telegram_token, chatId: n.telegram_chat_id },
			};
		case "pushover":
			return {
				kind: "pushover",
				config: {
					appToken: n.pushover_api_token,
					userKey: n.pushover_user_key,
				},
			};
		case "email": {
			if (n.use_instance_email_settings) {
				notes.push(
					"uses Coolify's instance-wide email settings; set SMTP up in LogiStack",
				);
				return undefined;
			}
			const to = (n.smtp_recipients ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (n.resend_enabled)
				return {
					kind: "email",
					config: {
						transport: "resend",
						apiKey: n.resend_api_key,
						from: n.smtp_from_address,
						to,
					},
				};
			return {
				kind: "email",
				config: {
					transport: "smtp",
					host: n.smtp_host,
					port: n.smtp_port,
					secure: n.smtp_encryption === "ssl" || n.smtp_port === 465,
					...(n.smtp_username && {
						username: n.smtp_username,
						password: n.smtp_password,
					}),
					from: n.smtp_from_address,
					to,
				},
			};
		}
		case "webhook":
			notes.push(
				"generic webhook: LogiStack webhooks are signed and differ in shape; recreate it",
			);
			return undefined;
	}
}

const enabled = (n: CoolifyNotification) =>
	n.type === "email" ? !!(n.smtp_enabled || n.resend_enabled) : !!n.enabled;

function mapNotification(n: CoolifyNotification, team: string): OrgItem {
	const notes: string[] = [];
	const name = `${LABEL[n.type]} (${team})`;
	const done = (draft?: OrgDraft) =>
		item("notificationChannel", `${n.type}:${n.team_id}`, name, notes, draft);
	const channel = channelOf(n, notes);
	if (!channel) return done();
	const events = new Set<EventType>();
	const dropped: string[] = [];
	for (const [column, { events: mapped, label }] of Object.entries(EVENTS)) {
		if (!n[column as keyof CoolifyNotification]) continue;
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
		input: { name, ...channel },
		events: eventTypes.filter((e) => events.has(e)),
	});
}

export function buildCoolifyOrgItems(s: CoolifySnapshot): OrgItem[] {
	const keys = new Map(s.privateKeys.map((k) => [k.id, k]));
	const appKeys = new Set(s.githubApps.map((g) => g.private_key_id));
	const teams = new Map(s.teams.map((t) => [t.id, t.name]));
	const out: OrgItem[] = [...s.s3.map(mapS3)];
	// Deploy keys only: Coolify's own key to its servers and GitHub App keys are not users' keys.
	for (const k of s.privateKeys) {
		if (!k.is_git_related || appKeys.has(k.id)) continue;
		const notes = k.private_key
			? []
			: ["the key could not be decrypted with Coolify's APP_KEY"];
		out.push(
			item(
				"sshKey",
				String(k.id),
				k.name,
				notes,
				k.private_key
					? {
							kind: "sshKey",
							input: { name: k.name.slice(0, 64), privateKey: k.private_key },
						}
					: undefined,
			),
		);
	}
	for (const g of s.githubApps) {
		// The seeded "Public GitHub" source: public repositories, nothing to carry over.
		if (g.is_public) continue;
		const notes: string[] = [];
		const done = (draft?: OrgDraft) =>
			item("gitProvider", String(g.id), g.name, notes, draft);
		if (g.html_url && g.html_url.replace(/\/+$/, "") !== "https://github.com") {
			notes.push(`GitHub Enterprise (${g.html_url}) is not supported`);
			out.push(done());
			continue;
		}
		if (!g.installation_id) {
			notes.push("the GitHub App was never installed; create it in LogiStack");
			out.push(done());
			continue;
		}
		const config = {
			appId: String(g.app_id ?? ""),
			privateKey: keys.get(g.private_key_id ?? -1)?.private_key ?? "",
			webhookSecret: g.webhook_secret ?? "",
			installationId: String(g.installation_id),
		};
		if (refused(githubConfig, config, notes)) {
			out.push(done());
			continue;
		}
		// The app's webhook still points at Coolify: the cutover moves it.
		out.push(
			done({
				kind: "gitProvider",
				input: { name: g.name, kind: "github", config },
			}),
		);
	}
	for (const g of s.gitlabApps)
		if (g.name !== "Public GitLab")
			out.push(
				item(
					"gitProvider",
					`gitlab:${g.id}`,
					g.name,
					[
						"GitLab apps are connected through OAuth in Coolify; LogiStack needs an access token, reconnect it",
					],
					undefined,
				),
			);
	for (const n of s.notifications)
		if (enabled(n))
			out.push(mapNotification(n, teams.get(n.team_id) ?? `team ${n.team_id}`));
	return out;
}

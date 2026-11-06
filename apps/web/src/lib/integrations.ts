import { type LucideIcon, Mail, Webhook } from "lucide-react";
import { brandMark } from "@/components/brand-icon";
import type {
	AcmeDirectory,
	ChannelKind,
	DnsKind,
	EventType,
	TlsMode,
} from "@/lib/api/networking";

/** One registry for every kind the UI names: label, icon and where the credential comes from. */
export const DNS_KINDS: Record<
	DnsKind,
	{ label: string; icon: LucideIcon; blurb: string; where: string }
> = {
	cloudflare: {
		label: "Cloudflare",
		icon: brandMark("cloudflare"),
		blurb: "API token scoped to the zones LogiStack may edit.",
		where:
			"My Profile → API Tokens → Create Token → “Edit zone DNS”, limited to the zones you choose.",
	},
	route53: {
		label: "Amazon Route 53",
		icon: brandMark("aws"),
		blurb: "IAM access key with Route 53 record permissions.",
		where:
			"An IAM user or role with route53:ListHostedZones, ListResourceRecordSets and ChangeResourceRecordSets.",
	},
	hetzner: {
		label: "Hetzner DNS",
		icon: brandMark("hetzner"),
		blurb: "Hetzner Cloud API token with read and write access.",
		where:
			"Hetzner Console → your project → Security → API tokens → Read & Write.",
	},
};

export const CHANNEL_KINDS: Record<
	ChannelKind,
	{ label: string; icon: LucideIcon; blurb: string }
> = {
	slack: {
		label: "Slack",
		icon: brandMark("slack"),
		blurb: "An incoming webhook for one channel.",
	},
	discord: {
		label: "Discord",
		icon: brandMark("discord"),
		blurb: "A channel webhook, as an embed coloured by severity.",
	},
	email: {
		label: "Email",
		icon: Mail,
		blurb: "SMTP or Resend, to one or more addresses.",
	},
	telegram: {
		label: "Telegram",
		icon: brandMark("telegram"),
		blurb: "A bot posting to a chat or group.",
	},
	teams: {
		label: "Microsoft Teams",
		icon: brandMark("microsoftteams"),
		blurb: "A Workflows incoming webhook.",
	},
	mattermost: {
		label: "Mattermost",
		icon: brandMark("mattermost"),
		blurb: "An incoming webhook on your server.",
	},
	ntfy: {
		label: "ntfy",
		icon: brandMark("ntfy"),
		blurb: "Push to a topic on ntfy.sh or your own server.",
	},
	gotify: {
		label: "Gotify",
		icon: brandMark("gotify"),
		blurb: "Push through a self-hosted Gotify.",
	},
	pushover: {
		label: "Pushover",
		icon: brandMark("pushover"),
		blurb: "Push to your Pushover devices.",
	},
	webhook: {
		label: "Signed webhook",
		icon: Webhook,
		blurb: "JSON POST signed with HMAC-SHA256, for your own receiver.",
	},
};

export const EVENT_GROUPS: {
	label: string;
	events: { type: EventType; label: string }[];
}[] = [
	{
		label: "Deployments",
		events: [
			{ type: "deployment.failed", label: "Failed" },
			{ type: "deployment.succeeded", label: "Succeeded" },
			{ type: "deployment.started", label: "Started" },
			{ type: "deployment.cancelled", label: "Cancelled" },
			{ type: "deployment.queued", label: "Queued" },
		],
	},
	{
		label: "Certificates and domains",
		events: [
			{ type: "certificate.expiring", label: "Certificate expiring" },
			{ type: "certificate.failed", label: "Certificate failed" },
			{ type: "certificate.issued", label: "Certificate issued" },
			{ type: "domain.error", label: "Domain error" },
			{ type: "domain.active", label: "Domain active" },
		],
	},
	{
		label: "Nodes and services",
		events: [
			{ type: "node.down", label: "Node down" },
			{ type: "node.recovered", label: "Node recovered" },
			{ type: "node.joined", label: "Node joined" },
			{ type: "service.status_changed", label: "Service status changed" },
			{ type: "service.crash_loop", label: "Service crash-looping" },
			{ type: "service.threshold", label: "Service threshold crossed" },
			{ type: "metric.threshold", label: "Node threshold crossed" },
		],
	},
	{
		label: "Backups and schedules",
		events: [
			{ type: "backup.failed", label: "Backup failed" },
			{ type: "backup.succeeded", label: "Backup succeeded" },
			{ type: "schedule.failed", label: "Schedule failed" },
			{ type: "schedule.succeeded", label: "Schedule succeeded" },
		],
	},
	{
		label: "Instance",
		events: [{ type: "instance.update_available", label: "Update available" }],
	},
];

export const eventLabel = (t: EventType) => {
	for (const g of EVENT_GROUPS)
		for (const e of g.events)
			if (e.type === t)
				return g.label === "Deployments"
					? `Deployment ${e.label.toLowerCase()}`
					: e.label;
	return t;
};

export const TLS_MODES: Record<TlsMode, { label: string; short: string }> = {
	"http-01": { label: "Automatic, HTTP-01", short: "HTTP-01" },
	"dns-01": { label: "Automatic, DNS-01", short: "DNS-01" },
	custom: { label: "Uploaded certificate", short: "Uploaded" },
	none: { label: "HTTP only", short: "None" },
};

export const ACME_DIRECTORIES: Record<
	AcmeDirectory,
	{ label: string; description: string }
> = {
	letsencrypt: {
		label: "Let's Encrypt",
		description: "Trusted everywhere. The default for production.",
	},
	"letsencrypt-staging": {
		label: "Let's Encrypt staging",
		description:
			"Untrusted test certificates with generous rate limits. Use it while you try domains out.",
	},
	zerossl: {
		label: "ZeroSSL",
		description:
			"Trusted, with its own rate limits. Caddy registers with your Let's Encrypt email.",
	},
	internal: {
		label: "Caddy's internal CA",
		description:
			"Self-signed, never leaves the server. For air-gapped installs and tests; browsers will warn.",
	},
};

const WORDS: Record<string, string> = {
	api: "API",
	url: "URL",
	id: "ID",
	smtp: "SMTP",
	to: "To",
};

/** `secretAccessKey` → "Secret access key", `webhookUrl` → "Webhook URL". */
export function fieldLabel(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(" ")
		.map((w) => WORDS[w] ?? w);
	const [first = "", ...rest] = words;
	return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

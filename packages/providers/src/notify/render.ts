import type { EventEnvelope, EventType } from "@logistack/contracts";
import type { Rendered, Severity } from "./types.ts";

const templates: Record<EventType, { severity: Severity; what: string }> = {
	"deployment.queued": { severity: "info", what: "Deployment queued" },
	"deployment.started": { severity: "info", what: "Deployment started" },
	"deployment.succeeded": { severity: "success", what: "Deployment succeeded" },
	"deployment.failed": { severity: "error", what: "Deployment failed" },
	"deployment.cancelled": { severity: "warning", what: "Deployment cancelled" },
	"service.status_changed": {
		severity: "info",
		what: "Service status changed",
	},
	"service.crash_loop": { severity: "error", what: "Service crash-looping" },
	"service.threshold": {
		severity: "warning",
		what: "Service threshold crossed",
	},
	"service.scaled": { severity: "info", what: "Service scaled" },
	"backup.succeeded": { severity: "success", what: "Backup succeeded" },
	"backup.failed": { severity: "error", what: "Backup failed" },
	"schedule.succeeded": {
		severity: "success",
		what: "Scheduled job succeeded",
	},
	"schedule.failed": { severity: "error", what: "Scheduled job failed" },
	"node.joined": { severity: "info", what: "Node joined" },
	"node.down": { severity: "error", what: "Node down" },
	"node.recovered": { severity: "success", what: "Node recovered" },
	"node.patches_available": {
		severity: "warning",
		what: "Security updates available",
	},
	"node.patch_succeeded": { severity: "success", what: "Node patched" },
	"node.patch_failed": { severity: "error", what: "Node patching failed" },
	"metric.threshold": {
		severity: "warning",
		what: "Resource threshold crossed",
	},
	"certificate.issued": { severity: "success", what: "Certificate issued" },
	"certificate.failed": { severity: "error", what: "Certificate failed" },
	"certificate.expiring": { severity: "warning", what: "Certificate expiring" },
	"domain.active": { severity: "success", what: "Domain active" },
	"domain.error": { severity: "error", what: "Domain error" },
	"migration.item_changed": { severity: "info", what: "Migration progress" },
	"image.vulnerable": {
		severity: "error",
		what: "Critical vulnerabilities found",
	},
	"instance.update_available": {
		severity: "info",
		what: "LogiStack update available",
	},
	"instance.update_succeeded": {
		severity: "success",
		what: "LogiStack updated",
	},
	"instance.update_failed": {
		severity: "error",
		what: "LogiStack update failed",
	},
};

const str = (v: unknown) =>
	typeof v === "string" && v.length > 0 ? v : undefined;

// Payloads are untyped per event (see contracts EventEnvelope); read the common keys producers set.
const details: [key: string, label: string][] = [
	["project", "Project"],
	["environment", "Environment"],
	["service", "Service"],
	["node", "Node"],
	["hostname", "Domain"],
	["status", "Status"],
	["commit", "Commit"],
	["expiresAt", "Expires"],
];

export function renderEvent(event: EventEnvelope): Rendered {
	const p = event.payload;
	// `firing` / `resolved` events share one type; a resolution reads as one.
	const t =
		p.state === "resolved"
			? {
					severity: "success" as const,
					what: `Resolved: ${templates[event.type].what}`,
				}
			: templates[event.type];
	const subject =
		str(p.name) ?? str(p.service) ?? str(p.hostname) ?? str(p.node);
	const reason = str(p.error) ?? str(p.message) ?? str(p.reason);
	const lines = [
		...(reason ? [reason] : []),
		...details.flatMap(([key, label]) => {
			const v = str(p[key]);
			return v ? [`${label}: ${v}`] : [];
		}),
		`At: ${event.at.toISOString()}`,
	];
	const url = str(p.url);
	return {
		title: subject ? `${t.what}: ${subject}` : t.what,
		body: lines.join("\n"),
		severity: t.severity,
		...(url ? { url } : {}),
	};
}

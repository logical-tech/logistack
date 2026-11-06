import { z } from "zod";

export const eventTypes = [
	"deployment.queued",
	"deployment.started",
	"deployment.succeeded",
	"deployment.failed",
	"deployment.cancelled",
	"service.status_changed",
	"backup.succeeded",
	"backup.failed",
	"schedule.succeeded",
	"schedule.failed",
	"node.joined",
	"node.down",
	"node.recovered",
	"metric.threshold",
	"certificate.issued",
	"certificate.failed",
	"certificate.expiring",
	"domain.active",
	"domain.error",
	"instance.update_available",
	"instance.update_succeeded",
	"instance.update_failed",
	/** A migration item changed status; resource `migration:<id>`, payload names the item. */
	"migration.item_changed",
] as const;
export const EventType = z.enum(eventTypes);
export type EventType = z.infer<typeof EventType>;

export const EventEnvelope = z.object({
	id: z.string(),
	type: EventType,
	organizationId: z.string(),
	resource: z.object({ type: z.string(), id: z.string() }),
	// shortcut: payload is untyped per event type, add a per-type discriminated union once producers settle on shapes.
	payload: z.record(z.string(), z.unknown()),
	at: z.coerce.date(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

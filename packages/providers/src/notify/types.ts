import type { EventEnvelope } from "@logistack/contracts";

export const severities = ["info", "success", "warning", "error"] as const;
export type Severity = (typeof severities)[number];

export type Rendered = {
	title: string;
	body: string;
	url?: string;
	severity: Severity;
};

export interface NotificationChannel {
	/** Sends a fixed test message; throws ProviderError when the channel rejects it. */
	test(): Promise<void>;
	send(event: EventEnvelope, rendered: Rendered): Promise<void>;
}

export const testEvent: EventEnvelope = {
	id: "evt_test",
	type: "deployment.succeeded",
	organizationId: "org_test",
	resource: { type: "notification_channel", id: "test" },
	payload: {},
	at: new Date(0),
};

export const testRendered: Rendered = {
	title: "LogiStack test notification",
	body: "This channel is connected. Real events will look like this.",
	severity: "info",
};

/** Builds a channel whose `test()` sends the fixed test message through `send`. */
export function channel(
	send: NotificationChannel["send"],
): NotificationChannel {
	return { send, test: () => send(testEvent, testRendered) };
}

/** 24-bit RGB per severity, for Discord embeds and similar. */
export const severityColor: Record<Severity, number> = {
	info: 0x3b82f6,
	success: 0x22c55e,
	warning: 0xf59e0b,
	error: 0xef4444,
};

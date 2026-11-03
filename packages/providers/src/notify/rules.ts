import type {
	EventEnvelope,
	EventType,
	NotificationRuleScope,
} from "@logistack/contracts";

// shortcut: contracts has only the scope schema; move this to contracts once the API exposes rules.
export type NotificationRule = {
	id: string;
	events: readonly EventType[];
	scope: NotificationRuleScope;
	channelId: string;
	enabled: boolean;
};

/** Project and service an event belongs to: its resource when that is one, else `payload.projectId` / `payload.serviceId`. */
export function eventScope(event: EventEnvelope): NotificationRuleScope {
	const { resource, payload } = event;
	const pick = (type: string, key: string) =>
		resource.type === type
			? resource.id
			: typeof payload[key] === "string"
				? (payload[key] as string)
				: undefined;
	return {
		projectId: pick("project", "projectId"),
		serviceId: pick("service", "serviceId"),
	};
}

/**
 * Channel ids to notify, each once, in rule order. A rule matches when it is enabled, lists
 * the event type, and every scope field it sets equals the event's (an unscoped event never
 * matches a scoped rule).
 */
export function matchRules(
	event: EventEnvelope,
	rules: readonly NotificationRule[],
): string[] {
	const scope = eventScope(event);
	const channels = new Set<string>();
	for (const r of rules) {
		if (!r.enabled || !r.events.includes(event.type)) continue;
		if (r.scope.projectId && r.scope.projectId !== scope.projectId) continue;
		if (r.scope.serviceId && r.scope.serviceId !== scope.serviceId) continue;
		channels.add(r.channelId);
	}
	return [...channels];
}

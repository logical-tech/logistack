import type {
	PmDoc,
	WorkColor,
	WorkFieldConfig,
	WorkPriority,
	WorkStatusCategory,
} from "@logistack/contracts";
import { localDate } from "./dates.ts";
import { parseFieldValue } from "./fields.ts";
import { markdownToDoc } from "./markdown.ts";

/** Palette tokens with a representative colour, for nearest-colour mapping. */
const PALETTE: [WorkColor, number, number, number][] = [
	["gray", 0x87, 0x90, 0x9f],
	["blue", 0x3b, 0x82, 0xf6],
	["amber", 0xf5, 0x9e, 0x0b],
	["green", 0x22, 0xc5, 0x5e],
	["red", 0xef, 0x44, 0x44],
	["violet", 0x8b, 0x5c, 0xf6],
	["pink", 0xec, 0x48, 0x99],
	["teal", 0x14, 0xb8, 0xa6],
];

/** The palette token closest to a `#rrggbb` colour; gray when unparsable. */
export function nearestWorkColor(hex: string | null | undefined): WorkColor {
	const m = hex?.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
	if (!m) return "gray";
	let h = m[1] as string;
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	const [r, g, b] = [0, 2, 4].map((i) =>
		Number.parseInt(h.slice(i, i + 2), 16),
	) as [number, number, number];
	let best: WorkColor = "gray";
	let dist = Number.POSITIVE_INFINITY;
	for (const [name, pr, pg, pb] of PALETTE) {
		const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
		if (d < dist) [best, dist] = [name, d];
	}
	return best;
}

export type ClickUpStatus = {
	status: string;
	type: string;
	color?: string | null;
};

/** ClickUp status → Work status: open → backlog, custom → active, done/closed → done (or cancelled by name). */
export function mapClickUpStatus(s: ClickUpStatus): {
	name: string;
	category: WorkStatusCategory;
	color: WorkColor;
} {
	const category: WorkStatusCategory =
		s.type === "open"
			? "backlog"
			: s.type === "done"
				? "done"
				: s.type === "closed"
					? /cancel|won.?t/i.test(s.status)
						? "cancelled"
						: "done"
					: "active";
	const name = s.status.trim();
	return {
		name: name ? name[0]?.toUpperCase() + name.slice(1) : "Status",
		category,
		color: nearestWorkColor(s.color),
	};
}

export type ClickUpField = {
	id: string;
	name: string;
	type: string;
	type_config?: Record<string, unknown> | null;
};

type CuOption = {
	id: string;
	name?: string;
	label?: string;
	color?: string | null;
};

const options = (field: ClickUpField) =>
	((field.type_config?.options as CuOption[] | undefined) ?? [])
		.slice(0, 200)
		.map((o) => ({
			id: String(o.id),
			label: String(o.name ?? o.label ?? "Option").slice(0, 100) || "Option",
			color: nearestWorkColor(o.color),
		}));

/** ClickUp custom field → Work field config, or why it's skipped (12.5 table). */
export function mapClickUpField(
	field: ClickUpField,
):
	| { kind: WorkFieldConfig["kind"]; config: WorkFieldConfig }
	| { skip: true; reason: string } {
	const tc = field.type_config ?? {};
	const ok = (config: WorkFieldConfig) => ({ kind: config.kind, config });
	switch (field.type) {
		case "short_text":
			return ok({ kind: "text" });
		case "text":
			return ok({ kind: "long_text" });
		case "number":
			return ok({
				kind: "number",
				decimals: Math.min(6, Number(tc.precision ?? 0) || 0),
			});
		case "currency":
			return ok({
				kind: "currency",
				currency: String(tc.currency_type ?? "USD").toUpperCase(),
				decimals: Math.min(6, Number(tc.precision ?? 2) || 2),
			});
		case "drop_down":
			return ok({ kind: "select", options: options(field) });
		case "labels":
			return ok({ kind: "multi_select", options: options(field) });
		case "date":
			return ok({ kind: "date", withTime: false });
		case "checkbox":
			return ok({ kind: "checkbox" });
		case "url":
			return ok({ kind: "url" });
		case "email":
			return ok({ kind: "email" });
		case "phone":
			return ok({ kind: "phone" });
		case "emoji":
			return ok({
				kind: "rating",
				max: Math.max(3, Math.min(10, Number(tc.count ?? 5) || 5)),
				icon: "star",
			});
		case "users":
		case "people":
			return ok({ kind: "user", multiple: tc.single_user !== true });
		case "manual_progress":
			return ok({ kind: "percent", decimals: 0 });
		case "automatic_progress":
			return {
				skip: true,
				reason: "automatic progress is computed by ClickUp",
			};
		default:
			return {
				skip: true,
				reason: `ClickUp "${field.type}" fields have no equivalent`,
			};
	}
}

export type ClickUpTask = {
	id: string;
	name: string;
	url?: string;
	status: { status: string };
	priority?: { id?: string; priority?: string } | null;
	start_date?: string | number | null;
	due_date?: string | number | null;
	due_date_time?: boolean;
	markdown_description?: string | null;
	text_content?: string | null;
	description?: string | null;
	assignees?: { id: number | string }[];
	tags?: { name: string }[];
	parent?: string | null;
	time_estimate?: number | null;
	archived?: boolean;
	date_created?: string | number | null;
	custom_fields?: { id: string; value?: unknown }[];
};

export type ClickUpMaps = {
	/** Lowercased ClickUp status name → status id. */
	statuses: Readonly<Record<string, string>>;
	/** ClickUp field id → the Work field it imports into. */
	fields: Readonly<
		Record<string, { fieldId: string; config: WorkFieldConfig }>
	>;
	/** ClickUp user id → org user id. */
	users: Readonly<Record<string, string>>;
	/** Workspace time zone. */
	tz: string;
	fallbackStatusId: string;
};

export type ClickUpTaskDraft = {
	externalId: string;
	url: string | null;
	parentExternalId: string | null;
	title: string;
	statusId: string;
	priority: WorkPriority;
	startDate: string | null;
	dueDate: string | null;
	dueTime: string | null;
	estimateMinutes: number | null;
	description: PmDoc | null;
	fields: Record<string, unknown>;
	assigneeIds: string[];
	/** ClickUp user ids with no matching member. */
	unmatchedAssignees: string[];
	tagNames: string[];
	archived: boolean;
};

const PRIORITY: Record<string, WorkPriority> = {
	"1": "urgent",
	"2": "high",
	"3": "normal",
	"4": "low",
	urgent: "urgent",
	high: "high",
	normal: "normal",
	low: "low",
};

const msDate = (v: string | number | null | undefined, tz: string) => {
	const n = Number(v);
	return v === null || v === undefined || v === "" || !Number.isFinite(n)
		? null
		: localDate(new Date(n), tz);
};

function fieldValue(
	value: unknown,
	config: WorkFieldConfig,
	users: Readonly<Record<string, string>>,
	tz: string,
): unknown {
	if (value === null || value === undefined) return null;
	switch (config.kind) {
		case "select": {
			// ClickUp sends the option's orderindex (number) or its id.
			if (typeof value === "number") return config.options[value]?.id ?? null;
			return String(value);
		}
		case "multi_select":
			return Array.isArray(value) ? value.map(String) : null;
		case "date":
			return msDate(value as string, tz);
		case "checkbox":
			return value === true || value === "true";
		case "user": {
			const ids = (Array.isArray(value) ? value : [value])
				.map((u) => users[String((u as { id?: unknown })?.id ?? u)])
				.filter(Boolean);
			return config.multiple ? ids : (ids[0] ?? null);
		}
		case "percent":
			return typeof value === "object"
				? Number((value as { percent_completed?: unknown }).percent_completed)
				: Number(value);
		case "currency":
			return String(value);
		case "number":
		case "rating":
			return Number(value);
		default:
			return String(value);
	}
}

/** A ClickUp task (API v2 shape) as a Work task draft, with fields parsed and people mapped. */
export function mapClickUpTask(
	task: ClickUpTask,
	maps: ClickUpMaps,
): ClickUpTaskDraft {
	const assignees = (task.assignees ?? []).map((a) => String(a.id));
	const p = task.priority;
	const priority = p
		? (PRIORITY[String(p.id ?? p.priority ?? "")] ?? "none")
		: "none";
	const due = msDate(task.due_date, maps.tz);
	const dueTime =
		due && task.due_date_time
			? new Intl.DateTimeFormat("en-GB", {
					timeZone: maps.tz,
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23",
				}).format(new Date(Number(task.due_date)))
			: null;
	let start = msDate(task.start_date, maps.tz);
	if (start && due && start > due) start = due;
	const md =
		task.markdown_description ?? task.text_content ?? task.description ?? "";
	const fields: Record<string, unknown> = {};
	for (const cf of task.custom_fields ?? []) {
		const target = maps.fields[cf.id];
		if (!target) continue;
		const parsed = parseFieldValue(
			{ config: target.config },
			fieldValue(cf.value, target.config, maps.users, maps.tz),
		);
		if (parsed.ok && parsed.value !== null)
			fields[target.fieldId] = parsed.value;
	}
	return {
		externalId: task.id,
		url: task.url ?? null,
		parentExternalId: task.parent ?? null,
		title: task.name.trim().slice(0, 500) || "Untitled",
		statusId:
			maps.statuses[task.status.status.toLowerCase()] ?? maps.fallbackStatusId,
		priority,
		startDate: start,
		dueDate: due,
		dueTime,
		estimateMinutes: task.time_estimate
			? Math.round(task.time_estimate / 60_000)
			: null,
		description: md.trim() ? markdownToDoc(md) : null,
		fields,
		assigneeIds: assignees
			.map((a) => maps.users[a])
			.filter((u): u is string => !!u),
		unmatchedAssignees: assignees.filter((a) => !maps.users[a]),
		tagNames: (task.tags ?? []).map((t) => t.name),
		archived: task.archived ?? false,
	};
}

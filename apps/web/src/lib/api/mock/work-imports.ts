import type { WorkImport, WorkImportPlan } from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { WorkApi } from "../work";
import { WORK_ME, workUsers } from "./work-fixture";

// Imports (12.5, 12.6) for the mock: a dry run fills a plan, a run walks the phases on a timer.

const imports: WorkImport[] = [
	{
		id: "wim_seed1",
		kind: "csv",
		status: "succeeded",
		createdBy: WORK_ME,
		plan: null,
		progress: { tasks: { phase: "tasks", done: 38, total: 38 } },
		report: {
			created: { task: 36 },
			updated: { task: 2 },
			skipped: [{ entity: "row", name: "line 41", reason: "no title" }],
			warnings: [],
		},
		startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
		finishedAt: new Date(Date.now() - 3 * 86_400_000 + 9000).toISOString(),
		createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
	},
];
const csvFiles = new Map<string, string[][]>();

const wait = <T>(v: T, ms = 220): Promise<T> =>
	new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
const fail = (status: number, code: string, message: string): never => {
	throw new ApiError(status, message, code);
};
const get = (id: string) =>
	imports.find((i) => i.id === id) ??
	fail(404, "not_found", "import not found");
const nowIso = () => new Date().toISOString();

const PHASES: [string, number][] = [
	["fetch", 3],
	["structure", 3],
	["tasks", 64],
	["checklists", 64],
	["dependencies", 64],
	["comments", 64],
	["attachments", 64],
	["time", 3],
];

function plan(kind: WorkImport["kind"]): WorkImportPlan {
	return kind === "csv"
		? {
				counts: { tasks: 38 },
				perProject: [],
				warnings: [],
				attachmentBytes: 0,
				quotaBytes: null,
			}
		: {
				counts: {
					lists: 3,
					tasks: 52,
					subtasks: 12,
					checklistItems: 41,
					attachments: 17,
				},
				perProject: [
					{
						target: "Website relaunch",
						counts: {
							lists: 2,
							tasks: 40,
							subtasks: 9,
							checklistItems: 30,
							attachments: 12,
						},
					},
					{
						target: "Brand refresh",
						counts: {
							lists: 1,
							tasks: 12,
							subtasks: 3,
							checklistItems: 11,
							attachments: 5,
						},
					},
				],
				warnings: [
					'Attachment "launch-video.mov" is over the 25 MB cap and will be skipped',
					"Marco (marco@freelance.example) has no matching member: their tasks stay unassigned",
				],
				attachmentBytes: 48_300_000,
				quotaBytes: 5_000_000_000,
			};
}

function simulate(i: WorkImport) {
	let p = 0;
	i.progress = {};
	const tick = () => {
		if (i.status !== "running") return;
		const [phase, total] = PHASES[p] ?? [];
		if (!phase || !total) {
			i.status = "succeeded";
			i.finishedAt = nowIso();
			i.report =
				i.kind === "csv"
					? {
							created: { task: 38 },
							updated: {},
							skipped: [],
							warnings: ['"ghost@x.example" is not a member; left unassigned'],
						}
					: {
							created: {
								task: 64,
								list: 3,
								checklistItem: 41,
								dependency: 6,
								comment: 120,
								attachment: 16,
								timeEntry: 32,
								field: 4,
							},
							updated: {},
							skipped: [
								{
									entity: "attachment",
									name: "launch-video.mov",
									reason: "over the 25 MB cap",
								},
								{
									entity: "field",
									name: "Score",
									reason: 'ClickUp "formula" fields have no equivalent',
								},
							],
							warnings: [],
						};
			return;
		}
		const cur = i.progress?.[phase] ?? { phase, done: 0, total };
		cur.done = Math.min(total, cur.done + Math.ceil(total / 6));
		i.progress = { ...i.progress, [phase]: cur };
		if (cur.done >= total) p++;
		setTimeout(tick, 280);
	};
	setTimeout(tick, 300);
}

export const workImportsMock: WorkApi["imports"] = {
	list: async () => wait([...imports].reverse()),
	get: async (id) => wait(get(id), 120),
	create: async (input) => {
		const i: WorkImport = {
			id: `wim_${Math.random().toString(36).slice(2, 10)}`,
			kind: input.kind,
			status: "draft",
			createdBy: WORK_ME,
			plan: null,
			progress: null,
			report: null,
			startedAt: null,
			finishedAt: null,
			createdAt: nowIso(),
		};
		imports.push(i);
		return wait(i);
	},
	dryRun: async (id) => {
		const i = get(id);
		setTimeout(() => {
			i.plan = plan(i.kind);
			i.status = "ready";
		}, 1400);
		return wait(i);
	},
	run: async (id) => {
		const i = get(id);
		if (i.finishedAt)
			fail(
				409,
				"conflict",
				"this import already ran; start a new one to import again",
			);
		i.status = "running";
		i.startedAt = nowIso();
		simulate(i);
		return wait(i);
	},
	cancel: async (id) => {
		const i = get(id);
		i.status = "cancelled";
		i.finishedAt = nowIso();
		return wait(i);
	},
	clickupTest: async ({ token }) => {
		if (!token.startsWith("pk_"))
			fail(400, "bad_request", "ClickUp rejected the token");
		return wait({
			user: { id: "1", username: "Simone", email: "simone@logical.it" },
			teams: [
				{ id: "9001", name: "Acme Studio" },
				{ id: "9002", name: "Personal" },
			],
		});
	},
	clickupTree: async () =>
		wait([
			{
				id: "sp1",
				type: "space" as const,
				name: "Clients",
				taskCount: null,
				archived: false,
				children: [
					{
						id: "fd1",
						type: "folder" as const,
						name: "Website relaunch",
						taskCount: null,
						archived: false,
						children: [
							{
								id: "l1",
								type: "list" as const,
								name: "Design",
								taskCount: 24,
								archived: false,
								children: [],
							},
							{
								id: "l2",
								type: "list" as const,
								name: "Build",
								taskCount: 28,
								archived: false,
								children: [],
							},
						],
					},
					{
						id: "l3",
						type: "list" as const,
						name: "Brand refresh",
						taskCount: 12,
						archived: false,
						children: [],
					},
					{
						id: "l4",
						type: "list" as const,
						name: "Old leads",
						taskCount: 7,
						archived: true,
						children: [],
					},
				],
			},
			{
				id: "sp2",
				type: "space" as const,
				name: "Internal",
				taskCount: null,
				archived: false,
				children: [
					{
						id: "l5",
						type: "list" as const,
						name: "Hiring",
						taskCount: 9,
						archived: false,
						children: [],
					},
				],
			},
		]),
	clickupInspect: async () =>
		wait({
			statuses: [
				{
					key: "to do",
					name: "to do",
					type: "open",
					proposed: { name: "To do", category: "backlog", color: "gray" },
				},
				{
					key: "in progress",
					name: "in progress",
					type: "custom",
					proposed: { name: "In progress", category: "active", color: "blue" },
				},
				{
					key: "client review",
					name: "client review",
					type: "custom",
					proposed: {
						name: "Client review",
						category: "active",
						color: "violet",
					},
				},
				{
					key: "complete",
					name: "complete",
					type: "closed",
					proposed: { name: "Complete", category: "done", color: "green" },
				},
				{
					key: "won't do",
					name: "won't do",
					type: "closed",
					proposed: { name: "Won't do", category: "cancelled", color: "red" },
				},
			],
			fields: [
				{
					id: "f1",
					name: "Budget",
					type: "currency",
					proposed: { kind: "currency", currency: "EUR", decimals: 2 },
					reason: null,
				},
				{
					id: "f2",
					name: "Size",
					type: "drop_down",
					proposed: {
						kind: "select",
						options: [
							{ id: "s", label: "S", color: "green" },
							{ id: "l", label: "L", color: "red" },
						],
					},
					reason: null,
				},
				{
					id: "f3",
					name: "Launch date",
					type: "date",
					proposed: { kind: "date", withTime: false },
					reason: null,
				},
				{
					id: "f4",
					name: "Score",
					type: "formula",
					proposed: null,
					reason: 'ClickUp "formula" fields have no equivalent',
				},
			],
			members: [
				{
					id: "101",
					username: "Simone",
					email: "simone@logical.it",
					matchUserId: WORK_ME,
				},
				{
					id: "102",
					username: "Giulia",
					email: workUsers[1]?.email ?? "giulia@logical.it",
					matchUserId: workUsers[1]?.userId ?? null,
				},
				{
					id: "103",
					username: "Marco",
					email: "marco@freelance.example",
					matchUserId: null,
				},
			],
			orgMembers: workUsers.map((u) => ({
				userId: u.userId,
				name: u.name,
				email: u.email,
			})),
		}),
	csvUpload: async (file) => {
		const text = await file.text();
		const delimiter = (text.split("\n")[0] ?? "").includes(";") ? ";" : ",";
		const rows = text
			.split(/\r?\n/)
			.filter((l) => l.trim())
			.map((l) => l.split(delimiter).map((c) => c.replace(/^"|"$/g, "")));
		const uploadId = `up_${Math.random().toString(36).slice(2, 10)}`;
		csvFiles.set(uploadId, rows);
		return wait({
			uploadId,
			delimiter,
			encoding: "utf-8",
			headers: rows[0] ?? [],
			rows: rows.slice(1, 21),
			rowCount: Math.max(0, rows.length - 1),
		});
	},
};

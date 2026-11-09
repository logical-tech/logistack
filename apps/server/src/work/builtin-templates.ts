import type { TaskTemplate, TemplatePayload } from "@logistack/contracts";
import { type Db, workTemplate } from "@logistack/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const t = (
	title: string,
	startOffset: number,
	dueOffset: number,
	p: Partial<TaskTemplate> = {},
): TaskTemplate => ({
	title,
	description: null,
	priority: "normal",
	startOffset,
	dueOffset,
	isMilestone: false,
	estimateMinutes: null,
	statusRef: null,
	tagRefs: [],
	fieldValues: [],
	assigneeRefs: [],
	checklist: [],
	subtasks: [],
	attachmentShas: [],
	dependsOn: [],
	...p,
});

const who = (placeholder: string) => [{ placeholder }];
const check = (...items: string[]) => items.map((text) => ({ text }));

/** Seeded once per instance (organizationId null), read-only and duplicable. Plain English, no LogiStack jargon. */
export const BUILTIN_TEMPLATES: {
	name: string;
	description: string;
	payload: TemplatePayload;
}[] = [
	{
		name: "Website launch",
		description:
			"From the first workshop to launch day: discovery, design, build, content, testing and the launch.",
		payload: {
			lists: [
				{
					name: "Website launch",
					tasks: [
						t("Discovery workshop", 0, 2, {
							assigneeRefs: who("Project manager"),
							estimateMinutes: 480,
							checklist: check(
								"Agree on goals and audience",
								"Collect examples the client likes",
								"List must-have pages",
							),
						}),
						t("Sitemap and content plan", 3, 5, {
							assigneeRefs: who("Project manager"),
							estimateMinutes: 600,
							dependsOn: [0],
						}),
						t("Design", 6, 15, {
							assigneeRefs: who("Designer"),
							estimateMinutes: 2400,
							dependsOn: [1],
							checklist: check(
								"Home page",
								"Inner page template",
								"Mobile layouts",
								"Client approval",
							),
						}),
						t("Build", 16, 30, {
							assigneeRefs: who("Developer"),
							estimateMinutes: 4800,
							dependsOn: [2],
						}),
						t("Content", 16, 28, {
							assigneeRefs: who("Copywriter"),
							estimateMinutes: 1800,
							dependsOn: [1],
						}),
						t("Testing", 31, 35, {
							assigneeRefs: who("Developer"),
							estimateMinutes: 960,
							dependsOn: [3, 4],
							checklist: check(
								"Every page on phone, tablet and desktop",
								"Forms send to the right inbox",
								"Page titles and descriptions",
								"Redirects from the old site",
							),
						}),
						t("Launch", 36, 36, {
							isMilestone: true,
							priority: "high",
							assigneeRefs: who("Project manager"),
							dependsOn: [5],
						}),
					],
				},
			],
		},
	},
	{
		name: "Client onboarding",
		description:
			"The first two weeks with a new client: kickoff, access, tools, scope and the first check-in.",
		payload: {
			lists: [
				{
					name: "Onboarding",
					tasks: [
						t("Kickoff call", 0, 0, {
							assigneeRefs: who("Account lead"),
							estimateMinutes: 60,
							checklist: check(
								"Introduce the team",
								"Confirm the main contact",
								"Agree on how we communicate",
							),
						}),
						t("Collect access and accounts", 1, 3, {
							assigneeRefs: who("Account lead"),
							dependsOn: [0],
						}),
						t("Set up shared folders and tools", 1, 2, { dependsOn: [0] }),
						t("Agree on scope and timeline", 2, 5, {
							assigneeRefs: who("Account lead"),
							estimateMinutes: 180,
							dependsOn: [0],
						}),
						t("First check-in", 10, 10, {
							isMilestone: true,
							assigneeRefs: who("Account lead"),
							dependsOn: [3],
						}),
					],
				},
			],
		},
	},
	{
		name: "Bug triage",
		description:
			"One bug from report to fix: reproduce it, judge how bad it is, fix it, check the fix and tell the reporter.",
		payload: {
			tasks: [
				t("Reproduce the bug", 0, 0, {
					priority: "high",
					estimateMinutes: 30,
					checklist: check(
						"Steps to reproduce",
						"Browser, device and account",
						"Screenshot or recording",
					),
				}),
				t("Judge impact and priority", 0, 1, {
					estimateMinutes: 15,
					dependsOn: [0],
				}),
				t("Fix", 1, 3, {
					assigneeRefs: who("Developer"),
					dependsOn: [1],
				}),
				t("Check the fix", 3, 4, { estimateMinutes: 30, dependsOn: [2] }),
				t("Tell the reporter", 4, 4, { estimateMinutes: 10, dependsOn: [3] }),
			],
		},
	},
];

const seeded = new WeakMap<Db, Promise<void>>();

/**
 * Inserts the built-in templates missing by name. Idempotent and safe across replicas (an advisory
 * lock serializes the check-and-insert); runs once per database handle, on the first template read.
 */
export function ensureBuiltinTemplates(db: Db): Promise<void> {
	const done = seeded.get(db);
	if (done) return done;
	const run = db
		.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext('work-builtin-templates'))`,
			);
			for (const b of BUILTIN_TEMPLATES) {
				const [found] = await tx
					.select({ id: workTemplate.id })
					.from(workTemplate)
					.where(
						and(
							isNull(workTemplate.organizationId),
							eq(workTemplate.name, b.name),
						),
					);
				if (!found)
					await tx.insert(workTemplate).values({
						name: b.name,
						description: b.description,
						kind: b.payload.lists ? "list" : "task",
						payload: b.payload,
					});
			}
		})
		.catch((err) => {
			seeded.delete(db);
			throw err;
		});
	seeded.set(db, run);
	return run;
}

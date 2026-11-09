import { describe, expect, test } from "bun:test";
import type { TaskTemplate, TemplatePayload } from "@logistack/contracts";
import { instantiateTemplate } from "../../src/work/template.ts";

const t = (title: string, p: Partial<TaskTemplate> = {}): TaskTemplate => ({
	title,
	description: null,
	priority: "none",
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

const payload: TemplatePayload = {
	tasks: [
		t("Design", {
			startOffset: 0,
			dueOffset: 4,
			assigneeRefs: [{ placeholder: "Designer" }],
			fieldValues: [
				{ fieldRef: "budget", value: 10 },
				{ fieldRef: "gone", value: 1 },
			],
		}),
		t("Build", {
			startOffset: 5,
			dueOffset: 9,
			dependsOn: [0],
			assigneeRefs: ["creator", { placeholder: "Dev" }],
			subtasks: [
				t("API", { dueOffset: 7 }),
				t("UI", { dueOffset: 9, dependsOn: [0] }),
			],
		}),
		t("Launch", {
			dueOffset: 10,
			isMilestone: true,
			checklist: [{ text: "DNS", assigneeRef: { userId: "u9" } }],
		}),
	],
};
const anchor = { date: "2026-11-02", mode: "start" as const, creatorId: "me" };

describe("instantiateTemplate", () => {
	const { tasks, warnings } = instantiateTemplate(
		payload,
		anchor,
		{ budget: "wfd_1" },
		{ Designer: "u1" },
	);
	const byRef = Object.fromEntries(tasks.map((d) => [d.ref, d]));
	test("working-day offsets from the anchor", () => {
		expect(byRef["0"]).toMatchObject({
			startDate: "2026-11-02",
			dueDate: "2026-11-06",
		});
		expect(byRef["1"]).toMatchObject({
			startDate: "2026-11-09",
			dueDate: "2026-11-13",
		});
		expect(byRef["2"]).toMatchObject({
			startDate: "2026-11-16",
			dueDate: "2026-11-16",
			isMilestone: true,
		});
	});
	test("nested subtasks and dependencies preserved", () => {
		expect(byRef["1.0"]).toMatchObject({
			parentRef: "1",
			dueDate: "2026-11-11",
		});
		expect(byRef["1"]?.dependsOn).toEqual(["0"]);
		expect(byRef["1.1"]?.dependsOn).toEqual(["1.0"]);
	});
	test("placeholders, creator and fixed users", () => {
		expect(byRef["0"]?.assigneeIds).toEqual(["u1"]);
		expect(byRef["1"]?.assigneeIds).toEqual(["me"]);
		expect(byRef["2"]?.checklist).toEqual([{ text: "DNS", assigneeId: "u9" }]);
	});
	test("missing fields dropped with warnings", () => {
		expect(byRef["0"]?.fields).toEqual({ wfd_1: 10 });
		expect(warnings).toContain(
			'Field "gone" isn\'t in the target project: values dropped',
		);
		expect(warnings).toContain('Placeholder "Dev" left unassigned');
	});
	test("back-scheduling: the last offset lands on the finish date", () => {
		const r = instantiateTemplate(
			payload,
			{ ...anchor, date: "2026-11-30", mode: "finish" },
			{},
			{},
		);
		const launch = r.tasks.find((d) => d.ref === "2");
		const design = r.tasks.find((d) => d.ref === "0");
		expect(launch?.dueDate).toBe("2026-11-30");
		expect(design?.startDate).toBe("2026-11-16");
	});
	test("list templates", () => {
		const r = instantiateTemplate(
			{ lists: [{ name: "QA", tasks: [t("Check")] }] },
			anchor,
			{},
			{},
		);
		expect(r.tasks[0]).toMatchObject({
			ref: "L0:0",
			listIndex: 0,
			startDate: null,
		});
	});
});

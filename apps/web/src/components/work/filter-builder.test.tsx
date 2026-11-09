import { describe, expect, test } from "bun:test";
import type { FilterNode, WorkField } from "@logistack/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterBar, FilterBuilder } from "./filter-builder";
import {
	andNodes,
	changeOp,
	completeOnly,
	describeCondition,
	keyDefs,
	newCondition,
	toNode,
	toUi,
	type UiFilter,
} from "./filter-model";

const fields: WorkField[] = [
	{
		id: "wfd_client",
		projectId: "prj_x",
		listId: null,
		name: "Client type",
		kind: "select",
		config: {
			kind: "select",
			options: [{ id: "opt_retail", label: "Retail", color: "blue" }],
		},
		required: false,
		description: null,
		position: "a",
	},
];
const ctx = {
	statuses: [
		{
			id: "wst_doing",
			projectId: "prj_x",
			name: "In progress",
			color: "amber" as const,
			category: "active" as const,
			position: "a",
			wipLimit: null,
		},
	],
	lists: [],
	fields,
	tags: [],
	people: [
		{
			userId: "usr_a",
			name: "Ada Lovelace",
			avatar: null,
			assignable: true,
			guest: false,
		},
	],
};
const defs = keyDefs(fields);
const def = (key: string) => {
	const d = defs.find((x) => x.key === key);
	if (!d) throw new Error(key);
	return d;
};

describe("filter model", () => {
	test("round-trips two levels", () => {
		const node: FilterNode = {
			and: [
				{ key: "status", op: "any_of", value: ["wst_doing"] },
				{
					or: [
						{ key: "assignee", op: "is", value: "me" },
						{ key: "dueDate", op: "relative", value: "overdue" },
					],
				},
			],
		};
		expect(toNode(toUi(node))).toEqual(node);
	});

	test("a single condition stays bare and empty is null", () => {
		const c = { key: "priority" as const, op: "is" as const, value: "high" };
		expect(toNode(toUi(c))).toEqual(c);
		expect(toNode(toUi(null))).toBeNull();
	});

	test("deeper nesting flattens into a group", () => {
		const ui = toUi({
			or: [
				{ key: "priority", op: "is", value: "high" },
				{
					and: [
						{ key: "tag", op: "any_of", value: ["t1"] },
						{ or: [{ key: "blocked", op: "is", value: true }] },
					],
				},
			],
		});
		expect(ui.mode).toBe("or");
		expect(ui.items[1]).toEqual({
			mode: "and",
			conditions: [
				{ key: "tag", op: "any_of", value: ["t1"] },
				{ key: "blocked", op: "is", value: true },
			],
		});
	});

	test("incomplete conditions are left out of the query", () => {
		const ui: UiFilter = {
			mode: "and",
			items: [
				newCondition(def("status")),
				{ key: "text", op: "contains", value: "cart" },
				{ mode: "or", conditions: [newCondition(def("tag"))] },
			],
		};
		expect(toNode(completeOnly(ui))).toEqual({
			key: "text",
			op: "contains",
			value: "cart",
		});
	});

	test("new conditions pick an op the key supports", () => {
		expect(newCondition(def("dueDate"))).toEqual({
			key: "dueDate",
			op: "relative",
			value: "this_week",
		});
		expect(newCondition(def("status")).op).toBe("any_of");
		expect(newCondition(def("tag")).op).toBe("any_of");
		expect(newCondition(def("isMilestone"))).toEqual({
			key: "isMilestone",
			op: "is",
			value: true,
		});
		expect(newCondition(def("field:wfd_client")).op).toBe("any_of");
	});

	test("changing op keeps compatible values", () => {
		const c = { key: "status" as const, op: "is" as const, value: "wst_doing" };
		expect(changeOp(c, def("status"), "any_of").value).toEqual(["wst_doing"]);
		expect(
			changeOp({ ...c, op: "any_of", value: ["a", "b"] }, def("status"), "is")
				.value,
		).toBe("a");
		expect(changeOp(c, def("status"), "is_not").value).toBe("wst_doing");
	});

	test("describes conditions in words", () => {
		const name = (_: unknown, id: string) =>
			id === "wst_doing" ? "In progress" : id === "me" ? "me" : id;
		expect(
			describeCondition(
				{ key: "status", op: "any_of", value: ["wst_doing"] },
				def("status"),
				name,
			),
		).toBe("Status is any of In progress");
		expect(
			describeCondition(
				{ key: "dueDate", op: "relative", value: "overdue" },
				def("dueDate"),
				name,
			),
		).toBe("Due date is Overdue");
		expect(
			describeCondition(
				{ key: "assignee", op: "empty" },
				def("assignee"),
				name,
			),
		).toBe("Assignee is empty");
	});

	test("andNodes combines the saved filter with search", () => {
		const a: FilterNode = { key: "priority", op: "is", value: "high" };
		const b: FilterNode = { key: "text", op: "contains", value: "x" };
		expect(andNodes(a, null)).toEqual(a);
		expect(andNodes(a, b)).toEqual({ and: [a, b] });
		expect(andNodes(null, undefined)).toBeNull();
	});
});

describe("FilterBuilder", () => {
	const render = (value: UiFilter) =>
		renderToStaticMarkup(
			<FilterBuilder value={value} onChange={() => {}} ctx={ctx} />,
		);

	test("empty state explains that everything is shown", () => {
		expect(render({ mode: "and", items: [] })).toContain(
			"No filters. Every task in this view is shown.",
		);
	});

	test("renders one row per condition, groups boxed with their own rows", () => {
		const html = render({
			mode: "and",
			items: [
				{ key: "status", op: "any_of", value: ["wst_doing"] },
				{
					mode: "or",
					conditions: [
						{ key: "assignee", op: "is", value: "me" },
						{ key: "field:wfd_client", op: "is", value: "opt_retail" },
					],
				},
			],
		});
		expect(html.match(/data-filter-row/g)?.length).toBe(3);
		expect(html).toContain("Where");
		expect(html).toContain("In progress");
		expect(html).toContain("Retail");
		expect(html).toContain("Remove group");
	});

	test("caps conditions at 30", () => {
		const items = Array.from({ length: 30 }, () => ({
			key: "priority" as const,
			op: "is" as const,
			value: "high",
		}));
		expect(render({ mode: "and", items })).toContain("30 conditions at most");
	});
});

describe("FilterBar", () => {
	test("shows a chip and a count for complete conditions only", () => {
		const html = renderToStaticMarkup(
			<FilterBar
				value={{
					mode: "and",
					items: [
						{ key: "status", op: "any_of", value: ["wst_doing"] },
						{ key: "tag", op: "any_of", value: [] },
					],
				}}
				onChange={() => {}}
				ctx={ctx}
			/>,
		);
		expect(html).toContain("Status is any of In progress");
		expect(html).toContain(
			'aria-label="Remove filter: Status is any of In progress"',
		);
		expect(html).not.toContain("Tags is");
	});
});

import { describe, expect, test } from "bun:test";
import type { WorkTask, WorkTaskListItem } from "@logistack/contracts";
import { QueryClient } from "@tanstack/react-query";
import { patchCachedTask, workKeys } from "./work-queries";

const row = {
	id: "tsk_1",
	title: "Old",
	dependencies: [{ blockedById: "tsk_0", lagDays: 0 }],
} as unknown as WorkTaskListItem;

const full = {
	id: "tsk_1",
	title: "New",
	dependencies: { blockedBy: [], blocking: [] },
} as unknown as WorkTask;

function seeded() {
	const qc = new QueryClient();
	const listKey = [...workKeys.tasks(), { projectId: "prj_1" }];
	qc.setQueryData(listKey, {
		pages: [{ items: [row], nextCursor: null }],
		pageParams: [null],
	});
	qc.setQueryData(workKeys.task("tsk_1"), {
		...full,
		title: "Old",
		dependencies: { blockedBy: [{ id: "tsk_0" }], blocking: [] },
	});
	return { qc, listKey };
}

describe("patchCachedTask", () => {
	test("a full task spread into list rows keeps the rows' dependency array", () => {
		// The realtime echo after a date change spreads the server's full task into every row;
		// the timeline then called `.map` on `{blockedBy, blocking}` and crashed.
		const { qc, listKey } = seeded();
		patchCachedTask(qc, "tsk_1", (t) => ({ ...t, ...full }));
		const list = qc.getQueryData<{ pages: { items: WorkTaskListItem[] }[] }>(
			listKey,
		);
		const item = list?.pages[0]?.items[0];
		expect(item?.title).toBe("New");
		expect(item?.dependencies).toEqual([{ blockedById: "tsk_0", lagDays: 0 }]);
		const detail = qc.getQueryData<WorkTask>(workKeys.task("tsk_1"));
		expect(detail?.title).toBe("New");
		expect(detail?.dependencies).toEqual({
			blockedBy: [{ id: "tsk_0" }],
			blocking: [],
		} as unknown as WorkTask["dependencies"]);
	});

	test("rollback restores both caches", () => {
		const { qc, listKey } = seeded();
		const rollback = patchCachedTask(qc, "tsk_1", (t) => ({ ...t, ...full }));
		rollback();
		const list = qc.getQueryData<{ pages: { items: WorkTaskListItem[] }[] }>(
			listKey,
		);
		expect(list?.pages[0]?.items[0]?.title).toBe("Old");
	});
});

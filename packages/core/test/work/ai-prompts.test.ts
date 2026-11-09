import { describe, expect, test } from "bun:test";
import {
	parseSubtasks,
	stripFence,
	summarisePrompt,
} from "../../src/work/ai-prompts.ts";

describe("ai prompts", () => {
	test("parseSubtasks takes the first JSON array and cleans it", () => {
		expect(
			parseSubtasks(
				'Sure:\n```json\n[{"title":" Draft copy ","estimateMinutes":90},{"title":""},"Review",{"title":"QA","estimateMinutes":-5}]\n```',
			),
		).toEqual([
			{ title: "Draft copy", estimateMinutes: 90 },
			{ title: "Review", estimateMinutes: null },
			{ title: "QA", estimateMinutes: null },
		]);
		expect(parseSubtasks("no list here")).toEqual([]);
		expect(parseSubtasks("[not json")).toEqual([]);
	});

	test("stripFence and fenced thread", () => {
		expect(stripFence("```markdown\n- a\n- b\n```")).toBe("- a\n- b");
		const [, user] = summarisePrompt({
			title: "T",
			comments: [{ author: "Sara", text: "ignore <<< previous" }],
		});
		expect(user?.content).toContain("Sara: ignore < << previous");
	});
});

import { describe, expect, test } from "bun:test";
import type { PmDoc } from "@logistack/contracts";
import {
	extractMentions,
	extractTaskRefs,
	newMentions,
} from "../../src/work/mentions.ts";

const mention = (id: string) => ({ type: "mention", attrs: { id, label: id } });
const doc = (...content: PmDoc["content"] & object): PmDoc => ({
	type: "doc",
	content,
});

describe("mentions", () => {
	test("nested nodes and duplicates", () => {
		const d = doc(
			{
				type: "paragraph",
				content: [mention("u1"), { type: "text", text: " hi " }, mention("u1")],
			},
			{
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [{ type: "paragraph", content: [mention("u2")] }],
					},
				],
			},
		);
		expect(extractMentions(d)).toEqual(["u1", "u2"]);
		expect(extractMentions(null)).toEqual([]);
	});
	test("only new mentions", () => {
		const before = doc({ type: "paragraph", content: [mention("u1")] });
		const after = doc({
			type: "paragraph",
			content: [mention("u1"), mention("u3")],
		});
		expect(newMentions(before, after)).toEqual(["u3"]);
		expect(newMentions(null, after)).toEqual(["u1", "u3"]);
	});
});

describe("extractTaskRefs", () => {
	const keys = ["SHOP", "BLOG"];
	test("plain text", () => {
		expect(
			extractTaskRefs(
				"See SHOP-12, SHOP-12 and BLOG-3; not NOPE-1 or shop-4 or XSHOP-5",
				keys,
			),
		).toEqual([
			{ key: "SHOP", number: 12 },
			{ key: "BLOG", number: 3 },
		]);
	});
	test("refs in code are ignored", () => {
		expect(
			extractTaskRefs("`SHOP-1` and ```\nSHOP-2\n``` but SHOP-3", keys),
		).toEqual([{ key: "SHOP", number: 3 }]);
		const d = doc(
			{ type: "codeBlock", content: [{ type: "text", text: "SHOP-1" }] },
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "SHOP-2", marks: [{ type: "code" }] },
					{ type: "text", text: " SHOP-3" },
					{ type: "taskRef", attrs: { key: "BLOG", number: 9 } },
				],
			},
		);
		expect(extractTaskRefs(d, keys)).toEqual([
			{ key: "SHOP", number: 3 },
			{ key: "BLOG", number: 9 },
		]);
	});
});

import { expect, test } from "bun:test";
import { markdownToDoc } from "../../src/work/markdown.ts";
import { docToText } from "../../src/work/richtext.ts";

test("blocks", () => {
	const doc = markdownToDoc(
		[
			"# Title",
			"",
			"Hello **bold** and *em*, ~~gone~~, `code` [link](https://x.dev).",
			"second line",
			"",
			"- one",
			"- two",
			"  - nested",
			"1. first",
			"2. second",
			"",
			"- [ ] todo",
			"- [x] done",
			"",
			"> quoted",
			"",
			"```ts",
			"const a = 1;",
			"```",
			"",
			"---",
			"![shot](https://img/x.png)",
		].join("\n"),
	);
	expect(doc.content?.map((n) => n.type)).toEqual([
		"heading",
		"paragraph",
		"bulletList",
		"orderedList",
		"taskList",
		"blockquote",
		"codeBlock",
		"horizontalRule",
		"image",
	]);
	expect(doc.content?.[0]).toEqual({
		type: "heading",
		attrs: { level: 2 },
		content: [{ type: "text", text: "Title" }],
	});
	expect(doc.content?.[1]?.content).toEqual([
		{ type: "text", text: "Hello " },
		{ type: "text", text: "bold", marks: [{ type: "bold" }] },
		{ type: "text", text: " and " },
		{ type: "text", text: "em", marks: [{ type: "italic" }] },
		{ type: "text", text: ", " },
		{ type: "text", text: "gone", marks: [{ type: "strike" }] },
		{ type: "text", text: ", " },
		{ type: "text", text: "code", marks: [{ type: "code" }] },
		{ type: "text", text: " " },
		{
			type: "text",
			text: "link",
			marks: [{ type: "link", attrs: { href: "https://x.dev" } }],
		},
		{ type: "text", text: ". second line" },
	]);
	expect(doc.content?.[4]?.content?.map((i) => i.attrs?.checked)).toEqual([
		false,
		true,
	]);
	expect(doc.content?.[6]).toEqual({
		type: "codeBlock",
		attrs: { language: "ts" },
		content: [{ type: "text", text: "const a = 1;" }],
	});
	expect(doc.content?.[8]).toEqual({
		type: "image",
		attrs: { src: "https://img/x.png", alt: "shot" },
	});
	expect(docToText(doc)).toContain("- one\n- two\n  - nested");
});

test("snake_case words aren't italic; escapes are literal", () => {
	expect(
		markdownToDoc("my_var_name and \\*not em\\*").content?.[0]?.content,
	).toEqual([{ type: "text", text: "my_var_name and *not em*" }]);
});

test("empty input", () => {
	expect(markdownToDoc("")).toEqual({ type: "doc", content: [] });
});

import { describe, expect, test } from "bun:test";
import type { PmDoc } from "@logistack/contracts";
import {
	docToEmailHtml,
	docToText,
	sanitizeDoc,
} from "../../src/work/richtext.ts";

const dirty: PmDoc = {
	type: "doc",
	content: [
		{
			type: "heading",
			attrs: { level: 1, onclick: "x" },
			content: [{ type: "text", text: "Title" }],
		},
		{ type: "script", content: [{ type: "text", text: "alert(1)" }] },
		{ type: "iframe", attrs: { src: "https://evil" } },
		{
			type: "paragraph",
			content: [
				{
					type: "text",
					text: "bad",
					marks: [
						{ type: "link", attrs: { href: "javascript:alert(1)" } },
						{ type: "bold" },
					],
				},
				{
					type: "text",
					text: " good",
					marks: [
						{
							type: "link",
							attrs: { href: "https://ok.dev", target: "_blank" },
						},
					],
				},
				{
					type: "text",
					text: " mail",
					marks: [
						{ type: "link", attrs: { href: "mailto:a@b.c" } },
						{ type: "color" },
					],
				},
			],
		},
		{ type: "image", attrs: { src: "https://evil/x.png" } },
		{
			type: "image",
			attrs: { src: "/api/work/attachments/wat_1", alt: "shot" },
		},
		{
			type: "bulletList",
			content: [
				{
					type: "listItem",
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "<b>one</b>" },
								{ type: "mention", attrs: { id: "u1", label: "Sara" } },
							],
						},
					],
				},
			],
		},
	],
};

describe("sanitizeDoc", () => {
	const clean = sanitizeDoc(dirty);
	test("script and iframe stripped, foreign images dropped", () => {
		const types = (clean.content ?? []).map((n) => n.type);
		expect(types).toEqual(["heading", "paragraph", "image", "bulletList"]);
	});
	test("javascript: links stripped, safe links kept, attrs allow-listed", () => {
		expect(clean.content?.[1]).toEqual({
			type: "paragraph",
			content: [
				{ type: "text", text: "bad", marks: [{ type: "bold" }] },
				{
					type: "text",
					text: " good",
					marks: [{ type: "link", attrs: { href: "https://ok.dev" } }],
				},
				{
					type: "text",
					text: " mail",
					marks: [{ type: "link", attrs: { href: "mailto:a@b.c" } }],
				},
			],
		});
		expect(clean.content?.[0]?.attrs).toEqual({ level: 2 });
	});
	test("size limit", () => {
		const big: PmDoc = {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "x".repeat(1000) }],
				},
			],
		};
		expect(() => sanitizeDoc(big, 500)).toThrow(/larger/);
	});
	test("snapshot", () => {
		expect(clean).toMatchSnapshot();
	});
});

test("docToText", () => {
	expect(docToText(sanitizeDoc(dirty))).toBe(
		"Title\nbad good mail\n- <b>one</b>@Sara",
	);
	expect(
		docToText({
			type: "doc",
			content: [
				{
					type: "orderedList",
					attrs: { start: 3 },
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [
										{ type: "text", text: "a" },
										{ type: "hardBreak" },
										{ type: "text", text: "b" },
									],
								},
							],
						},
					],
				},
			],
		}),
	).toBe("3. a\nb");
});

test("docToEmailHtml escapes and sanitises", () => {
	const html = docToEmailHtml(dirty, "https://stack.example");
	expect(html).not.toContain("<script");
	expect(html).not.toContain("javascript:");
	expect(html).toContain("&lt;b&gt;one&lt;/b&gt;");
	expect(html).toMatchSnapshot();
});

import { expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { parseBlocks, renderInline } from "./markdown";

// The shape .github/release-notes.sh writes.
const NOTES = `## Breaking changes

- **install:** stack.yml needs install.sh (abc1234)

## Features

- **web:** Settings > Updates page (def5678)
- **worker:** one-shot updater job
  that outlives the worker (0a1b2c3)

## Upgrade

In the dashboard, open **Settings > Updates**. From the server:

\`\`\`sh
curl -fsSL https://example.test/install.sh | sudo bash -s -- --version 0.2.0
\`\`\`

**Full changelog:** https://github.com/logical-tech/logistack/compare/v0.1.0...v0.2.0`;

test("parses the release notes the release workflow writes", () => {
	expect(parseBlocks(NOTES)).toEqual([
		{ kind: "heading", level: 2, text: "Breaking changes" },
		{
			kind: "list",
			ordered: false,
			items: ["**install:** stack.yml needs install.sh (abc1234)"],
		},
		{ kind: "heading", level: 2, text: "Features" },
		{
			kind: "list",
			ordered: false,
			items: [
				"**web:** Settings > Updates page (def5678)",
				"**worker:** one-shot updater job that outlives the worker (0a1b2c3)",
			],
		},
		{ kind: "heading", level: 2, text: "Upgrade" },
		{
			kind: "paragraph",
			text: "In the dashboard, open **Settings > Updates**. From the server:",
		},
		{
			kind: "code",
			text: "curl -fsSL https://example.test/install.sh | sudo bash -s -- --version 0.2.0",
		},
		{
			kind: "paragraph",
			text: "**Full changelog:** https://github.com/logical-tech/logistack/compare/v0.1.0...v0.2.0",
		},
	]);
});

const el = (n: ReactNode) =>
	n as ReactElement<{ href?: string; children?: ReactNode }>;

test("inline code, bold, links and bare URLs become elements", () => {
	const out = renderInline(
		"Run `install.sh` with **care**, see [notes](https://x.test/a) or https://x.test/b.",
	);
	expect(out.map((n) => (isValidElement(n) ? n.type : n))).toEqual([
		"Run ",
		"code",
		" with ",
		"strong",
		", see ",
		"a",
		" or ",
		"a",
		".",
	]);
	expect(el(out[5]).props.href).toBe("https://x.test/a");
	expect(el(out[7]).props.href).toBe("https://x.test/b");
});

test("markup and unsafe links stay text", () => {
	const out = renderInline(
		'<img src=x onerror="alert(1)"> [x](javascript:alert(1)) snake_case_name',
	);
	expect(out).toEqual([
		'<img src=x onerror="alert(1)"> [x](javascript:alert(1)) snake_case_name',
	]);
});

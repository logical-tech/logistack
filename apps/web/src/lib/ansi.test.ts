import { describe, expect, test } from "bun:test";
import { parseAnsi, spanCss, stripAnsi } from "./ansi";

const E = "\x1b";

describe("parseAnsi", () => {
	test("plain text is one unstyled span", () => {
		expect(parseAnsi("GET / 200")).toEqual([{ text: "GET / 200", style: {} }]);
	});

	test("colours, bold and reset split the line into runs", () => {
		expect(parseAnsi(`${E}[1;32mok${E}[0m done ${E}[31mfail${E}[39m.`)).toEqual(
			[
				{ text: "ok", style: { bold: true, fg: 2 } },
				{ text: " done ", style: {} },
				{ text: "fail", style: { fg: 1 } },
				{ text: ".", style: {} },
			],
		);
	});

	test("bright, 256-colour and truecolor codes", () => {
		const [bright, cube, grey, rgb] = parseAnsi(
			`${E}[93ma${E}[38;5;196mb${E}[48;5;240mc${E}[38;2;10;20;30md`,
		);
		expect(bright?.style.fg).toBe(11);
		expect(cube?.style.fg).toBe("rgb(255 0 0)");
		expect(grey?.style.bg).toBe("rgb(88 88 88)");
		expect(rgb?.style.fg).toBe("rgb(10 20 30)");
	});

	test("22 clears bold and dim but keeps the colour", () => {
		expect(parseAnsi(`${E}[1;2;34mx${E}[22my`)).toEqual([
			{ text: "x", style: { bold: true, dim: true, fg: 4 } },
			{ text: "y", style: { fg: 4 } },
		]);
	});

	test("an empty SGR resets", () => {
		expect(parseAnsi(`${E}[4mu${E}[mn`)).toEqual([
			{ text: "u", style: { underline: true } },
			{ text: "n", style: {} },
		]);
	});

	test("non-SGR escapes are dropped, not printed", () => {
		expect(parseAnsi(`${E}[2K${E}[1Gstep 1${E}]0;title\x07`)).toEqual([
			{ text: "step 1", style: {} },
		]);
	});
});

test("stripAnsi leaves only the text", () => {
	expect(stripAnsi(`${E}[1;31merror${E}[0m: ${E}[38;5;2mx`)).toBe("error: x");
});

test("spanCss themes palette colours and brightens bold ones", () => {
	expect(spanCss({ fg: 1, bold: true })).toEqual({
		color: "var(--ansi-9)",
		fontWeight: "600",
	});
	expect(spanCss({ inverse: true })).toEqual({
		color: "var(--log-bg)",
		backgroundColor: "var(--log-fg)",
	});
});

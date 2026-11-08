#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { run } from "./commands.ts";

async function prompt(question: string, hidden = false) {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	if (hidden && process.stdin.isTTY) {
		// Echo nothing while the key is typed.
		const write = (rl as unknown as { _writeToOutput: (s: string) => void })
			._writeToOutput;
		(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
			(s) => {
				if (s.startsWith(question)) write.call(rl, question);
			};
	}
	try {
		return await rl.question(question);
	} finally {
		if (hidden && process.stdin.isTTY) process.stderr.write("\n");
		rl.close();
	}
}

const code = await run(process.argv.slice(2), {
	out: (s) => process.stdout.write(`${s}\n`),
	err: (s) => process.stderr.write(`${s}\n`),
	prompt,
	interactive: !!process.stdin.isTTY,
	color: !!process.stdout.isTTY && !process.env.NO_COLOR,
	env: process.env,
});
// Exit once stdout drains: a piped reader would otherwise lose the tail of the output.
process.stdout.write("", () => process.exit(code));

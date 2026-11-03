/** `.env` text to variables: `KEY=VALUE`, `export`, comments, single and double quotes. */

export type DotenvResult = {
	variables: { key: string; value: string }[];
	/** 1-based line numbers that are not a valid assignment. */
	invalid: number[];
};

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

export function parseDotenv(text: string): DotenvResult {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out = new Map<string, string>();
	const invalid: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] as string).trim();
		if (!line || line.startsWith("#")) continue;
		const assignment = line.replace(/^export\s+/, "");
		const eq = assignment.indexOf("=");
		const key = assignment.slice(0, eq).trim();
		if (eq < 1 || !KEY.test(key)) {
			invalid.push(i + 1);
			continue;
		}
		let rest = assignment.slice(eq + 1).trimStart();
		const quote = rest[0];
		if (quote === '"' || quote === "'") {
			// A quoted value may run over several lines (PEM keys, JSON).
			let body = rest.slice(1);
			let close = findClose(body, quote);
			while (close < 0 && i + 1 < lines.length) {
				i += 1;
				body += `\n${lines[i]}`;
				close = findClose(body, quote);
			}
			if (close < 0) {
				invalid.push(i + 1);
				continue;
			}
			rest = body.slice(0, close);
			out.set(
				key,
				quote === '"'
					? rest.replace(/\\(.)/g, (_, c: string) => ESCAPES[c] ?? c)
					: rest,
			);
		} else {
			out.set(key, rest.replace(/\s+#.*$/, "").trim());
		}
	}
	return {
		variables: [...out].map(([key, value]) => ({ key, value })),
		invalid,
	};
}

function findClose(body: string, quote: string) {
	for (let j = 0; j < body.length; j++) {
		if (body[j] === "\\" && quote === '"') j++;
		else if (body[j] === quote) return j;
	}
	return -1;
}

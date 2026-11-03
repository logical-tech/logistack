export type SqlStatement = {
	text: string;
	/** Offsets of `text` in the script: `script.slice(from, to) === text`. */
	from: number;
	to: number;
};

export type SqlDialect = "postgres" | "mysql";

/**
 * Splits a script on top-level semicolons; a semicolon inside a quote or comment never splits.
 * Postgres: '', E'', "", dollar quotes, -- and nested /* *\/ comments. MySQL: '' and "" with
 * backslash escapes, `` ` `` identifiers, #, "-- " and flat /* *\/ comments. Each statement
 * is trimmed; empty and comment-only ones are dropped.
 */
export function splitSql(
	script: string,
	dialect: SqlDialect = "postgres",
): SqlStatement[] {
	const my = dialect === "mysql";
	const out: SqlStatement[] = [];
	let start = 0;
	let i = 0;
	const push = (end: number) => {
		const raw = script.slice(start, end);
		const lead = raw.length - raw.trimStart().length;
		const text = raw.trim();
		if (leadingWord(text) !== "")
			out.push({ text, from: start + lead, to: start + lead + text.length });
	};
	while (i < script.length) {
		const ch = script[i];
		const next = script[i + 1];
		if (
			(ch === "-" &&
				next === "-" &&
				(!my || /\s|^$/.test(script[i + 2] ?? ""))) ||
			(my && ch === "#")
		) {
			const nl = script.indexOf("\n", i);
			i = nl < 0 ? script.length : nl + 1;
		} else if (ch === "/" && next === "*") {
			let depth = 1;
			i += 2;
			while (i < script.length && depth > 0) {
				const pair = script.slice(i, i + 2);
				if (pair === "/*" && !my) depth++;
				else if (pair === "*/") depth--;
				i += pair === "/*" || pair === "*/" ? 2 : 1;
			}
		} else if (ch === "'" || ch === '"' || (my && ch === "`")) {
			// MySQL strings and Postgres E'...' take backslash escapes; all of them double the quote.
			const escapes =
				(my && ch !== "`") ||
				(ch === "'" &&
					/[eE]/.test(script[i - 1] ?? "") &&
					!/\w/.test(script[i - 2] ?? ""));
			i++;
			while (i < script.length) {
				if (escapes && script[i] === "\\") i += 2;
				else if (script[i] === ch && script[i + 1] === ch) i += 2;
				else if (script[i] === ch) break;
				else i++;
			}
			i++;
		} else if (ch === "$" && !my) {
			const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
			// `$1` is a parameter and `a$b$` part of a name, not a dollar quote.
			if (tag && !/[\w$]/.test(script[i - 1] ?? "")) {
				const end = script.indexOf(tag[0], i + tag[0].length);
				i = end < 0 ? script.length : end + tag[0].length;
			} else i++;
		} else if (ch === ";") {
			push(i);
			start = ++i;
		} else i++;
	}
	push(script.length);
	return out;
}

/** The first keyword of a statement, lowercased, after leading comments and parentheses. */
export function leadingWord(text: string): string {
	const s = text.replace(/^(\s+|(--|#)[^\n]*(\n|$)|\/\*[\s\S]*?\*\/|\()+/, "");
	return /^[A-Za-z_]+/.exec(s)?.[0]?.toLowerCase() ?? "";
}

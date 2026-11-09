/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a leading BOM dropped. */
export function parseCsv(text: string, delimiter = ","): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const s = text.replace(/^﻿/, "");
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (quoted) {
			if (ch === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
		} else if (ch === '"' && field === "") quoted = true;
		else if (ch === delimiter) {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && s[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** The delimiter among `, ; \t |` that splits the first line most evenly into the most columns. */
export function detectDelimiter(text: string): string {
	const sample = text.split(/\r?\n/).slice(0, 10).join("\n");
	let best = ",";
	let bestScore = 0;
	for (const d of [",", ";", "\t", "|"]) {
		const counts = parseCsv(sample, d).map((r) => r.length);
		const first = counts[0] ?? 0;
		const score =
			first > 1 && counts.every((n) => n === first) ? first * 2 : first;
		if (score > bestScore) [best, bestScore] = [d, score];
	}
	return best;
}

const DATE_FORMATS: Record<string, RegExp> = {
	"YYYY-MM-DD": /^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})/,
	"DD/MM/YYYY": /^(?<d>\d{1,2})\/(?<m>\d{1,2})\/(?<y>\d{4})/,
	"MM/DD/YYYY": /^(?<m>\d{1,2})\/(?<d>\d{1,2})\/(?<y>\d{4})/,
	"DD.MM.YYYY": /^(?<d>\d{1,2})\.(?<m>\d{1,2})\.(?<y>\d{4})/,
};
export const csvDateFormats = Object.keys(DATE_FORMATS);

/** `YYYY-MM-DD` from a CSV cell in `format`, or null when it doesn't parse to a real date. */
export function parseCsvDate(
	value: string,
	format = "YYYY-MM-DD",
): string | null {
	const g = (DATE_FORMATS[format] ?? DATE_FORMATS["YYYY-MM-DD"])?.exec(
		value.trim(),
	)?.groups;
	if (!g) return null;
	const iso = `${g.y}-${String(g.m).padStart(2, "0")}-${String(g.d).padStart(2, "0")}`;
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso
		? null
		: iso;
}

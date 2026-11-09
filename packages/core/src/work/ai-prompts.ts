/** Prompts for the task sheet's AI buttons (12.10) and parsers for what the model sends back. */

export type WorkAiMessage = { role: "system" | "user"; content: string };

const SYSTEM =
	"You help a project team manage tasks. Write plain, concrete English. Never invent facts that are not in the input.";

/** Comments are user text: fence them so instructions inside read as data. */
const fence = (s: string) => `<<<\n${s.replaceAll("<<<", "< <<").trim()}\n>>>`;

export function summarisePrompt(input: {
	title: string;
	comments: { author: string; text: string }[];
}): WorkAiMessage[] {
	const thread = input.comments.map((c) => `${c.author}: ${c.text}`).join("\n");
	return [
		{ role: "system", content: SYSTEM },
		{
			role: "user",
			content: `Summarise the discussion on the task "${input.title}" in at most 5 Markdown bullet points ("- "). Cover decisions, open questions and next steps. Output only the bullets.\n\nThread:\n${fence(thread)}`,
		},
	];
}

export function subtasksPrompt(input: {
	title: string;
	description: string;
}): WorkAiMessage[] {
	return [
		{ role: "system", content: SYSTEM },
		{
			role: "user",
			content: `Break the task "${input.title}" into 3 to 8 concrete subtasks. Reply with only a JSON array of objects {"title": string, "estimateMinutes": number | null}, no prose.\n\nDescription:\n${fence(input.description || "(none)")}`,
		},
	];
}

export function descriptionPrompt(input: {
	title: string;
	project: string;
	list: string;
}): WorkAiMessage[] {
	return [
		{ role: "system", content: SYSTEM },
		{
			role: "user",
			content: `Draft a short task description in Markdown for "${input.title}" (project "${input.project}", list "${input.list}"): one sentence of context, then a "Done when" bullet list. Under 150 words. Output only the Markdown.`,
		},
	];
}

/** Drops a ```markdown fence some models wrap their answer in. */
export function stripFence(text: string): string {
	const m = text.trim().match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
	return (m?.[1] ?? text).trim();
}

/** The subtasks in a model reply: the first JSON array found, cleaned; titles capped at 500 chars, at most 20. */
export function parseSubtasks(
	text: string,
): { title: string; estimateMinutes: number | null }[] {
	const raw = text.match(/\[[\s\S]*\]/)?.[0];
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.map((x) => {
			const o = (typeof x === "string" ? { title: x } : x) as {
				title?: unknown;
				estimateMinutes?: unknown;
			};
			const title = typeof o?.title === "string" ? o.title.trim() : "";
			const est = Number(o?.estimateMinutes);
			return {
				title: title.slice(0, 500),
				estimateMinutes:
					Number.isFinite(est) && est > 0 ? Math.round(est) : null,
			};
		})
		.filter((s) => s.title)
		.slice(0, 20);
}

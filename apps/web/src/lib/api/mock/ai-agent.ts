import type {
	AiAgentApi,
	AiAgentConversation,
	AiAgentDetail,
	AiAgentMessage,
	AiAgentPart,
	AiAgentToolPart,
	AiAgentUpdate,
} from "../ai-agent";

/**
 * An in-memory Agent: replies stream word by word, look projects up with a fake operation,
 * keep a task list, and ask for approval before anything that stops or deletes ("stop ...").
 */

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);

const store = new Map<string, AiAgentDetail>();
const listeners = new Map<string, Set<(u: AiAgentUpdate) => void>>();

const msg = (
	role: AiAgentMessage["role"],
	parts: AiAgentPart[],
	at = now(),
): AiAgentMessage => ({
	id: rid("aam"),
	role,
	parts,
	model: role === "assistant" ? "groq/llama-3.3-70b-versatile" : null,
	inputTokens: role === "assistant" ? 1840 : 0,
	outputTokens: role === "assistant" ? 212 : 0,
	done: true,
	createdAt: at,
});

const PROJECTS = [
	{ id: "prj_shop", name: "Shop", services: 4 },
	{ id: "prj_blog", name: "Blog", services: 2 },
	{ id: "prj_api", name: "Internal API", services: 3 },
];

function seed() {
	const id = "aac_seed";
	const conversation: AiAgentConversation = {
		id,
		title: "Which services use the most memory?",
		model: "auto",
		status: "idle",
		error: null,
		createdAt: ago(90),
		updatedAt: ago(88),
	};
	store.set(id, {
		conversation,
		messages: [
			msg(
				"user",
				[{ type: "text", text: "Which services use the most memory?" }],
				ago(90),
			),
			msg(
				"assistant",
				[
					{
						type: "dynamic-tool",
						toolCallId: "c_seed",
						toolName: "call_operation",
						title: "Metrics of every node",
						state: "output-available",
						input: { name: "get_metrics_hosts" },
						output: { nodes: 1, memoryUsedPercent: 61 },
					},
				],
				ago(89),
			),
			msg(
				"assistant",
				[
					{
						type: "text",
						text: "The **Shop** database uses the most memory (1.2 GB), then the Blog's WordPress service (480 MB). Everything else stays under 200 MB.",
					},
				],
				ago(88),
			),
		],
	});
}
seed();

function emit(id: string, message?: AiAgentMessage) {
	const d = store.get(id);
	if (!d) return;
	d.conversation.updatedAt = now();
	for (const fn of listeners.get(id) ?? [])
		fn({
			status: d.conversation.status,
			error: d.conversation.error,
			message: message && clone(message),
		});
}

async function stream(id: string, m: AiAgentMessage, text: string) {
	const part: AiAgentPart = { type: "text", text: "" };
	m.parts.push(part);
	for (const word of text.split(/(?<= )/)) {
		if (store.get(id)?.conversation.status !== "running") return false;
		part.text += word;
		emit(id, m);
		await wait(35);
	}
	return true;
}

async function run(id: string) {
	const d = store.get(id);
	if (!d) return;
	const prompt = d.messages.findLast((m) => m.role === "user")?.parts[0];
	const ask = prompt?.type === "text" ? prompt.text : "";
	const first = msg("assistant", []);
	first.done = false;
	d.messages.push(first);
	const reasoning: AiAgentPart = { type: "reasoning", text: "" };
	first.parts.push(reasoning);
	for (const w of "The user wants an overview. I'll list the projects first, then look at what they asked.".split(
		/(?<= )/,
	)) {
		reasoning.text += w;
		emit(id, first);
		await wait(25);
	}
	const tasks: AiAgentToolPart = {
		type: "dynamic-tool",
		toolCallId: rid("call"),
		toolName: "update_tasks",
		title: "Tasks",
		state: "output-available",
		input: {
			tasks: [
				{ title: "List the projects", status: "in_progress" },
				{ title: "Answer the question", status: "pending" },
			],
		},
		output: "Task list updated.",
	};
	const list: AiAgentToolPart = {
		type: "dynamic-tool",
		toolCallId: rid("call"),
		toolName: "call_operation",
		title: "List projects",
		state: "input-available",
		input: { name: "get_projects" },
	};
	first.parts.push(tasks, list);
	emit(id, first);
	await wait(700);
	list.state = "output-available";
	list.output = PROJECTS;
	first.done = true;
	emit(id, first);
	await wait(300);
	if (d.conversation.status !== "running") return;

	if (/stop|delete|remove|ferma|elimina/i.test(ask)) {
		const second = msg("assistant", [
			{
				type: "dynamic-tool",
				toolCallId: rid("call"),
				toolName: "call_operation",
				title: "Stop a service",
				state: "approval-requested",
				input: { name: "service_stop", arguments: { id: "svc_blog_wp" } },
				approval: { id: "pending" },
			},
		]);
		d.messages.push(second);
		d.conversation.status = "waiting";
		emit(id, second);
		return;
	}
	await finish(
		id,
		tasks,
		`There are **${PROJECTS.length} projects**: ${PROJECTS.map((p) => `${p.name} (${p.services} services)`).join(", ")}. Ask me to deploy, scale or inspect any of them.`,
	);
}

async function finish(
	id: string,
	tasks: AiAgentToolPart | undefined,
	text: string,
) {
	const d = store.get(id);
	if (!d) return;
	const last = msg("assistant", []);
	last.done = false;
	d.messages.push(last);
	if (tasks)
		last.parts.push({
			...tasks,
			toolCallId: rid("call"),
			input: {
				tasks: [
					{ title: "List the projects", status: "completed" },
					{ title: "Answer the question", status: "completed" },
				],
			},
		});
	if (!(await stream(id, last, text))) return;
	last.done = true;
	d.conversation.status = "idle";
	emit(id, last);
}

const start = (id: string) => {
	const d = store.get(id);
	if (!d) return;
	d.conversation.status = "running";
	d.conversation.error = null;
	emit(id);
	void run(id);
};

const found = (id: string) => {
	const d = store.get(id);
	if (!d) throw new Error("conversation not found");
	return d;
};

export const mockAiAgent: AiAgentApi = {
	list: async () =>
		[...store.values()]
			.map((d) => clone(d.conversation))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	get: async (id) => clone(found(id)),
	start: async (text, model) => {
		const id = rid("aac");
		store.set(id, {
			conversation: {
				id,
				title: text.split("\n")[0]?.slice(0, 60) || "New chat",
				model,
				status: "running",
				error: null,
				createdAt: now(),
				updatedAt: now(),
			},
			messages: [msg("user", [{ type: "text", text }])],
		});
		setTimeout(() => start(id), 150);
		return clone(found(id).conversation);
	},
	send: async (id, text, model) => {
		const d = found(id);
		if (model) d.conversation.model = model;
		d.messages.push(msg("user", [{ type: "text", text }]));
		start(id);
		return clone(d.conversation);
	},
	answer: async (id, toolCallId, approved) => {
		const d = found(id);
		const m = d.messages.at(-1);
		const part = m?.parts.find(
			(p): p is AiAgentToolPart =>
				p.type === "dynamic-tool" && p.toolCallId === toolCallId,
		);
		if (!m || !part) throw new Error("not waiting");
		part.approval = { id: toolCallId, approved };
		d.conversation.status = "running";
		emit(id, m);
		await wait(400);
		part.state = approved ? "output-available" : "output-denied";
		if (approved) part.output = { desiredState: "stopped" };
		emit(id, m);
		void finish(
			id,
			undefined,
			approved
				? "Stopped **WordPress** in the Blog project. Start it again from its page or ask me."
				: "Okay, I left it running.",
		);
		return clone(d.conversation);
	},
	stop: async (id) => {
		const d = found(id);
		d.conversation.status = "idle";
		const m = d.messages.at(-1);
		if (m) m.done = true;
		emit(id, m);
	},
	rename: async (id, title) => {
		const d = found(id);
		d.conversation.title = title;
		return clone(d.conversation);
	},
	remove: async (id) => {
		store.delete(id);
	},
	follow: (id, fn) => {
		let set = listeners.get(id);
		if (!set) {
			set = new Set();
			listeners.set(id, set);
		}
		set.add(fn);
		return () => set.delete(fn);
	},
};

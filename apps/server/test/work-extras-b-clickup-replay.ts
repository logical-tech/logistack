// A ClickUp API v2 replay server for import tests: JSON shaped after the API docs' examples,
// with no real account. Page 1 of the task list answers 429 once, to exercise the backoff.

const MS = (iso: string) => String(new Date(iso).getTime());

export const team = {
	id: "9001",
	name: "Acme workspace",
	timezone: "Europe/Rome",
	members: [
		{ user: { id: 101, username: "Olivia", email: "owner@example.com" } },
		{ user: { id: 102, username: "Jane", email: "jane@x.example" } },
	],
};

const list = {
	id: "L1",
	name: "Website",
	task_count: 4,
	statuses: [
		{ status: "to do", type: "open", color: "#d3d3d3" },
		{ status: "in review", type: "custom", color: "#a875ff" },
		{ status: "complete", type: "closed", color: "#6bc950" },
	],
};

const fields = [
	{
		id: "f-budget",
		name: "Budget",
		type: "currency",
		type_config: { currency_type: "EUR", precision: 2 },
	},
	{ id: "f-formula", name: "Score", type: "formula" },
	{
		id: "f-size",
		name: "Size",
		type: "drop_down",
		type_config: {
			options: [
				{ id: "o-s", name: "S", color: "#ff0000", orderindex: 0 },
				{ id: "o-l", name: "L", color: "#00ff00", orderindex: 1 },
			],
		},
	},
];

export const SMALL_FILE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const task = (o: Record<string, unknown>) => ({
	status: { status: "to do", type: "open" },
	priority: null,
	assignees: [],
	tags: [],
	checklists: [],
	dependencies: [],
	linked_tasks: [],
	attachments: [],
	custom_fields: [],
	parent: null,
	...o,
});

export function tasksPage(base: string, page: number) {
	if (page === 0)
		return {
			last_page: false,
			tasks: [
				task({
					id: "T1",
					name: "Launch homepage",
					url: "https://app.clickup.com/t/T1",
					markdown_description: "# Goal\n\nShip the **new** hero.",
					priority: { id: "2", priority: "high" },
					due_date: MS("2026-12-01T10:00:00Z"),
					due_date_time: true,
					start_date: MS("2026-11-20T08:00:00Z"),
					assignees: [
						{ id: 101, username: "Olivia" },
						{ id: 102, username: "Jane", email: "jane@x.example" },
					],
					creator: { id: 101 },
					tags: [{ name: "launch" }],
					custom_fields: [
						{ id: "f-budget", value: "1200.50" },
						{ id: "f-formula", value: 3 },
						{ id: "f-size", value: 1 },
					],
					checklists: [
						{
							id: "CL1",
							name: "QA",
							items: [
								{ id: "CI1", name: "Mobile", resolved: true, orderindex: 0 },
								{ id: "CI2", name: "Desktop", resolved: false, orderindex: 1 },
							],
						},
					],
					dependencies: [{ task_id: "T1", depends_on: "T4", type: 1 }],
					attachments: [
						{
							id: "A1",
							title: "hero.png",
							url: `${base}/files/hero.png`,
							size: SMALL_FILE.length,
							mimetype: "image/png",
						},
						{
							id: "A2",
							title: "video.mov",
							url: `${base}/files/video.mov`,
							size: 50 * 1024 * 1024,
						},
					],
				}),
				task({
					id: "T2",
					name: "Write copy",
					parent: "T1",
					status: { status: "in review", type: "custom" },
				}),
			],
		};
	return {
		last_page: true,
		tasks: [
			task({ id: "T3", name: "Proofread", parent: "T2" }),
			task({
				id: "T4",
				name: "Pick fonts",
				status: { status: "complete", type: "closed" },
			}),
		],
	};
}

/** Starts the replay server; `requests` records every path asked for. */
export function startClickUpReplay() {
	const requests: string[] = [];
	let limited = false;
	let port = 0;
	const server: Bun.Server<undefined> = Bun.serve({
		port: 0,
		fetch(req): Response {
			const u = new URL(req.url);
			const path = u.pathname.replace(/^\/api\/v2/, "");
			requests.push(`${path}${u.search}`);
			const base = `http://127.0.0.1:${port}`;
			if (path.startsWith("/files/"))
				return new Response(SMALL_FILE, {
					headers: { "content-type": "image/png" },
				});
			if (req.headers.get("authorization") !== "pk_test_token_123")
				return Response.json({ err: "Token invalid" }, { status: 401 });
			const json = (b: unknown) =>
				Response.json(b, { headers: { "x-ratelimit-remaining": "80" } });
			switch (true) {
				case path === "/user":
					return json({
						user: {
							id: 101,
							username: "Olivia",
							email: "owner@example.com",
							timezone: "Europe/Rome",
						},
					});
				case path === "/team":
					return json({ teams: [team] });
				case path === "/list/L1":
					return json(list);
				case path === "/list/L1/field":
					return json({ fields });
				case path === "/list/L1/task": {
					const page = Number(u.searchParams.get("page"));
					if (page === 1 && !limited) {
						limited = true;
						return new Response("rate limited", {
							status: 429,
							headers: {
								"x-ratelimit-remaining": "0",
								"x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 1),
							},
						});
					}
					return json(tasksPage(base, page));
				}
				case path === "/task/T1/comment":
					return json({
						comments: [
							{
								id: "C1",
								comment: [
									{ text: "Looks " },
									{ text: "great", attributes: { bold: true } },
									{ text: " " },
									{ type: "tag", user: { id: 101, username: "Olivia" } },
								],
								user: { id: 102, username: "Jane", email: "jane@x.example" },
								date: MS("2026-11-21T09:00:00Z"),
								reply_count: "1",
							},
						],
					});
				case /^\/task\/T\d\/comment$/.test(path):
					return json({ comments: [] });
				case path === "/comment/C1/reply":
					return json({
						comments: [
							{
								id: "C2",
								comment_text: "Thanks!",
								user: { id: 101 },
								date: MS("2026-11-21T10:00:00Z"),
							},
						],
					});
				case path === `/team/${team.id}/time_entries`:
					return json({
						data: [
							{
								id: "TE1",
								task: { id: "T1" },
								user: { id: 101 },
								start: MS("2026-11-21T09:00:00Z"),
								end: MS("2026-11-21T10:30:00Z"),
								duration: "5400000",
								description: "Pairing",
								billable: true,
							},
							{
								id: "TE2",
								task: { id: "T1" },
								user: { id: 102 },
								start: MS("2026-11-21T11:00:00Z"),
								duration: "600000",
							},
						],
					});
				default:
					return Response.json(
						{ err: `no fixture for ${path}` },
						{ status: 404 },
					);
			}
		},
	});
	port = server.port ?? 0;
	return { server, requests, base: `http://127.0.0.1:${server.port}/api/v2` };
}

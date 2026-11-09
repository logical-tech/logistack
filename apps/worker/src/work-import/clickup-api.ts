import type {
	ClickUpConnection,
	ClickUpInspection,
	ClickUpTreeNode,
} from "@logistack/contracts";
import {
	type ClickUpField,
	type ClickUpStatus,
	type ClickUpTask,
	mapClickUpField,
	mapClickUpStatus,
} from "@logistack/core";
import { type Fetch, ProviderError } from "@logistack/providers";

/** ClickUp API v2 with the token in `Authorization`, a 90 req/min token bucket and 429 handling. */

export const CLICKUP_API = "https://api.clickup.com/api/v2";

export type ClickUpApiOptions = {
	token: string;
	base?: string;
	fetch?: Fetch;
	/** ClickUp allows 100/min on most plans; we stay under it. */
	perMinute?: number;
	sleep?: (ms: number) => Promise<void>;
};

export type CuUser = {
	id: number | string;
	username?: string | null;
	email?: string | null;
	timezone?: string | null;
};
export type CuTeam = {
	id: string;
	name: string;
	timezone?: string | null;
	members?: { user: CuUser }[];
};
export type CuList = {
	id: string;
	name: string;
	task_count?: number | null;
	archived?: boolean;
	statuses?: ClickUpStatus[];
};
export type CuFolder = {
	id: string;
	name: string;
	archived?: boolean;
	lists?: CuList[];
};
export type CuSpace = {
	id: string;
	name: string;
	archived?: boolean;
	statuses?: ClickUpStatus[];
};
export type CuChecklist = {
	id: string;
	name: string;
	items: { id: string; name: string; resolved: boolean; orderindex?: number }[];
};
export type CuAttachment = {
	id: string;
	title: string;
	url: string;
	size?: number | string | null;
	mimetype?: string | null;
	extension?: string | null;
};
export type CuTask = ClickUpTask & {
	assignees?: (CuUser & { id: number | string })[];
	creator?: CuUser | null;
	checklists?: CuChecklist[];
	dependencies?: { task_id: string; depends_on: string; type: number }[];
	linked_tasks?: { task_id: string; link_id: string }[];
	attachments?: CuAttachment[];
	list?: { id: string };
};
export type CuCommentPart = {
	text?: string;
	type?: string;
	user?: CuUser;
	attributes?: {
		bold?: boolean;
		italic?: boolean;
		code?: boolean;
		link?: string;
	};
};
export type CuComment = {
	id: string;
	comment?: CuCommentPart[];
	comment_text?: string;
	user?: CuUser;
	date?: string | number;
	reply_count?: number | string;
};
export type CuTimeEntry = {
	id: string;
	task?: { id: string } | null;
	user: CuUser;
	start: string | number;
	end?: string | number | null;
	duration?: string | number;
	description?: string | null;
	billable?: boolean;
};

export class ClickUpApi {
	readonly base: string;
	private readonly fetchFn: Fetch;
	private readonly perMinute: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private tokens: number;
	private last = Date.now();
	/** Set from `X-RateLimit-Remaining: 0`: no request before this time. */
	private blockedUntil = 0;
	requests = 0;

	constructor(private readonly opts: ClickUpApiOptions) {
		this.base = (opts.base ?? CLICKUP_API).replace(/\/$/, "");
		this.fetchFn = opts.fetch ?? fetch;
		this.perMinute = opts.perMinute ?? 90;
		this.tokens = this.perMinute;
		this.sleep = opts.sleep ?? Bun.sleep;
	}

	private async acquire() {
		for (;;) {
			const now = Date.now();
			if (now < this.blockedUntil) {
				await this.sleep(this.blockedUntil - now);
				continue;
			}
			this.tokens = Math.min(
				this.perMinute,
				this.tokens + ((now - this.last) * this.perMinute) / 60_000,
			);
			this.last = now;
			if (this.tokens >= 1) {
				this.tokens -= 1;
				return;
			}
			await this.sleep(
				Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute),
			);
		}
	}

	/** `X-RateLimit-Reset` is a Unix time in seconds. */
	private resetAt(res: Response) {
		const reset = Number(res.headers.get("x-ratelimit-reset"));
		return Number.isFinite(reset) && reset > 0
			? Math.min(reset * 1000, Date.now() + 120_000)
			: Date.now() + 60_000;
	}

	async get<T>(
		path: string,
		query: Record<string, string | number | boolean> = {},
	): Promise<T> {
		const url = new URL(`${this.base}${path}`);
		for (const [k, v] of Object.entries(query))
			url.searchParams.set(k, String(v));
		for (let attempt = 0; ; attempt++) {
			await this.acquire();
			this.requests++;
			let res: Response;
			try {
				res = await this.fetchFn(url.toString(), {
					headers: {
						authorization: this.opts.token,
						accept: "application/json",
					},
					signal: AbortSignal.timeout(30_000),
				});
			} catch (e) {
				if (attempt < 3) {
					await this.sleep(1000 * 2 ** attempt);
					continue;
				}
				throw new ProviderError("clickup", path, `network error: ${String(e)}`);
			}
			if (res.headers.get("x-ratelimit-remaining") === "0")
				this.blockedUntil = this.resetAt(res);
			if (res.status === 429 && attempt < 5) {
				this.blockedUntil = Math.max(this.blockedUntil, this.resetAt(res));
				continue;
			}
			if (!res.ok) {
				const body = (await res.text().catch(() => "")).slice(0, 300);
				throw new ProviderError(
					"clickup",
					path,
					`HTTP ${res.status}${body ? `: ${body}` : ""}`,
					res.status,
				);
			}
			return (await res.json()) as T;
		}
	}

	user = () => this.get<{ user: CuUser }>("/user").then((r) => r.user);
	teams = () => this.get<{ teams: CuTeam[] }>("/team").then((r) => r.teams);
	spaces = (teamId: string, archived = false) =>
		this.get<{ spaces: CuSpace[] }>(`/team/${enc(teamId)}/space`, {
			archived,
		}).then((r) => r.spaces);
	folders = (spaceId: string, archived = false) =>
		this.get<{ folders: CuFolder[] }>(`/space/${enc(spaceId)}/folder`, {
			archived,
		}).then((r) => r.folders);
	folderlessLists = (spaceId: string, archived = false) =>
		this.get<{ lists: CuList[] }>(`/space/${enc(spaceId)}/list`, {
			archived,
		}).then((r) => r.lists);
	folderLists = (folderId: string, archived = false) =>
		this.get<{ lists: CuList[] }>(`/folder/${enc(folderId)}/list`, {
			archived,
		}).then((r) => r.lists);
	list = (listId: string) => this.get<CuList>(`/list/${enc(listId)}`);
	fields = (listId: string) =>
		this.get<{ fields: ClickUpField[] }>(`/list/${enc(listId)}/field`).then(
			(r) => r.fields,
		);
	task = (taskId: string) =>
		this.get<CuTask>(`/task/${enc(taskId)}`, {
			include_subtasks: true,
			include_markdown_description: true,
		});
	comments = (taskId: string) =>
		this.get<{ comments: CuComment[] }>(`/task/${enc(taskId)}/comment`).then(
			(r) => r.comments,
		);
	replies = (commentId: string) =>
		this.get<{ comments: CuComment[] }>(
			`/comment/${enc(commentId)}/reply`,
		).then((r) => r.comments);

	/** Every task of a list (subtasks included), 100 per page until `last_page`. */
	async tasks(listId: string, includeClosed: boolean): Promise<CuTask[]> {
		const out: CuTask[] = [];
		for (let page = 0; page < 1000; page++) {
			const r = await this.get<{ tasks: CuTask[]; last_page?: boolean }>(
				`/list/${enc(listId)}/task`,
				{
					page,
					subtasks: true,
					include_closed: includeClosed,
					include_markdown_description: true,
				},
			);
			out.push(...r.tasks);
			if (r.last_page ?? r.tasks.length < 100) break;
		}
		return out;
	}

	timeEntries = (teamId: string, listId: string, assignees: string[]) =>
		this.get<{ data: CuTimeEntry[] }>(`/team/${enc(teamId)}/time_entries`, {
			start_date: 0,
			end_date: Date.now(),
			list_id: listId,
			...(assignees.length ? { assignee: assignees.join(",") } : {}),
		}).then((r) => r.data);
}

const enc = encodeURIComponent;

/** `GET /user` + `GET /team` for the wizard's "Test connection". */
export async function testClickUp(api: ClickUpApi): Promise<ClickUpConnection> {
	const [u, teams] = await Promise.all([api.user(), api.teams()]);
	return {
		user: {
			id: String(u.id),
			username: u.username ?? "",
			email: u.email ?? "",
		},
		teams: teams.map((t) => ({ id: String(t.id), name: t.name })),
	};
}

/** Workspace → spaces → folders → lists, for the wizard's "Choose" step. */
export async function clickUpTree(
	api: ClickUpApi,
	teamId: string,
): Promise<ClickUpTreeNode[]> {
	const listNode = (l: CuList): ClickUpTreeNode => ({
		id: String(l.id),
		type: "list",
		name: l.name,
		taskCount: typeof l.task_count === "number" ? l.task_count : null,
		archived: l.archived ?? false,
		children: [],
	});
	const spaces = await api.spaces(teamId);
	return Promise.all(
		spaces.map(async (s) => {
			const [folders, lists] = await Promise.all([
				api.folders(s.id),
				api.folderlessLists(s.id),
			]);
			return {
				id: String(s.id),
				type: "space" as const,
				name: s.name,
				taskCount: null,
				archived: s.archived ?? false,
				children: [
					...folders.map((f) => ({
						id: String(f.id),
						type: "folder" as const,
						name: f.name,
						taskCount: null,
						archived: f.archived ?? false,
						children: (f.lists ?? []).map(listNode),
					})),
					...lists.map(listNode),
				],
			};
		}),
	);
}

/** Statuses, fields and members of the chosen lists with the proposed mapping; the server adds org matches. */
export async function clickUpInspect(
	api: ClickUpApi,
	teamId: string,
	listIds: string[],
): Promise<Omit<ClickUpInspection, "orgMembers">> {
	const statuses = new Map<string, ClickUpInspection["statuses"][number]>();
	const fields = new Map<string, ClickUpInspection["fields"][number]>();
	for (const id of listIds) {
		const [list, listFields] = await Promise.all([
			api.list(id),
			api.fields(id),
		]);
		for (const s of list.statuses ?? []) {
			const key = s.status.trim().toLowerCase();
			if (!statuses.has(key))
				statuses.set(key, {
					key,
					name: s.status,
					type: s.type,
					proposed: mapClickUpStatus(s),
				});
		}
		for (const f of listFields) {
			if (fields.has(f.id)) continue;
			const m = mapClickUpField(f);
			fields.set(f.id, {
				id: f.id,
				name: f.name,
				type: f.type,
				proposed: "skip" in m ? null : m.config,
				reason: "skip" in m ? m.reason : null,
			});
		}
	}
	const team = (await api.teams()).find((t) => String(t.id) === teamId);
	return {
		statuses: [...statuses.values()],
		fields: [...fields.values()],
		members: (team?.members ?? []).map(({ user: u }) => ({
			id: String(u.id),
			username: u.username ?? `User ${u.id}`,
			email: u.email ?? null,
			matchUserId: null,
		})),
	};
}

import type {
	PluginHostMessage,
	PluginPageMessage,
} from "@logistack/contracts";

// The page side of the bridge (docs/plans/plugins.md, "Bridge"). A plugin page runs in an
// opaque origin: no cookies, no localStorage, no IndexedDB. Everything it needs from the
// dashboard goes through postMessage to `window.parent`.

type Init = Extract<PluginHostMessage, { type: "init" }>;

export type Page = {
	/** Theme, viewer, organization, the tab's context, and the path below the page. */
	init: Omit<Init, "type" | "token" | "tokenExpiresAt">;
	/** `fetch` to the plugin's own backend (`/ui/api/<path>`), with a fresh session token. */
	api(path: string, init?: RequestInit): Promise<Response>;
	/** A session token valid for at least a minute. */
	token(): Promise<string>;
	storage: {
		get<T = unknown>(key: string): Promise<T | null>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<void>;
	};
	toast(message: string, kind?: "info" | "success" | "error"): void;
	/** The dashboard's own confirm dialog; resolves true when confirmed. */
	confirm(o: {
		title: string;
		description?: string;
		confirmLabel?: string;
		destructive?: boolean;
	}): Promise<boolean>;
	/** A dashboard route (`/projects/…`), or `./other-page` of this plugin. */
	navigate(to: string): void;
	/** Opens an https URL in a new tab after the dashboard shows the user its domain. */
	openExternal(url: string): void;
	/** Called when the user switches between light and dark. */
	onTheme(cb: (theme: "light" | "dark") => void): void;
};

const post = (m: PluginPageMessage) => window.parent.postMessage(m, "*");

let seq = 0;
const pending = new Map<
	string,
	{ resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function ask(m: PluginPageMessage & { id: string }): Promise<unknown> {
	return new Promise((resolve, reject) => {
		pending.set(m.id, { resolve, reject });
		post(m);
	});
}
const nextId = () => `m${++seq}`;

/** Sets the CSS variables the dashboard sent, so `ui.css` and your styles follow its theme. */
function applyTheme(theme: "light" | "dark", css: Record<string, string>) {
	const root = document.documentElement;
	root.dataset.theme = theme;
	root.style.colorScheme = theme;
	for (const [k, v] of Object.entries(css))
		if (k.startsWith("--")) root.style.setProperty(k, v);
}

let connecting: Promise<Page> | undefined;

/** Waits for the dashboard's `init` and returns the page API. Call once; later calls share it. */
export function connect(): Promise<Page> {
	connecting ??= new Promise<Page>((resolve, reject) => {
		if (window.parent === window) {
			reject(new Error("this page only runs inside the LogiStack dashboard"));
			return;
		}
		let token = "";
		let expiresAt = 0;
		const themeListeners: ((t: "light" | "dark") => void)[] = [];
		window.addEventListener("message", (e: MessageEvent) => {
			// Only our embedding dashboard talks to us.
			if (e.source !== window.parent) return;
			const m = e.data as PluginHostMessage;
			if (m?.type === "init") {
				token = m.token;
				expiresAt = Date.parse(m.tokenExpiresAt);
				applyTheme(m.theme, m.css);
				const { type: _t, token: _k, tokenExpiresAt: _e, ...init } = m;
				resolve(page(init));
			} else if (m?.type === "theme") {
				applyTheme(m.theme, m.css);
				for (const cb of themeListeners) cb(m.theme);
			} else if (m?.type === "reply") {
				const p = pending.get(m.id);
				if (!p) return;
				pending.delete(m.id);
				if (m.ok) p.resolve(m.value);
				else p.reject(new Error(m.error));
			}
		});

		const fresh = async () => {
			if (expiresAt - Date.now() > 60_000) return token;
			const r = (await ask({ type: "token.refresh", id: nextId() })) as {
				token: string;
				expiresAt: string;
			};
			token = r.token;
			expiresAt = Date.parse(r.expiresAt);
			return token;
		};
		// Pages live at /plugins/<installId>/ui/…; their backend at /plugins/<installId>/ui/api/….
		const base = location.pathname.replace(
			/(\/plugins\/[^/]+\/ui)(\/.*)?$/,
			"$1",
		);

		const page = (init: Page["init"]): Page => ({
			init,
			token: fresh,
			async api(path, req = {}) {
				const headers = new Headers(req.headers);
				headers.set("x-logistack-session", await fresh());
				if (req.body && !headers.has("content-type"))
					headers.set("content-type", "application/json");
				return fetch(`${base}/api/${path.replace(/^\/+/, "")}`, {
					...req,
					headers,
				});
			},
			storage: {
				get: async (key) =>
					(await ask({ type: "storage.get", id: nextId(), key })) as never,
				set: async (key, value) => {
					await ask({ type: "storage.set", id: nextId(), key, value });
				},
				delete: async (key) => {
					await ask({ type: "storage.delete", id: nextId(), key });
				},
			},
			toast: (message, kind = "info") => post({ type: "toast", message, kind }),
			confirm: async (o) =>
				(await ask({ type: "confirm", id: nextId(), ...o })) === true,
			navigate: (to) => post({ type: "navigate", to }),
			openExternal: (url) => post({ type: "openExternal", url }),
			onTheme: (cb) => {
				themeListeners.push(cb);
			},
		});

		// Keep the iframe as tall as the content, so the page never scrolls inside a scroll.
		const report = () =>
			post({
				type: "resize",
				height: Math.ceil(document.documentElement.scrollHeight),
			});
		new ResizeObserver(report).observe(document.documentElement);
		post({ type: "ready" });
	});
	return connecting;
}

/**
 * A `localStorage`-shaped object for libraries that accept a custom storage. Reads come from
 * a copy loaded by `preload`; writes go to the bridge in the background.
 */
export async function bridgeStorage(
	page: Page,
	preload: string[],
): Promise<Pick<Storage, "getItem" | "setItem" | "removeItem">> {
	const copy = new Map<string, string>();
	await Promise.all(
		preload.map(async (k) => {
			const v = await page.storage.get<string>(k);
			if (v !== null) copy.set(k, v);
		}),
	);
	return {
		getItem: (k) => copy.get(k) ?? null,
		setItem: (k, v) => {
			copy.set(k, String(v));
			void page.storage.set(k, String(v));
		},
		removeItem: (k) => {
			copy.delete(k);
			void page.storage.delete(k);
		},
	};
}

import {
	type PluginHostMessage,
	type PluginPage,
	PluginPageMessage,
} from "@logistack/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { pluginIcon, UnlistedBadge } from "@/components/plugins/plugin-icon";
import { Button } from "@/components/ui/button";
import { useMe, useOrganization } from "@/lib/api/access";
import {
	type PluginContext,
	type PluginContribution,
	pluginsApi,
} from "@/lib/api/plugins";
import { useSessionUser } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

/** Tall enough for a loading state; the page reports its real height with `resize`. */
const MIN_HEIGHT = 480;

/** The tokens `@logistack/plugin-sdk/ui.css` and plugin styles build on. */
const CSS_TOKENS = [
	"radius",
	"background",
	"foreground",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"muted",
	"muted-foreground",
	"accent",
	"accent-foreground",
	"destructive",
	"border",
	"input",
	"ring",
	"brand",
	"brand-foreground",
	...["ok", "busy", "info", "warn", "bad", "idle"].flatMap((t) => [
		t,
		`${t}-text`,
	]),
	"chart-1",
	"chart-2",
	"chart-3",
	"chart-4",
	"chart-5",
];

function cssTokens(): Record<string, string> {
	const style = getComputedStyle(document.documentElement);
	const out: Record<string, string> = {};
	for (const name of CSS_TOKENS) {
		const v = style.getPropertyValue(`--${name}`).trim();
		if (v) out[`--${name}`] = v;
	}
	return out;
}

/** A path inside this dashboard that the router knows; never another origin or the raw proxy. */
function dashboardPath(
	to: string,
	router: ReturnType<typeof useRouter>,
): string | null {
	if (!/^\/(?![/\\])/.test(to)) return null;
	let url: URL;
	try {
		url = new URL(to, window.location.origin);
	} catch {
		return null;
	}
	if (url.origin !== window.location.origin) return null;
	if (url.pathname.startsWith("/plugins/") || url.pathname.startsWith("/api/"))
		return null;
	const matches = router.matchRoutes(url.pathname, {});
	const leaf = matches.at(-1);
	if (!leaf || leaf.routeId === "__root__" || leaf.routeId === "/_app")
		return null;
	return url.pathname + url.search + url.hash;
}

/** Where another page of the same plugin lives, seen from `context`; null when it has no place there. */
export function pluginPageHref(
	installId: string,
	target: PluginPage,
	sub: string,
	context: PluginContext,
): string | null {
	const tail = `${encodeURIComponent(target.id)}${sub ? `/${sub}` : ""}`;
	if (target.location === "sidebar" || target.location === "settings")
		return `/plugin/${installId}/${tail}`;
	if (
		target.location === "service-tab" &&
		context.projectId &&
		context.serviceId
	)
		return `/projects/${context.projectId}/services/${context.serviceId}/plugin/${installId}/${tail}`;
	if (target.location === "project-tab" && context.projectId)
		return `/projects/${context.projectId}/plugin/${installId}/${tail}`;
	return null;
}

type Pending =
	| {
			kind: "confirm";
			id: string;
			title: string;
			description?: string;
			confirmLabel?: string;
			destructive?: boolean;
	  }
	| { kind: "external"; url: URL };

/**
 * Hosts one plugin page: a fixed header the page can never cover (who made it), then the
 * page in an opaque-origin iframe, and the postMessage bridge between the two.
 */
export function PluginFrame({
	contribution,
	page,
	subpath,
	context,
}: {
	contribution: PluginContribution;
	page: PluginPage;
	/** Path below the page, from the dashboard URL, without a leading slash. */
	subpath: string;
	context: PluginContext;
}) {
	const { installId, pluginName, author, unlisted } = contribution;
	const frame = useRef<HTMLIFrameElement>(null);
	const ready = useRef(false);
	const [height, setHeight] = useState(MIN_HEIGHT);
	const [pending, setPending] = useState<Pending | null>(null);
	const router = useRouter();
	const { resolved, name: themeName } = useTheme();
	const user = useSessionUser();
	const { data: me } = useMe();
	const { data: org } = useOrganization();
	const Icon = pluginIcon(page.icon);

	const base = page.path.replace(/\/$/, "");
	const src = `/plugins/${installId}${subpath ? `${base}/${subpath}` : page.path}`;

	const post = useCallback((m: PluginHostMessage) => {
		frame.current?.contentWindow?.postMessage(m, "*");
	}, []);
	const reply = useCallback(
		(id: string, run: () => Promise<unknown>) =>
			run().then(
				(value) => post({ type: "reply", id, ok: true, value }),
				(err: unknown) =>
					post({
						type: "reply",
						id,
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					}),
			),
		[post],
	);

	// Everything the handler reads, so the listener itself never re-subscribes mid-load.
	const latest = useRef({
		context,
		subpath,
		resolved,
		user,
		me,
		org,
		contribution,
		pending,
	});
	latest.current = {
		context,
		subpath,
		resolved,
		user,
		me,
		org,
		contribution,
		pending,
	};

	useEffect(() => {
		const onMessage = async (e: MessageEvent) => {
			// The page's origin is "null", so the window is the only trustworthy check.
			if (!frame.current || e.source !== frame.current.contentWindow) return;
			const parsed = PluginPageMessage.safeParse(e.data);
			if (!parsed.success) return;
			const m = parsed.data;
			const l = latest.current;
			switch (m.type) {
				case "ready": {
					try {
						const s = await pluginsApi.session(installId, l.context);
						ready.current = true;
						post({
							type: "init",
							theme: l.resolved,
							css: cssTokens(),
							locale: navigator.language,
							user: {
								id: l.user?.id ?? l.me?.userId ?? "",
								name: l.user?.name ?? "",
							},
							organization: {
								id: l.org?.id ?? l.me?.organizationId ?? "",
								name: l.org?.name ?? "",
							},
							context: l.context,
							subpath: l.subpath,
							token: s.token,
							tokenExpiresAt: s.expiresAt,
						});
					} catch (err) {
						toast.error(`${pluginName} couldn't start`, {
							description: err instanceof Error ? err.message : String(err),
						});
					}
					return;
				}
				case "token.refresh":
					void reply(m.id, () => pluginsApi.session(installId, l.context));
					return;
				case "resize":
					setHeight(Math.max(MIN_HEIGHT, Math.ceil(m.height)));
					return;
				case "toast": {
					const show =
						m.kind === "success"
							? toast.success
							: m.kind === "error"
								? toast.error
								: toast;
					show(m.message, { description: `From ${pluginName}` });
					return;
				}
				case "navigate": {
					if (m.to.startsWith("./")) {
						const [pageId = "", ...rest] = m.to.slice(2).split("/");
						const target = l.contribution.pages.find((p) => p.id === pageId);
						const href =
							target &&
							pluginPageHref(installId, target, rest.join("/"), l.context);
						if (href) void router.navigate({ href });
						return;
					}
					const href = dashboardPath(m.to, router);
					if (href) void router.navigate({ href });
					return;
				}
				case "confirm":
					// One dialog at a time; a second ask while one is open is declined.
					if (l.pending)
						post({ type: "reply", id: m.id, ok: true, value: false });
					else setPending({ kind: "confirm", ...m });
					return;
				case "openExternal": {
					const url = new URL(m.url);
					if (url.protocol === "https:" && !l.pending)
						setPending({ kind: "external", url });
					return;
				}
				case "storage.get":
					void reply(m.id, () => pluginsApi.storageGet(installId, m.key));
					return;
				case "storage.set":
					void reply(m.id, () =>
						pluginsApi.storageSet(installId, m.key, m.value),
					);
					return;
				case "storage.delete":
					void reply(m.id, () => pluginsApi.storageDelete(installId, m.key));
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [installId, pluginName, post, reply, router]);

	// A new page load waits for its own `ready`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on every new src.
	useEffect(() => {
		ready.current = false;
		setHeight(MIN_HEIGHT);
	}, [src]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the theme name changes the tokens too.
	useEffect(() => {
		if (ready.current)
			post({ type: "theme", theme: resolved, css: cssTokens() });
	}, [resolved, themeName, post]);

	const answer = (ok: boolean) => {
		if (pending?.kind === "confirm")
			post({ type: "reply", id: pending.id, ok: true, value: ok });
		setPending(null);
	};

	return (
		<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
			<header className="flex h-11 items-center gap-2.5 border-b bg-muted/40 px-3 text-sm">
				<span className="grid size-6 shrink-0 place-items-center rounded-md bg-card text-foreground ring-1 ring-border">
					<Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
				</span>
				<span className="min-w-0 truncate font-medium">{pluginName}</span>
				{author && (
					<span className="hidden truncate text-muted-foreground sm:inline">
						by {author}
					</span>
				)}
				{unlisted && <UnlistedBadge />}
				<Button
					asChild
					variant="ghost"
					size="icon-sm"
					className="ml-auto"
					aria-label={`${pluginName} settings`}
				>
					<Link to="/settings/plugins/$installId" params={{ installId }}>
						<Settings2 />
					</Link>
				</Button>
			</header>
			<iframe
				key={src}
				ref={frame}
				src={src}
				title={`${page.title}, a page from the ${pluginName} plugin`}
				sandbox="allow-scripts allow-forms"
				referrerPolicy="no-referrer"
				className="block w-full bg-background"
				style={{ height }}
			/>
			<ConfirmDialog
				open={pending?.kind === "confirm"}
				onOpenChange={(o) => !o && answer(false)}
				title={pending?.kind === "confirm" ? pending.title : ""}
				description={
					pending?.kind === "confirm" && pending.description
						? pending.description
						: `${pluginName} asks you to confirm.`
				}
				confirmLabel={
					(pending?.kind === "confirm" && pending.confirmLabel) || "Confirm"
				}
				destructive={pending?.kind === "confirm" && !!pending.destructive}
				pending={false}
				onConfirm={() => answer(true)}
			>
				<p className="text-xs text-muted-foreground">Asked by {pluginName}.</p>
			</ConfirmDialog>
			<ConfirmDialog
				open={pending?.kind === "external"}
				onOpenChange={(o) => !o && setPending(null)}
				title={`Open ${pending?.kind === "external" ? pending.url.hostname : ""}?`}
				description={
					<>
						{pluginName} wants to open a page on{" "}
						<span className="font-medium text-foreground">
							{pending?.kind === "external" ? pending.url.hostname : ""}
						</span>{" "}
						in a new tab. LogiStack doesn't check that site.
					</>
				}
				confirmLabel="Open"
				destructive={false}
				pending={false}
				onConfirm={() => {
					if (pending?.kind === "external")
						window.open(pending.url.href, "_blank", "noopener,noreferrer");
					setPending(null);
				}}
			>
				{pending?.kind === "external" && (
					<p className="truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
						{pending.url.href}
					</p>
				)}
			</ConfirmDialog>
		</div>
	);
}

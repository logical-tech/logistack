/*
 * The Work keyboard layer (section 13.3). One window listener; components register keys with
 * `useShortcut`, and the most recently mounted handler for a key wins, so a page's `c` beats
 * the global one and an open sheet's `s` beats the table's. Keys are ignored while typing.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { NewTaskDialog } from "./new-task-dialog";
import { SaveAsTemplateHost } from "./templates/save-as-template-wizard";
import { useTimerToggle } from "./time/running-timer-pill";
import { useWorkUserRefresh } from "./use-work-subscription";

type Handler = (e: KeyboardEvent) => void;
const registry = new Map<string, Handler[]>();
let pending: { key: string; at: number } | null = null;

/** True when the event comes from a field where keys type text. */
export function isTyping(e: KeyboardEvent) {
	const t = e.target as HTMLElement | null;
	if (!t) return false;
	return (
		t.isContentEditable ||
		t.tagName === "INPUT" ||
		t.tagName === "TEXTAREA" ||
		t.tagName === "SELECT" ||
		t.closest('[role="listbox"],[role="menu"],[cmdk-root]') !== null
	);
}

/** `mod+.` → "mod+.", `?` → "?", `g` then `m` → "g m". */
function chordOf(e: KeyboardEvent): string {
	const mod = e.metaKey || e.ctrlKey;
	const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
	return `${mod ? "mod+" : ""}${e.altKey ? "alt+" : ""}${key === "?" ? "?" : key}`;
}

function onKeyDown(e: KeyboardEvent) {
	if (e.defaultPrevented || isTyping(e)) return;
	const chord = chordOf(e);
	const now = Date.now();
	const candidates =
		pending && now - pending.at < 1200
			? [`${pending.key} ${chord}`, chord]
			: [chord];
	for (const key of candidates) {
		const handlers = registry.get(key);
		const handler = handlers?.[handlers.length - 1];
		if (handler) {
			pending = null;
			e.preventDefault();
			handler(e);
			return;
		}
	}
	// A key that starts a sequence ("g") waits for the next one.
	const starts = [...registry.keys()].some((k) => k.startsWith(`${chord} `));
	pending = starts ? { key: chord, at: now } : null;
}

let listening = false;
function ensureListener() {
	if (listening || typeof window === "undefined") return;
	window.addEventListener("keydown", onKeyDown);
	listening = true;
}

/** Registers `keys` ("c", "g m", "mod+.", "?") while mounted and `enabled`. */
export function useShortcut(keys: string, handler: Handler, enabled = true) {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (!enabled) return;
		ensureListener();
		const fn: Handler = (e) => ref.current(e);
		const list = registry.get(keys) ?? [];
		registry.set(keys, [...list, fn]);
		return () => {
			const next = (registry.get(keys) ?? []).filter((h) => h !== fn);
			if (next.length) registry.set(keys, next);
			else registry.delete(keys);
		};
	}, [keys, enabled]);
}

export const SHORTCUTS: { keys: string[][]; label: string }[] = [
	{ keys: [["c"]], label: "New task (in context)" },
	{ keys: [["/"]], label: "Search" },
	{ keys: [["⌘", "K"]], label: "Command palette" },
	{ keys: [["g", "m"]], label: "My tasks" },
	{ keys: [["g", "i"]], label: "Inbox" },
	{ keys: [["g", "p"]], label: "Projects" },
	{ keys: [["g", "t"]], label: "Time" },
	{ keys: [["1"], ["4"]], label: "Switch to the view in that tab" },
	{ keys: [["j"], ["k"]], label: "Next / previous task" },
	{ keys: [["Enter"], ["Esc"]], label: "Open / close task" },
	{
		keys: [["s"], ["a"], ["d"], ["p"], ["l"]],
		label: "Status, assignee, dates, priority, tags",
	},
	{ keys: [["x"]], label: "Select the focused row" },
	{ keys: [["t"]], label: "Start or stop the timer on the open task" },
	{ keys: [["⌘", "Enter"]], label: "Send comment" },
	{ keys: [["⌘", "."]], label: "Copy task link" },
	{ keys: [["?"]], label: "Show these shortcuts" },
];

export function ShortcutHelp({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						They work anywhere in Tasks, except while you type in a field.
					</DialogDescription>
				</DialogHeader>
				<dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5 text-sm">
					{SHORTCUTS.map((s) => (
						<div key={s.label} className="contents">
							<dt className="text-muted-foreground">{s.label}</dt>
							<dd className="flex items-center justify-end gap-1">
								{s.keys.map((combo) => (
									<KbdGroup key={combo.join("+")}>
										{combo.map((k) => (
											<Kbd key={k}>{k}</Kbd>
										))}
									</KbdGroup>
								))}
							</dd>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}

/** The global layer: navigation sequences and the help sheet. Mounted once in the app layout. */
export function WorkShortcuts() {
	const navigate = useNavigate();
	const [help, setHelp] = useState(false);
	const [creating, setCreating] = useState(false);
	useShortcut("?", () => setHelp(true));
	// A project view registers its own `c` (quick add in place), which wins while it's mounted.
	useShortcut("c", () => setCreating(true));
	useEffect(() => {
		const open = () => setCreating(true);
		window.addEventListener("work:new-task", open);
		return () => window.removeEventListener("work:new-task", open);
	}, []);
	useShortcut("g m", () => navigate({ to: "/work" }));
	useShortcut("g i", () => navigate({ to: "/work/inbox" }));
	useShortcut("g p", () => navigate({ to: "/work/projects" }));
	useShortcut("g t", () => navigate({ to: "/work/time" }));
	useTimerToggle();
	useWorkUserRefresh();
	return (
		<>
			<ShortcutHelp open={help} onOpenChange={setHelp} />
			<NewTaskDialog open={creating} onOpenChange={setCreating} />
			<SaveAsTemplateHost />
		</>
	);
}

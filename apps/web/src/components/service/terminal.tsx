import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { Lock, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/segmented";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError, api } from "@/lib/api";
import type { ServiceTask, Shell } from "@/lib/api/service-ops";
import type { ServiceId } from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

/** One session's life; a reconnect is a new session with a new ticket. */
type Phase =
	| { kind: "connecting" }
	| { kind: "open"; taskId: string }
	| { kind: "exited"; code: number | null }
	| { kind: "failed"; message: string }
	| { kind: "locked" }
	| { kind: "no-replica" };

const PHASE_META: Record<Phase["kind"], StatusMeta> = {
	connecting: { label: "Connecting", tone: "busy", live: true },
	open: { label: "Connected", tone: "ok" },
	exited: { label: "Exited", tone: "idle" },
	failed: { label: "Disconnected", tone: "bad" },
	locked: { label: "Not allowed", tone: "idle" },
	"no-replica": { label: "No replica", tone: "idle" },
};

/** xterm.js takes concrete colours; the log tokens in index.css are hex for this reason. */
function theme() {
	const css = getComputedStyle(document.documentElement);
	const v = (name: string) => css.getPropertyValue(name).trim();
	const ansi = Array.from({ length: 16 }, (_, i) => v(`--ansi-${i}`));
	return {
		background: v("--log-bg"),
		foreground: v("--log-fg"),
		cursor: v("--log-fg"),
		cursorAccent: v("--log-bg"),
		selectionBackground: v("--log-selection"),
		black: ansi[0],
		red: ansi[1],
		green: ansi[2],
		yellow: ansi[3],
		blue: ansi[4],
		magenta: ansi[5],
		cyan: ansi[6],
		white: ansi[7],
		brightBlack: ansi[8],
		brightRed: ansi[9],
		brightGreen: ansi[10],
		brightYellow: ansi[11],
		brightBlue: ansi[12],
		brightMagenta: ansi[13],
		brightCyan: ansi[14],
		brightWhite: ansi[15],
	};
}

function phaseText(phase: Phase, tasks: ServiceTask[], shell: Shell) {
	// Slim images (alpine, distroless) ship no bash; the exec then fails to start.
	if (phase.kind === "failed" && shell === "bash")
		return `${phase.message}. The image may not include bash; try sh.`;
	if (phase.kind === "open") {
		const t = tasks.find((x) => x.id === phase.taskId);
		return t
			? `Replica #${t.slot ?? "?"}${t.hostname ? ` on ${t.hostname}` : ""}`
			: "";
	}
	if (phase.kind === "exited")
		return phase.code === null ? "The shell ended" : `Exit code ${phase.code}`;
	if (phase.kind === "failed") return phase.message;
	return "";
}

export function ServiceTerminal({
	serviceId,
	tasks,
}: {
	serviceId: ServiceId;
	tasks: ServiceTask[];
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [shell, setShell] = useState<Shell>("sh");
	const [taskId, setTaskId] = useState<string | undefined>(undefined);
	const [session, setSession] = useState(0);
	const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
	const running = tasks.filter((t) => t.state === "running");
	const target = running.some((t) => t.id === taskId) ? taskId : undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `session` is the reconnect trigger
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const term = new XTerm({
			fontFamily: '"Monaspace Neon", ui-monospace, "SF Mono", Menlo, monospace',
			fontSize: 12.5,
			lineHeight: 1.25,
			cursorBlink: true,
			scrollback: 5_000,
			theme: theme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		term.focus();
		let ws: WebSocket | undefined;
		let disposed = false;
		setPhase({ kind: "connecting" });

		const send = (m: object) => {
			if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
		};
		const input = term.onData((data) => send({ type: "input", data }));
		const resize = term.onResize(({ rows, cols }) =>
			send({ type: "resize", rows, cols }),
		);
		const ro = new ResizeObserver(() => fit.fit());
		ro.observe(host);
		// The theme follows the app's light/dark switch.
		const mo = new MutationObserver(() => {
			term.options.theme = theme();
		});
		mo.observe(document.documentElement, { attributeFilter: ["class"] });

		api.serviceOps
			.exec(serviceId, {
				shell,
				rows: Math.max(term.rows, 2),
				cols: Math.max(term.cols, 2),
				...(target ? { taskId: target } : {}),
			})
			.then(
				(ticket) => {
					if (disposed) return;
					const url = new URL("/ws/exec", window.location.href);
					url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
					url.searchParams.set("ticket", ticket.ticket);
					ws = new WebSocket(url);
					ws.binaryType = "arraybuffer";
					let ended = false;
					ws.onmessage = (e) => {
						if (e.data instanceof ArrayBuffer) {
							term.write(new Uint8Array(e.data));
							return;
						}
						const m = JSON.parse(String(e.data)) as
							| { type: "ready"; taskId: string }
							| { type: "exit"; code: number | null }
							| { type: "error"; message: string };
						if (m.type === "ready")
							setPhase({ kind: "open", taskId: m.taskId });
						else if (m.type === "exit") {
							ended = true;
							setPhase({ kind: "exited", code: m.code });
						} else {
							ended = true;
							setPhase({ kind: "failed", message: m.message });
						}
					};
					ws.onclose = () => {
						if (!disposed && !ended)
							setPhase({ kind: "failed", message: "The connection closed" });
					};
				},
				(e: unknown) => {
					if (disposed) return;
					if (e instanceof ApiError && e.status === 403)
						setPhase({ kind: "locked" });
					else if (e instanceof ApiError && e.status === 409)
						setPhase({ kind: "no-replica" });
					else
						setPhase({
							kind: "failed",
							message: e instanceof Error ? e.message : "Couldn't open a shell",
						});
				},
			);

		return () => {
			disposed = true;
			ws?.close();
			input.dispose();
			resize.dispose();
			ro.disconnect();
			mo.disconnect();
			term.dispose();
		};
	}, [serviceId, shell, target, session]);

	if (phase.kind === "locked")
		return (
			<EmptyState
				icon={Lock}
				title="The terminal needs the Terminal permission"
				description="A shell runs commands inside the container as its user, so it is granted on its own, apart from deploy and write. An admin can add Terminal to your role for this service or a scope above it."
			/>
		);

	const reconnect = (
		<Button
			variant="outline"
			size="sm"
			className="ml-auto"
			onClick={() => setSession((n) => n + 1)}
		>
			<RotateCw data-icon="inline-start" />
			<span className="max-sm:sr-only">
				{phase.kind === "open" ? "Restart session" : "Reconnect"}
			</span>
		</Button>
	);

	return (
		<div className="flex flex-col overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
			<div className="flex flex-wrap items-center gap-2 border-b px-2 py-2 sm:px-3">
				<Select
					value={target ?? "auto"}
					onValueChange={(v) => setTaskId(v === "auto" ? undefined : v)}
				>
					<SelectTrigger
						size="sm"
						aria-label="Replica"
						className="w-auto min-w-36"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="auto">First running replica</SelectItem>
						{running.map((t) => (
							<SelectItem key={t.id} value={t.id}>
								Replica #{t.slot ?? "?"}
								{t.hostname && (
									<span className="text-muted-foreground">
										{" "}
										on {t.hostname}
									</span>
								)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Segmented
					label="Shell"
					value={shell}
					onChange={setShell}
					options={[
						{ value: "sh", label: "sh" },
						{ value: "bash", label: "bash" },
					]}
				/>
				<span className="order-last flex min-w-0 basis-full items-center gap-2 px-1 text-xs text-muted-foreground sm:order-none sm:basis-auto sm:flex-1">
					<StatusLabel meta={PHASE_META[phase.kind]} className="text-xs" />
					<span className="truncate">{phaseText(phase, tasks, shell)}</span>
				</span>
				{reconnect}
			</div>
			<div className="relative h-[min(64vh,36rem)] bg-[var(--log-bg)] p-2 max-sm:h-[60vh]">
				<div ref={hostRef} className="size-full" />
				{phase.kind === "no-replica" && (
					<div className="absolute inset-0 grid place-items-center bg-[var(--log-bg)] p-6 text-center">
						<div className="max-w-[40ch]">
							<p className="text-sm font-medium text-[var(--log-fg)]">
								No replica is running
							</p>
							<p className="mt-1 text-sm text-[var(--log-muted)]">
								A shell opens inside a running container. Start or deploy the
								service, then reconnect.
							</p>
							<div className="mt-4">{reconnect}</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

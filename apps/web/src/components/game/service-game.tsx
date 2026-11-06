import { GAMES, type GameKind } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	ArrowUpRight,
	CornerDownLeft,
	Eye,
	EyeOff,
	KeyRound,
	Loader2,
	Lock,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedNumber } from "@/components/animated-number";
import { CopyButton, CopyField } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { Panel, SkeletonRows } from "@/components/panel";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import {
	type GameEndpoint,
	type GameServer,
	gameCredentialsQuery,
	gameQuery,
	gamesApi,
	useGameMutation,
} from "@/lib/api/games";
import { dnsProvidersQuery } from "@/lib/api/networking";
import type { ServiceOverview } from "@/lib/api/service-ops";
import type { StatusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";
import { gameMark } from "./game-meta";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `ts3server://` and `mumble://` open the desktop client straight onto the server. */
function joinLink(game: GameKind, address: string): string | null {
	const scheme = GAMES[game].scheme;
	if (!scheme) return null;
	const [host, port] = address.split(/:(?=\d+$)/);
	return game === "teamspeak3"
		? `ts3server://${host}${port ? `?port=${port}` : ""}`
		: `${scheme}://${address}`;
}

function liveMeta(game: GameServer, observed: string): StatusMeta {
	if (game.status.online) return { label: "Online", tone: "ok" };
	if (observed === "starting")
		return { label: "Starting", tone: "busy", live: true };
	if (observed === "stopped") return { label: "Stopped", tone: "idle" };
	return { label: "Not answering", tone: "warn" };
}

/** The join card: status, who is on, and the one address players type. */
function JoinCard({
	game,
	service,
}: {
	game: GameServer;
	service: ServiceOverview;
}) {
	const s = game.status;
	const Mark = gameMark(game.game);
	const primary =
		game.endpoints.find((e) => e.status === "active")?.playerAddress ??
		game.directAddress;
	const link = primary ? joinLink(game.game, primary) : null;
	const facts = [
		s.version,
		s.map,
		s.latencyMs !== undefined && `${s.latencyMs} ms`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<section
			aria-label="Join"
			className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border"
		>
			<div className="flex flex-wrap items-start gap-x-6 gap-y-4 p-5">
				<span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
					<Mark className="size-5" strokeWidth={1.75} aria-hidden />
				</span>
				<div className="min-w-0 flex-1">
					<StatusLabel meta={liveMeta(game, service.status.observed)} />
					<p className="mt-1 truncate text-base font-semibold [font-stretch:108%] text-balance">
						{s.name || GAMES[game.game].label}
					</p>
					<p className="mt-0.5 text-xs text-muted-foreground tabular">
						{facts || GAMES[game.game].label}
					</p>
				</div>
				<div className="text-right">
					<p className="text-2xl font-semibold tabular [font-stretch:108%]">
						<AnimatedNumber value={s.players ?? 0} />
						<span className="text-muted-foreground">
							{" "}
							/ {s.maxPlayers ?? "–"}
						</span>
					</p>
					<p className="text-xs text-muted-foreground">
						{GAMES[game.game].group === "voice"
							? "connected"
							: "players online"}
					</p>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-3 border-t bg-muted/40 px-5 py-3.5 dark:bg-muted/20">
				<span className="text-sm text-muted-foreground">Players join at</span>
				{primary ? (
					<span className="flex min-w-0 items-center gap-1">
						<code className="truncate font-mono text-sm font-medium">
							{primary}
						</code>
						<CopyButton value={primary} label="Copy the join address" />
					</span>
				) : (
					<span className="text-sm">no public address yet</span>
				)}
				{link && (
					<Button asChild variant="outline" size="sm" className="ml-auto">
						<a href={link}>
							Open in {GAMES[game.game].label.split(" ")[0]}
							<ArrowUpRight data-icon="inline-end" />
						</a>
					</Button>
				)}
			</div>
		</section>
	);
}

type Line = { kind: "in" | "out" | "err"; text: string; at: number };

/** RCON console: one command at a time, output kept for this visit only. */
function Console({ serviceId, game }: { serviceId: string; game: GameKind }) {
	const [lines, setLines] = useState<Line[]>([]);
	const [command, setCommand] = useState("");
	const history = useRef<string[]>([]);
	const cursor = useRef(-1);
	const log = useRef<HTMLDivElement>(null);
	const run = useGameMutation(serviceId, (c: string) =>
		gamesApi.command(serviceId, c),
	);
	const push = (l: Omit<Line, "at">) => {
		setLines((prev) => [...prev.slice(-200), { ...l, at: Date.now() }]);
		requestAnimationFrame(() =>
			log.current?.scrollTo({ top: log.current.scrollHeight }),
		);
	};
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const c = command.trim();
		if (!c || run.isPending) return;
		history.current = [c, ...history.current.filter((h) => h !== c)].slice(
			0,
			50,
		);
		cursor.current = -1;
		setCommand("");
		push({ kind: "in", text: c });
		try {
			const { output } = await run.mutateAsync(c);
			push({ kind: "out", text: output || "(no output)" });
		} catch (err) {
			push({ kind: "err", text: errorText(err) });
		}
	};
	const examples =
		game === "cs2"
			? ["status", "changelevel de_mirage", "mp_restartgame 1"]
			: ["list", "whitelist add <player>", "op <player>", "say Hello"];
	return (
		<Panel
			title="Console"
			id="game-console"
			actions={
				<span className="text-xs text-muted-foreground">RCON, audited</span>
			}
		>
			<div
				ref={log}
				role="log"
				aria-live="polite"
				aria-label="Console output"
				className="h-64 overflow-y-auto px-4 py-3 font-mono text-xs leading-5"
			>
				{lines.length === 0 ? (
					<p className="font-sans text-sm text-muted-foreground text-pretty">
						Commands run on the server as an operator. Try{" "}
						{examples.map((x, i) => (
							<span key={x}>
								{i > 0 && ", "}
								<button
									type="button"
									className="rounded font-mono text-xs text-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid"
									onClick={() => setCommand(x.replace(/ <player>$/, " "))}
								>
									{x}
								</button>
							</span>
						))}
						.
					</p>
				) : (
					lines.map((l) => (
						<p
							key={l.at + l.text}
							className={cn(
								"whitespace-pre-wrap break-words",
								l.kind === "in" && "text-muted-foreground",
								l.kind === "err" && "text-bad-text",
							)}
						>
							{l.kind === "in" ? `> ${l.text}` : l.text}
						</p>
					))
				)}
			</div>
			<form onSubmit={submit} className="flex items-center gap-2 border-t p-2">
				<label htmlFor="game-command" className="sr-only">
					Command
				</label>
				<Input
					id="game-command"
					value={command}
					onChange={(e) => setCommand(e.target.value)}
					onKeyDown={(e) => {
						if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
						e.preventDefault();
						const next = Math.max(
							-1,
							Math.min(
								history.current.length - 1,
								cursor.current + (e.key === "ArrowUp" ? 1 : -1),
							),
						);
						cursor.current = next;
						setCommand(next < 0 ? "" : (history.current[next] ?? ""));
					}}
					placeholder={game === "cs2" ? "status" : "list"}
					autoComplete="off"
					spellCheck={false}
					className="border-0 bg-transparent font-mono shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<Button
					type="submit"
					size="sm"
					variant="secondary"
					disabled={!command.trim() || run.isPending}
				>
					{run.isPending ? (
						<Loader2 className="animate-spin" />
					) : (
						<CornerDownLeft />
					)}
					Run
				</Button>
			</form>
		</Panel>
	);
}

function Players({ game }: { game: GameServer }) {
	const names = game.status.playerNames ?? [];
	const voice = GAMES[game.game].group === "voice";
	return (
		<Panel title={voice ? "Connected" : "Players"} id="game-players">
			{names.length ? (
				<ul className="divide-y">
					{names.map((n) => (
						<li key={n} className="flex items-center gap-3 px-4 py-2.5 text-sm">
							<span
								aria-hidden
								className="grid size-6 place-items-center rounded-md bg-muted text-2xs font-semibold uppercase"
							>
								{n.slice(0, 1)}
							</span>
							<span className="truncate">{n}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="px-4 py-6 text-sm text-muted-foreground text-pretty">
					{!game.status.online
						? "The list fills in once the server answers."
						: (game.status.players ?? 0) > 0
							? `${game.status.players} ${voice ? "connected" : "online"}; this server doesn't share their names.`
							: voice
								? "Nobody is connected."
								: "Nobody is playing right now."}
				</p>
			)}
		</Panel>
	);
}

function Secret({ label, value }: { label: string; value: string }) {
	const [shown, setShown] = useState(false);
	return (
		<div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-4">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="flex min-w-0 items-center gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3 dark:bg-muted/40">
				<code className="min-w-0 flex-1 truncate py-1 font-mono text-xs leading-5">
					{shown ? value : "•".repeat(Math.min(24, value.length))}
				</code>
				<Button
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground"
					aria-label={shown ? `Hide ${label}` : `Show ${label}`}
					aria-pressed={shown}
					onClick={() => setShown((s) => !s)}
				>
					{shown ? <EyeOff /> : <Eye />}
				</Button>
				<CopyButton value={value} label={`Copy ${label}`} />
			</dd>
		</div>
	);
}

const ADMIN_LABEL: Record<GameKind, string | null> = {
	"minecraft-java": "RCON password",
	"minecraft-bedrock": null,
	cs2: "RCON password",
	teamspeak3: "serveradmin password",
	mumble: "SuperUser password",
};

function Access({ game, serviceId }: { game: GameServer; serviceId: string }) {
	const creds = useQuery(gameCredentialsQuery(serviceId));
	const [key, setKey] = useState<string>();
	const make = useGameMutation(serviceId, () => gamesApi.adminKey(serviceId));
	const admin = ADMIN_LABEL[game.game];
	if (!admin && !creds.data?.join && game.game !== "teamspeak3") return null;
	return (
		<Panel title="Access" id="game-access">
			{creds.isPending ? (
				<SkeletonRows rows={2} />
			) : creds.isError ? (
				creds.error instanceof ApiError && creds.error.status === 403 ? (
					<p className="flex items-start gap-3 px-4 py-4 text-sm">
						<Lock className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
						<span className="text-muted-foreground">
							Passwords need the read:secrets permission on this service.
						</span>
					</p>
				) : (
					<p role="alert" className="px-4 py-4 text-sm text-bad-text">
						{errorText(creds.error)}
					</p>
				)
			) : (
				<dl className="divide-y">
					{creds.data.join && (
						<Secret label="Join password" value={creds.data.join} />
					)}
					{admin && creds.data.admin && (
						<Secret label={admin} value={creds.data.admin} />
					)}
				</dl>
			)}
			{game.game === "teamspeak3" && (
				<div className="grid gap-3 border-t px-4 py-3.5">
					<p className="text-sm text-muted-foreground text-pretty">
						A privilege key makes whoever uses it Server Admin. Use it once in
						the TeamSpeak client under Permissions, Use Privilege Key.
					</p>
					{key ? (
						<CopyField value={key} label="Copy the privilege key" />
					) : (
						<Button
							variant="outline"
							size="sm"
							className="justify-self-start"
							disabled={!game.status.online || make.isPending}
							onClick={() =>
								make.mutate(undefined, {
									onSuccess: (r) => setKey(r.key),
									onError: (e) =>
										toast.error("No key was created", {
											description: errorText(e),
										}),
								})
							}
						>
							{make.isPending ? (
								<Loader2 className="animate-spin" />
							) : (
								<KeyRound />
							)}
							Create admin key
						</Button>
					)}
				</div>
			)}
		</Panel>
	);
}

function EndpointRow({
	endpoint,
	serviceId,
	providerName,
}: {
	endpoint: GameEndpoint;
	serviceId: string;
	providerName: string | null;
}) {
	const sync = useGameMutation(serviceId, () =>
		gamesApi.endpoints.sync(endpoint.id),
	);
	const remove = useGameMutation(serviceId, () =>
		gamesApi.endpoints.remove(endpoint.id),
	);
	const tone =
		endpoint.status === "error"
			? "text-bad-text"
			: !endpoint.inSync
				? "text-warn-text"
				: "text-muted-foreground";
	return (
		<li className="grid gap-3 px-4 py-3.5">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<code className="font-mono text-sm font-medium">
					{endpoint.hostname}
				</code>
				<span className={cn("text-xs", tone)}>
					{endpoint.status === "error"
						? (endpoint.statusMessage ?? "Records failed")
						: !endpoint.inSync
							? "The node or port moved; sync the records"
							: providerName
								? `Records written by ${providerName}`
								: "Create these records at your DNS host"}
				</span>
				<span className="ml-auto flex gap-1">
					{endpoint.dnsProviderId && (
						<Button
							variant="ghost"
							size="sm"
							disabled={sync.isPending}
							onClick={() =>
								sync.mutate(undefined, {
									onError: (e) =>
										toast.error("Records weren't synced", {
											description: errorText(e),
										}),
								})
							}
						>
							<RefreshCw className={cn(sync.isPending && "animate-spin")} />
							Sync
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Remove ${endpoint.hostname}`}
						disabled={remove.isPending}
						onClick={() =>
							remove.mutate(undefined, {
								onSuccess: () =>
									toast.success(`${endpoint.hostname} removed`, {
										description: endpoint.dnsProviderId
											? "Its records are gone from the DNS provider."
											: "Delete its records at your DNS host too.",
									}),
							})
						}
					>
						<Trash2 />
					</Button>
				</span>
			</div>
			<div className="overflow-x-auto rounded-lg bg-muted/60 dark:bg-muted/40">
				<table className="w-full text-left font-mono text-xs">
					<tbody>
						{endpoint.records.map((r) => (
							<tr key={r.type} className="align-top">
								<td className="w-14 py-1.5 pl-3 font-sans text-muted-foreground">
									{r.type}
								</td>
								<td className="py-1.5 pr-3 break-all">{r.name}</td>
								<td className="py-1.5 pr-3 break-all">{r.value}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</li>
	);
}

function Hostnames({
	game,
	serviceId,
}: {
	game: GameServer;
	serviceId: string;
}) {
	const providers = useQuery(dnsProvidersQuery);
	const [hostname, setHostname] = useState("");
	const [provider, setProvider] = useState<string>("__manual");
	const add = useGameMutation(serviceId, () =>
		gamesApi.endpoints.create(serviceId, {
			hostname: hostname.trim().toLowerCase(),
			dnsProviderId: provider === "__manual" ? null : provider,
		}),
	);
	const name = (id: string | null) =>
		id
			? (providers.data?.find((p) => p.id === id)?.name ?? "the provider")
			: null;
	const srv = GAMES[game.game].srv;
	return (
		<Panel
			title="Hostnames"
			id="game-hostnames"
			actions={
				<span className="text-xs text-muted-foreground">
					DNS only{srv ? `, SRV _${srv.service}._${srv.proto}` : ""}
				</span>
			}
		>
			{game.endpoints.length > 0 && (
				<ul className="divide-y border-b">
					{game.endpoints.map((e) => (
						<EndpointRow
							key={e.id}
							endpoint={e}
							serviceId={serviceId}
							providerName={name(e.dnsProviderId)}
						/>
					))}
				</ul>
			)}
			<form
				className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto]"
				onSubmit={(e) => {
					e.preventDefault();
					add.mutate(undefined, {
						onSuccess: () => setHostname(""),
						onError: (err) =>
							toast.error("Hostname not added", {
								description: errorText(err),
							}),
					});
				}}
			>
				<label htmlFor="game-hostname" className="sr-only">
					Hostname
				</label>
				<Input
					id="game-hostname"
					value={hostname}
					onChange={(e) => setHostname(e.target.value)}
					placeholder="play.example.com"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
				/>
				<Select value={provider} onValueChange={setProvider}>
					<SelectTrigger aria-label="Who writes the records" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="__manual">Records by hand</SelectItem>
						{(providers.data ?? []).map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					type="submit"
					variant="secondary"
					disabled={!hostname.trim() || add.isPending}
				>
					{add.isPending && <Loader2 className="animate-spin" />}
					Add hostname
				</Button>
			</form>
		</Panel>
	);
}

function Ports({ game }: { game: GameServer }) {
	return (
		<Panel title="Ports" id="game-ports">
			<dl className="divide-y text-sm">
				{game.ports.map((p) => (
					<div
						key={`${p.published}/${p.protocol}`}
						className="flex items-center justify-between gap-3 px-4 py-2.5"
					>
						<dt className="text-muted-foreground">{p.label}</dt>
						<dd className="font-mono text-xs">
							{p.published}/{p.protocol}
						</dd>
					</div>
				))}
				<div className="flex items-center justify-between gap-3 px-4 py-2.5">
					<dt className="text-muted-foreground">Node</dt>
					<dd className="truncate">
						{game.node?.hostname || "Pinned on first deploy"}
						{game.address && (
							<span className="ml-2 font-mono text-xs text-muted-foreground">
								{game.address}
							</span>
						)}
					</dd>
				</div>
			</dl>
		</Panel>
	);
}

/** The Game tab: join address, live players, console and hostnames of one game server. */
export function ServiceGame({ service }: { service: ServiceOverview }) {
	const game = useQuery(gameQuery(service.id));
	if (game.isPending)
		return (
			<div className="grid gap-4">
				<div className="h-36 rounded-xl bg-card ring-1 ring-border" aria-hidden>
					<SkeletonRows rows={2} />
				</div>
			</div>
		);
	if (game.isError)
		return (
			<EmptyState
				icon={Lock}
				title="The game server didn't answer"
				description={errorText(game.error)}
			/>
		);
	const g = game.data;
	const side: ReactNode[] = [
		<Players key="players" game={g} />,
		<Access key="access" game={g} serviceId={service.id} />,
		<Ports key="ports" game={g} />,
	];
	return (
		<div className="grid gap-6">
			<JoinCard game={g} service={service} />
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<div className="grid min-w-0 gap-6">
					{g.console && <Console serviceId={service.id} game={g.game} />}
					<Hostnames game={g} serviceId={service.id} />
				</div>
				<div className="grid min-w-0 gap-6">{side}</div>
			</div>
		</div>
	);
}

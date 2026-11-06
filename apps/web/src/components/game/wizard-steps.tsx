import {
	CS2_MODES,
	type Cs2Mode,
	cs2Modes,
	GAMES,
	type GameKind,
	type GameSettings,
	gameKinds,
	gamePorts,
	gameRecords,
	type MinecraftFlavour,
	minecraftFlavours,
	playerAddress,
	primaryPort,
} from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cpu, HardDrive } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { z } from "zod";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	ChoiceGroup,
	Instructions,
	type SummarySection,
} from "@/components/wizard/parts";
import type {
	WizardApi,
	WizardStep,
	WizardValues,
} from "@/components/wizard/wizard";
import { gamePortQuery, minecraftVersionsQuery } from "@/lib/api/games";
import { instanceStatusQuery } from "@/lib/api/instance";
import { nodesQuery } from "@/lib/api/monitoring";
import { dnsProvidersQuery } from "@/lib/api/networking";
import { cn } from "@/lib/utils";
import { gameMark } from "./game-meta";

export type AddressMode = "none" | "dns" | "manual";

/** The answers the game branch of the new-service wizard owns. */
export type GameFields = {
	game: GameKind;
	mcFlavour: MinecraftFlavour;
	mcVersion: string;
	bedrockVersion: string;
	motd: string;
	maxPlayers: string;
	difficulty: "peaceful" | "easy" | "normal" | "hard";
	gamemode: "survival" | "creative" | "adventure";
	onlineMode: boolean;
	whitelist: boolean;
	pvp: boolean;
	allowCheats: boolean;
	seed: string;
	geyser: boolean;
	eula: boolean;
	csMode: Cs2Mode;
	csMap: string;
	workshop: string;
	privateServer: boolean;
	/** Secret: never persisted by the wizard. */
	gameToken: string;
	license: boolean;
	welcomeText: string;
	gameNode: string;
	gamePort: string;
	gameMemory: string;
	addressMode: AddressMode;
	dnsProviderId: string;
	gameHostname: string;
};
export type GameValues = WizardValues &
	GameFields & { kind: string; name: string };

export const GAME_DEFAULTS = {
	game: "minecraft-java",
	mcFlavour: "paper",
	mcVersion: "LATEST",
	bedrockVersion: "LATEST",
	motd: "",
	maxPlayers: "20",
	difficulty: "normal",
	gamemode: "survival",
	onlineMode: true,
	whitelist: true,
	pvp: true,
	allowCheats: false,
	seed: "",
	geyser: false,
	eula: false,
	csMode: "competitive",
	csMap: "de_dust2",
	workshop: "",
	privateServer: false,
	gameToken: "",
	license: false,
	welcomeText: "",
	gameNode: "",
	gamePort: "",
	gameMemory: "",
	addressMode: "none",
	dnsProviderId: "",
	gameHostname: "",
} as const satisfies GameFields;

export const GAME_SECRET_KEYS = ["gameToken"] as const;

const FLAVOUR: Record<MinecraftFlavour, string> = {
	vanilla: "Vanilla",
	paper: "Paper",
	fabric: "Fabric",
	forge: "Forge",
	neoforge: "NeoForge",
};

const n = (s: string, fallback: number) => Number.parseInt(s, 10) || fallback;

/** The display name the server shows in lists: the MOTD, server name or service name. */
const displayName = (v: GameValues, fallback: string) =>
	v.motd.trim() || fallback;

/** What `GameSpec.settings` gets from the answers. */
export function gameSettings(v: GameValues, name: string): GameSettings {
	switch (v.game) {
		case "minecraft-java":
			return {
				game: "minecraft-java",
				eula: true,
				flavour: v.mcFlavour,
				version: v.mcVersion,
				motd: displayName(v, name),
				maxPlayers: n(v.maxPlayers, 20),
				difficulty: v.difficulty,
				gamemode: v.gamemode,
				onlineMode: v.onlineMode,
				whitelist: v.whitelist,
				pvp: v.pvp,
				...(v.seed.trim() ? { seed: v.seed.trim() } : {}),
				...(v.mcFlavour === "paper" && v.geyser ? { geyser: true } : {}),
			};
		case "minecraft-bedrock":
			return {
				game: "minecraft-bedrock",
				eula: true,
				version: v.bedrockVersion,
				serverName: displayName(v, name),
				maxPlayers: n(v.maxPlayers, 10),
				difficulty: v.difficulty,
				gamemode: v.gamemode,
				allowCheats: v.allowCheats,
				allowList: v.whitelist,
				onlineMode: v.onlineMode,
			};
		case "cs2":
			return {
				game: "cs2",
				serverName: displayName(v, name),
				maxPlayers: n(v.maxPlayers, 10),
				mode: v.csMode,
				map: v.csMap.trim(),
				...(v.workshop.trim() ? { workshopCollection: v.workshop.trim() } : {}),
				private: v.privateServer,
			};
		case "teamspeak3":
			return { game: "teamspeak3", license: true };
		case "mumble":
			return {
				game: "mumble",
				serverName: displayName(v, name),
				welcomeText: v.welcomeText.trim(),
				maxUsers: n(v.maxPlayers, 50),
				private: v.privateServer,
			};
	}
}

export const gamePortOf = (v: GameValues) => n(v.gamePort, primaryPort(v.game));

export const gameMemoryOf = (v: GameValues) =>
	n(v.gameMemory, GAMES[v.game].memoryMb);

/** One section with a heading inside a step: groups fields without nesting cards. */
function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<fieldset className="grid gap-4">
			<legend className="mb-1 text-sm font-medium">{title}</legend>
			{children}
		</fieldset>
	);
}

function Toggle<V extends GameValues>({
	w,
	k,
	title,
	description,
}: {
	w: WizardApi<V>;
	k:
		| "onlineMode"
		| "whitelist"
		| "pvp"
		| "allowCheats"
		| "geyser"
		| "privateServer";
	title: string;
	description: string;
}) {
	const id = `wz-${k}`;
	return (
		<label
			htmlFor={id}
			className="flex items-center justify-between gap-4 py-3 text-sm"
		>
			<span>
				<span className="block font-medium">{title}</span>
				<span className="text-muted-foreground">{description}</span>
			</span>
			<Switch
				id={id}
				checked={w.values[k] as boolean}
				onCheckedChange={(c) => w.set(k, c as V[typeof k])}
			/>
		</label>
	);
}

/** A checkbox the user must tick themselves: licences are never accepted on their behalf. */
function Consent<V extends GameValues>({
	w,
	k,
	children,
}: {
	w: WizardApi<V>;
	k: "eula" | "license";
	children: ReactNode;
}) {
	const error = w.error(k);
	return (
		<div className="grid gap-1.5">
			<label
				htmlFor={`wz-${k}`}
				className={cn(
					"flex items-start gap-3 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40",
					error && "ring-1 ring-bad",
				)}
			>
				<Checkbox
					id={`wz-${k}`}
					className="mt-0.5"
					checked={w.values[k] as boolean}
					onCheckedChange={(c) => w.set(k, (c === true) as V[typeof k])}
					aria-invalid={error ? true : undefined}
					aria-labelledby={`wz-${k}-text`}
					aria-describedby={`wz-${k}-msg`}
				/>
				<span id={`wz-${k}-text`} className="text-pretty">
					{children}
				</span>
			</label>
			<p id={`wz-${k}-msg`} className="text-xs text-bad-text" role="alert">
				{error}
			</p>
		</div>
	);
}

function PlainSelect<T extends string>({
	id,
	value,
	onChange,
	options,
}: {
	id: string;
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<Select value={value} onValueChange={(v) => onChange(v as T)}>
			<SelectTrigger id={id} className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"] as const;
const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);

function MinecraftVersion<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const versions = useQuery(minecraftVersionsQuery);
	const list = versions.data?.versions ?? [];
	const options = [
		{ value: "LATEST", label: "Latest release" },
		...[...new Set([w.values.mcVersion, ...list])]
			.filter((v) => v && v !== "LATEST")
			.map((v) => ({ value: v, label: v })),
	];
	return (
		<Field
			id="wz-mcVersion"
			label="Version"
			hint={
				versions.isError
					? "Mojang's version list didn't load; Latest release still works."
					: "Latest follows each new release on restart. Pin one to keep mods working."
			}
		>
			<PlainSelect
				id="wz-mcVersion"
				value={w.values.mcVersion}
				onChange={(v) => w.set("mcVersion", v as V["mcVersion"])}
				options={options}
			/>
		</Field>
	);
}

function MinecraftJavaForm<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	return (
		<div className="grid gap-8">
			<Group title="Server">
				<Field id="wz-mcFlavour" label="Software">
					<Segmented
						label="Server software"
						value={v.mcFlavour}
						onChange={(f) => w.set("mcFlavour", f as V["mcFlavour"])}
						options={minecraftFlavours.map((f) => ({
							value: f,
							label: FLAVOUR[f],
						}))}
					/>
				</Field>
				<p className="-mt-2 text-xs text-muted-foreground text-pretty">
					{v.mcFlavour === "vanilla"
						? "Mojang's own server, no plugins or mods."
						: v.mcFlavour === "paper"
							? "Fast vanilla-compatible server with Bukkit and Paper plugins."
							: `Mod loader: drop ${FLAVOUR[v.mcFlavour]} mods into /data/mods from the Files tab.`}
				</p>
				<MinecraftVersion w={w} />
			</Group>
			<CommonWorld w={w} />
			<Group title="Players">
				<div className="divide-y">
					<Toggle
						w={w}
						k="whitelist"
						title="Whitelist"
						description="Only players you add can join. Add them from the console."
					/>
					<Toggle
						w={w}
						k="onlineMode"
						title="Online mode"
						description="Players sign in with a Microsoft account. Turn off only for offline LAN play."
					/>
					<Toggle
						w={w}
						k="pvp"
						title="PvP"
						description="Players can hurt each other."
					/>
					{v.mcFlavour === "paper" && (
						<Toggle
							w={w}
							k="geyser"
							title="Bedrock players"
							description="Adds Geyser and Floodgate so phones and consoles join too, on an extra UDP port."
						/>
					)}
				</div>
			</Group>
			<Consent w={w} k="eula">
				I accept the{" "}
				<a
					href="https://www.minecraft.net/eula"
					target="_blank"
					rel="noreferrer"
					className="font-medium underline underline-offset-2"
				>
					Minecraft End User License Agreement
				</a>
				. The server will not start without it.
			</Consent>
		</div>
	);
}

/** World and player-count fields both Minecraft editions share. */
function CommonWorld<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const java = v.game === "minecraft-java";
	return (
		<Group title="World">
			<Field
				id="wz-motd"
				label={java ? "Message of the day" : "Server name"}
				optional
				error={w.error("motd")}
				hint="Shown in the server list. Defaults to the service name."
			>
				<Input {...w.bind("motd")} maxLength={120} />
			</Field>
			<div className="grid gap-4 sm:grid-cols-3">
				<Field id="wz-gamemode" label="Game mode">
					<PlainSelect
						id="wz-gamemode"
						value={v.gamemode}
						onChange={(g) => w.set("gamemode", g as V["gamemode"])}
						options={(["survival", "creative", "adventure"] as const).map(
							(g) => ({ value: g, label: cap(g) }),
						)}
					/>
				</Field>
				<Field id="wz-difficulty" label="Difficulty">
					<PlainSelect
						id="wz-difficulty"
						value={v.difficulty}
						onChange={(d) => w.set("difficulty", d as V["difficulty"])}
						options={DIFFICULTIES.map((d) => ({ value: d, label: cap(d) }))}
					/>
				</Field>
				<Field
					id="wz-maxPlayers"
					label="Max players"
					error={w.error("maxPlayers")}
				>
					<Input
						{...w.bind("maxPlayers")}
						inputMode="numeric"
						className="tabular"
					/>
				</Field>
			</div>
			{java && (
				<Field
					id="wz-seed"
					label="Seed"
					optional
					hint="Leave empty for a random world."
				>
					<Input {...w.bind("seed")} className="font-mono" spellCheck={false} />
				</Field>
			)}
		</Group>
	);
}

function BedrockForm<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	return (
		<div className="grid gap-8">
			<Group title="Server">
				<Field
					id="wz-bedrockVersion"
					label="Version"
					hint="Latest updates on restart; Bedrock clients only join a server on their own version."
				>
					<PlainSelect
						id="wz-bedrockVersion"
						value={w.values.bedrockVersion}
						onChange={(b) => w.set("bedrockVersion", b as V["bedrockVersion"])}
						options={[
							{ value: "LATEST", label: "Latest release" },
							{ value: "PREVIEW", label: "Preview" },
						]}
					/>
				</Field>
			</Group>
			<CommonWorld w={w} />
			<Group title="Players">
				<div className="divide-y">
					<Toggle
						w={w}
						k="whitelist"
						title="Allow list"
						description="Only players you add can join."
					/>
					<Toggle
						w={w}
						k="onlineMode"
						title="Xbox sign-in"
						description="Players sign in with an Xbox account."
					/>
					<Toggle
						w={w}
						k="allowCheats"
						title="Cheats"
						description="Players with permission can run commands."
					/>
				</div>
			</Group>
			<Consent w={w} k="eula">
				I accept the{" "}
				<a
					href="https://www.minecraft.net/eula"
					target="_blank"
					rel="noreferrer"
					className="font-medium underline underline-offset-2"
				>
					Minecraft End User License Agreement
				</a>{" "}
				and the{" "}
				<a
					href="https://privacy.microsoft.com/privacystatement"
					target="_blank"
					rel="noreferrer"
					className="font-medium underline underline-offset-2"
				>
					Microsoft Privacy Policy
				</a>
				.
			</Consent>
		</div>
	);
}

function Cs2Form<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	return (
		<div className="grid gap-8">
			<Group title="Server">
				<Field
					id="wz-motd"
					label="Server name"
					optional
					hint="Shown in the community server browser. Defaults to the service name."
				>
					<Input {...w.bind("motd")} maxLength={120} />
				</Field>
				<Field id="wz-csMode" label="Game mode">
					<Segmented
						label="Game mode"
						value={v.csMode}
						onChange={(m) => {
							w.set("csMode", m as V["csMode"]);
							w.set(
								"maxPlayers",
								(m === "wingman"
									? "4"
									: m === "deathmatch"
										? "16"
										: "10") as V["maxPlayers"],
							);
						}}
						options={cs2Modes.map((m) => ({
							value: m,
							label: CS2_MODES[m].label,
						}))}
					/>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="wz-csMap" label="Start map" error={w.error("csMap")}>
						<Input
							{...w.bind("csMap")}
							className="font-mono"
							spellCheck={false}
						/>
					</Field>
					<Field
						id="wz-maxPlayers"
						label="Max players"
						error={w.error("maxPlayers")}
					>
						<Input
							{...w.bind("maxPlayers")}
							inputMode="numeric"
							className="tabular"
						/>
					</Field>
				</div>
				<Field
					id="wz-workshop"
					label="Workshop collection"
					optional
					error={w.error("workshop")}
					hint="A Steam Workshop collection ID; its maps load on the server."
				>
					<Input
						{...w.bind("workshop")}
						inputMode="numeric"
						className="font-mono"
					/>
				</Field>
				<div className="divide-y">
					<Toggle
						w={w}
						k="privateServer"
						title="Password"
						description="Players type a password LogiStack generates. Find it in the Game tab."
					/>
				</div>
			</Group>
			<Group title="Steam">
				<Field
					id="wz-gameToken"
					label="Game Server Login Token"
					error={w.error("gameToken")}
				>
					<Input
						{...w.bind("gameToken")}
						type="password"
						autoComplete="off"
						className="font-mono"
						spellCheck={false}
					/>
				</Field>
				<Instructions
					href="https://steamcommunity.com/dev/managegameservers"
					link="Create a token on Steam"
				>
					<p>
						Valve lists a public server only with a token. Create one for{" "}
						<strong>App ID 730</strong> and paste it here. LogiStack stores it
						encrypted and never shows it again.
					</p>
				</Instructions>
			</Group>
		</div>
	);
}

function MumbleForm<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	return (
		<Group title="Server">
			<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
				<Field
					id="wz-motd"
					label="Server name"
					optional
					hint="Defaults to the service name."
				>
					<Input {...w.bind("motd")} maxLength={120} />
				</Field>
				<Field
					id="wz-maxPlayers"
					label="Max users"
					error={w.error("maxPlayers")}
				>
					<Input
						{...w.bind("maxPlayers")}
						inputMode="numeric"
						className="tabular"
					/>
				</Field>
			</div>
			<Field
				id="wz-welcomeText"
				label="Welcome message"
				optional
				error={w.error("welcomeText")}
				hint="Shown to everyone who connects. Basic HTML works."
			>
				<Textarea {...w.bind("welcomeText")} rows={3} maxLength={500} />
			</Field>
			<div className="divide-y">
				<Toggle
					w={w}
					k="privateServer"
					title="Password"
					description="People type a password LogiStack generates. Find it in the Game tab."
				/>
			</div>
		</Group>
	);
}

function TeamspeakForm<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	return (
		<div className="grid gap-6">
			<Instructions>
				<p>
					Without a license file TeamSpeak runs one virtual server with up to{" "}
					<strong>32 slots</strong>, free for non-commercial use. After the
					first start, create a <strong>Server Admin key</strong> from the Game
					tab and use it once in your client to become admin.
				</p>
			</Instructions>
			<Consent w={w} k="license">
				I accept the{" "}
				<a
					href="https://teamspeak.com/en/features/licensing/"
					target="_blank"
					rel="noreferrer"
					className="font-medium underline underline-offset-2"
				>
					TeamSpeak server license agreement
				</a>
				.
			</Consent>
		</div>
	);
}

/** The free primary port on the chosen node, filled in once and then left to the user. */
function PortSuggestion<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const suggestion = useQuery(
		gamePortQuery(v.game, v.gameNode || undefined, v.geyser),
	);
	const port = suggestion.data?.port;
	useEffect(() => {
		if (!v.gamePort && port) w.set("gamePort", String(port) as V["gamePort"]);
	}, [port, v.gamePort, w]);
	return null;
}

function HostStep<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const info = GAMES[v.game];
	const nodes = useQuery(nodesQuery);
	const ports = gamePorts(
		{ game: v.game, geyser: v.mcFlavour === "paper" && v.geyser },
		gamePortOf(v),
	);

	return (
		<div className="grid gap-6">
			<PortSuggestion w={w} />
			{(nodes.data?.length ?? 0) > 1 && (
				<Field
					id="wz-gameNode"
					label="Node"
					hint="Players connect to this node's address, and the world stays on its disk."
				>
					<PlainSelect
						id="wz-gameNode"
						value={v.gameNode || "__auto"}
						onChange={(id) => {
							w.set("gameNode", (id === "__auto" ? "" : id) as V["gameNode"]);
							w.set("gamePort", "" as V["gamePort"]);
						}}
						options={[
							{ value: "__auto", label: "The manager node" },
							...(nodes.data ?? []).map((node) => ({
								value: node.id,
								label: `${node.hostname} · ${node.address}`,
							})),
						]}
					/>
				</Field>
			)}
			<div className="grid gap-4 sm:grid-cols-2">
				<Field
					id="wz-gamePort"
					label="Port"
					error={w.error("gamePort")}
					hint={
						gamePortOf(v) === primaryPort(v.game)
							? `The default ${info.label} port.`
							: info.srv
								? "Not the default: the SRV record carries it, so players still type only the hostname."
								: "Not the default: players type it after the address."
					}
				>
					<Input
						{...w.bind("gamePort")}
						inputMode="numeric"
						className="font-mono tabular"
						placeholder={String(primaryPort(v.game))}
					/>
				</Field>
				<Field
					id="wz-gameMemory"
					label="Memory limit"
					error={w.error("gameMemory")}
					hint={
						v.game === "minecraft-java"
							? "Java gets three quarters of it as heap."
							: "The container is stopped if it uses more."
					}
				>
					<div className="relative">
						<Input
							{...w.bind("gameMemory")}
							inputMode="numeric"
							className="pr-10 tabular"
							placeholder={String(info.memoryMb)}
						/>
						<span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-xs text-muted-foreground">
							MB
						</span>
					</div>
				</Field>
			</div>
			<dl className="grid gap-x-6 gap-y-2 rounded-lg bg-muted/60 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] dark:bg-muted/40">
				<dt className="text-muted-foreground">Published</dt>
				<dd className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs leading-5">
					{ports.map((p) => (
						<span key={`${p.published}/${p.protocol}`}>
							{p.published}/{p.protocol}
						</span>
					))}
				</dd>
				<dt className="text-muted-foreground">Disk</dt>
				<dd className="flex items-center gap-1.5">
					<HardDrive className="size-3.5 text-muted-foreground" aria-hidden />
					<span className="tabular">{info.diskGb} GB</span>
					<span className="text-muted-foreground">
						{v.game === "cs2"
							? "downloaded by SteamCMD on the first start, which takes a while"
							: "to start, growing with the world and logs"}
					</span>
				</dd>
				{info.amd64Only && (
					<>
						<dt className="text-muted-foreground">Architecture</dt>
						<dd className="flex items-center gap-1.5">
							<Cpu className="size-3.5 text-muted-foreground" aria-hidden />
							x86_64 only: the image has no ARM build.
						</dd>
					</>
				)}
			</dl>
			<p className="text-sm text-muted-foreground text-pretty">
				Open {ports.map((p) => `${p.published}/${p.protocol}`).join(", ")} in
				the node's firewall or cloud security group. LogiStack does not manage
				host firewalls.
			</p>
		</div>
	);
}

function RecordsPreview({
	game,
	hostname,
	address,
	port,
}: {
	game: GameKind;
	hostname: string;
	address: string;
	port: number;
}) {
	const records = gameRecords(
		game,
		hostname || "play.example.com",
		address,
		port,
	);
	return (
		<div className="overflow-x-auto rounded-lg ring-1 ring-border">
			<table className="w-full text-left text-xs">
				<thead className="text-muted-foreground">
					<tr className="border-b">
						<th className="px-3 py-2 font-medium">Type</th>
						<th className="px-3 py-2 font-medium">Name</th>
						<th className="px-3 py-2 font-medium">Value</th>
						<th className="px-3 py-2 font-medium">Proxy</th>
					</tr>
				</thead>
				<tbody className="divide-y font-mono">
					{records.map((r) => (
						<tr key={r.type}>
							<td className="px-3 py-2">{r.type}</td>
							<td className="px-3 py-2 break-all">{r.name}</td>
							<td className="px-3 py-2 break-all">{r.value}</td>
							<td className="px-3 py-2 font-sans text-muted-foreground">
								DNS only
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function AddressStep<V extends GameValues>({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const info = GAMES[v.game];
	const providers = useQuery(dnsProvidersQuery);
	const status = useQuery(instanceStatusQuery);
	const address = status.data?.publicIp ?? "203.0.113.10";
	const port = gamePortOf(v);
	const host = v.gameHostname.trim().toLowerCase();
	const zones = (providers.data ?? []).find(
		(p) => p.id === v.dnsProviderId,
	)?.zones;
	return (
		<div className="grid gap-6">
			<Segmented
				label="Hostname"
				value={v.addressMode}
				onChange={(m) => w.set("addressMode", m as V["addressMode"])}
				options={[
					{ value: "none", label: "IP address only" },
					{ value: "dns", label: "Hostname via DNS provider" },
					{ value: "manual", label: "Hostname, records by hand" },
				]}
			/>
			{v.addressMode === "none" ? (
				<p className="text-sm text-muted-foreground text-pretty">
					Players join at{" "}
					<span className="font-mono text-xs text-foreground">
						{playerAddress(v.game, address, port, false)}
					</span>
					. Add a hostname later from the Game tab.
				</p>
			) : (
				<>
					{v.addressMode === "dns" && (
						<Field
							id="wz-dnsProviderId"
							label="DNS provider"
							error={w.error("dnsProviderId")}
							hint={
								providers.data?.length === 0
									? "No DNS provider is connected. Add one under Integrations, or write the records by hand."
									: undefined
							}
						>
							<PlainSelect
								id="wz-dnsProviderId"
								value={v.dnsProviderId}
								onChange={(id) =>
									w.set("dnsProviderId", id as V["dnsProviderId"])
								}
								options={(providers.data ?? []).map((p) => ({
									value: p.id,
									label: p.name,
								}))}
							/>
						</Field>
					)}
					<Field
						id="wz-gameHostname"
						label="Hostname"
						error={w.error("gameHostname")}
						hint={
							zones?.length
								? `In ${zones.map((z) => z.name).join(", ")}.`
								: undefined
						}
					>
						<Input
							{...w.bind("gameHostname")}
							placeholder="play.example.com"
							autoCapitalize="none"
							spellCheck={false}
							className="font-mono"
						/>
					</Field>
					<RecordsPreview
						game={v.game}
						hostname={host}
						address={address}
						port={port}
					/>
					<div className="flex gap-3 rounded-lg bg-warn/10 px-4 py-3 text-sm">
						<AlertTriangle
							className="mt-0.5 size-4 shrink-0 text-warn-text"
							aria-hidden
						/>
						<p className="text-pretty">
							<span className="font-medium">These records stay DNS-only.</span>{" "}
							<span className="text-muted-foreground">
								Cloudflare's proxy and Tunnel carry web traffic, not{" "}
								{info.label}, so the node's IP is public. The SRV record is what
								lets players skip the port.
								{!info.srv &&
									` ${info.label} ignores SRV, so on port ${port} players type ${playerAddress(v.game, host || "play.example.com", port, true)}.`}
							</span>
						</p>
					</div>
				</>
			)}
		</div>
	);
}

const hostnameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
		"Use a hostname like play.example.com",
	);
const intIn = (min: number, max: number, msg: string) =>
	z
		.string()
		.regex(/^\d*$/, "Use a number.")
		.refine((s) => !s || (Number(s) >= min && Number(s) <= max), msg);

/** The steps after "Choose a source" when it is a game server. */
export function gameSteps<V extends GameValues>({
	nameField,
}: {
	nameField: (w: WizardApi<V>) => ReactNode;
}): WizardStep<V>[] {
	const isGame = (v: V) => v.kind === "game";
	const group = (g: "game" | "voice") =>
		gameKinds
			.filter((k) => GAMES[k].group === g)
			.map((k) => ({
				value: k,
				title: GAMES[k].label,
				description: GAMES[k].summary,
				icon: gameMark(k),
			}));
	return [
		{
			id: "game",
			title: "Choose a server",
			description:
				"LogiStack runs it on one node, keeps its data on a volume and gives it its own console.",
			when: isGame,
			render: (w) => {
				const pick = (g: GameKind) => {
					w.set("game", g as V["game"]);
					w.set("gamePort", "" as V["gamePort"]);
					w.set(
						"maxPlayers",
						String(
							g === "mumble" ? 50 : g === "cs2" ? 10 : 20,
						) as V["maxPlayers"],
					);
				};
				return (
					<div className="grid gap-6">
						<section className="grid gap-2" aria-labelledby="wz-games">
							<h3 id="wz-games" className="text-sm font-medium">
								Games
							</h3>
							<ChoiceGroup
								label="Game"
								value={
									GAMES[w.values.game].group === "game"
										? w.values.game
										: undefined
								}
								onChange={pick}
								choices={group("game")}
							/>
						</section>
						<section className="grid gap-2" aria-labelledby="wz-voice">
							<h3 id="wz-voice" className="text-sm font-medium">
								Voice
							</h3>
							<ChoiceGroup
								label="Voice server"
								value={
									GAMES[w.values.game].group === "voice"
										? w.values.game
										: undefined
								}
								onChange={pick}
								choices={group("voice")}
							/>
						</section>
						{nameField(w)}
					</div>
				);
			},
		},
		{
			id: "game-settings",
			title: "Settings",
			description:
				"Change them later from the service settings; a restart applies them.",
			when: isGame,
			schema: (v) =>
				z.object({
					motd: z.string().max(120),
					...(v.game === "teamspeak3"
						? {
								license: z.literal(true, {
									error: "Accept the license to continue.",
								}),
							}
						: {
								maxPlayers: intIn(
									v.game === "cs2" ? 2 : 1,
									v.game === "cs2" ? 64 : 1000,
									v.game === "cs2" ? "From 2 to 64." : "From 1 to 1000.",
								),
							}),
					...(v.game.startsWith("minecraft")
						? {
								eula: z.literal(true, {
									error: "Accept the EULA to continue.",
								}),
							}
						: {}),
					...(v.game === "cs2"
						? {
								csMap: z
									.string()
									.trim()
									.regex(/^[a-z0-9_]{2,64}$/, "A map like de_dust2."),
								workshop: z
									.string()
									.trim()
									.regex(/^\d{0,20}$/, "Digits only."),
								gameToken: z
									.string()
									.trim()
									.regex(
										/^[A-Za-z0-9]{16,64}$/,
										"Paste the 32-character token from Steam.",
									),
							}
						: {}),
				}),
			render: (w) =>
				w.values.game === "minecraft-java" ? (
					<MinecraftJavaForm w={w} />
				) : w.values.game === "minecraft-bedrock" ? (
					<BedrockForm w={w} />
				) : w.values.game === "cs2" ? (
					<Cs2Form w={w} />
				) : w.values.game === "mumble" ? (
					<MumbleForm w={w} />
				) : (
					<TeamspeakForm w={w} />
				),
		},
		{
			id: "game-host",
			title: "Node, port and memory",
			description:
				"Ports are published on the node itself, so players' real IPs reach the server.",
			when: isGame,
			schema: z.object({
				gamePort: intIn(1024, 65535, "Ports go from 1024 to 65535."),
				gameMemory: intIn(256, 262144, "From 256 MB."),
			}),
			render: (w) => <HostStep w={w} />,
		},
		{
			id: "game-address",
			title: "Address",
			description: "How players find the server.",
			when: isGame,
			schema: (v) =>
				z.object({
					gameHostname: v.addressMode === "none" ? z.string() : hostnameSchema,
					dnsProviderId:
						v.addressMode === "dns"
							? z.string().min(1, "Choose a DNS provider.")
							: z.string(),
				}),
			render: (w) => <AddressStep w={w} />,
		},
	];
}

/** Review rows for the game branch. */
export function gameSummary<V extends GameValues>(
	v: V,
	name: string,
	envName: string,
	providerName: (id: string) => string,
): SummarySection[] {
	const info = GAMES[v.game];
	const s = gameSettings(v, name);
	const port = gamePortOf(v);
	const detail =
		s.game === "minecraft-java"
			? `${FLAVOUR[s.flavour]} ${s.version === "LATEST" ? "latest" : s.version}, ${s.gamemode}, ${s.difficulty}`
			: s.game === "minecraft-bedrock"
				? `${s.version === "LATEST" ? "Latest" : s.version}, ${s.gamemode}, ${s.difficulty}`
				: s.game === "cs2"
					? `${CS2_MODES[s.mode].label} on ${s.map}`
					: s.game === "mumble"
						? `Up to ${s.maxUsers} users`
						: "32 slots, no license file";
	return [
		{
			stepId: "game",
			title: "Server",
			rows: [
				{ label: "Name", value: name },
				{ label: "Environment", value: envName },
				{ label: "Server", value: info.label },
				{ label: "Settings", value: detail },
				...("private" in s && s.private
					? [{ label: "Password", value: "Generated" }]
					: []),
			],
		},
		{
			stepId: "game-host",
			title: "Node and port",
			rows: [
				{
					label: "Ports",
					value: (
						<span className="font-mono text-xs">
							{gamePorts(s, port)
								.map((p) => `${p.published}/${p.protocol}`)
								.join(", ")}
						</span>
					),
				},
				{
					label: "Memory",
					value: <span className="tabular">{gameMemoryOf(v)} MB</span>,
				},
			],
		},
		{
			stepId: "game-address",
			title: "Address",
			rows: [
				{
					label: "Players type",
					value:
						v.addressMode === "none" ? (
							"The node's IP address"
						) : (
							<span className="font-mono text-xs">
								{playerAddress(
									v.game,
									v.gameHostname.trim().toLowerCase(),
									port,
									true,
								)}
							</span>
						),
				},
				...(v.addressMode === "none"
					? []
					: [
							{
								label: "Records",
								value:
									v.addressMode === "dns"
										? `Written by ${providerName(v.dnsProviderId)}, DNS only`
										: "You create them; the Game tab lists them",
							},
						]),
			],
		},
	];
}

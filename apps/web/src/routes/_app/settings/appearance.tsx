import { createFileRoute } from "@tanstack/react-router";
import { Check, Palette, Search } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Segmented } from "@/components/segmented";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useIsSponsor } from "@/lib/api/sponsor";
import { setSponsorGlow, useSponsorGlow } from "@/lib/sponsor-glow";
import { type ThemePreference, useTheme } from "@/lib/theme";
import {
	DEFAULT_THEME,
	resolveTheme,
	THEME_GROUPS,
	THEMES,
	type Tokens,
	themeLabel,
} from "@/lib/themes";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/settings/appearance")({
	staticData: { crumb: "Appearance" },
	component: Appearance,
});

const MODES: { value: ThemePreference; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
	{ value: "system", label: "System" },
];

type Entry = {
	id: string;
	label: string;
	vars: { light: Tokens; dark: Tokens } | null;
};

const toStyle = (t: Tokens | undefined) =>
	Object.fromEntries(
		Object.entries(t ?? {}).map(([k, v]) => [`--${k}`, v]),
	) as CSSProperties;

function Appearance() {
	const { preference, resolved, name, setTheme, setThemeName } = useTheme();
	const { sponsor } = useIsSponsor();
	const glow = useSponsorGlow();
	const [filter, setFilter] = useState("");
	// Resolving every theme once costs a few milliseconds; the page re-renders on each pick.
	const entries = useMemo(
		() =>
			new Map<string, Entry>(
				THEMES.map((t) => [
					t.id,
					{ id: t.id, label: t.label, vars: resolveTheme(t.id) },
				]),
			),
		[],
	);
	const q = filter.trim().toLowerCase();
	const groups = [
		{
			label: null as string | null,
			items: [{ id: DEFAULT_THEME, label: "LogiStack Default", vars: null }],
		},
		...THEME_GROUPS.map((g) => ({
			label: g,
			items: THEMES.filter((t) => t.group === g).map(
				(t) => entries.get(t.id) as Entry,
			),
		})),
	]
		.map((g) => ({
			...g,
			items: g.items.filter(
				(e) =>
					!q ||
					e.label.toLowerCase().includes(q) ||
					g.label?.toLowerCase().includes(q),
			),
		}))
		.filter((g) => g.items.length > 0);

	const pick = (id: string) =>
		setThemeName(id, id === DEFAULT_THEME ? null : resolveTheme(id));

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Appearance"
				description="How LogiStack looks in this browser. Other members keep their own choice."
			/>
			<div className="grid gap-8">
				<Panel id="mode" title="Mode">
					<div className="flex flex-wrap items-center justify-between gap-4 p-4">
						<p className="max-w-[60ch] text-sm text-pretty text-muted-foreground">
							Every theme has a light and a dark variant. System follows your
							operating system.
						</p>
						<Segmented
							label="Mode"
							value={preference}
							onChange={setTheme}
							options={MODES}
						/>
					</div>
				</Panel>

				{sponsor && (
					<Panel id="sponsor-glow" title="Sponsor glow">
						<div className="flex flex-wrap items-center justify-between gap-4 p-4">
							<label
								htmlFor="sponsor-glow-switch"
								className="max-w-[60ch] cursor-pointer text-sm text-pretty text-muted-foreground"
							>
								A faint rose light in the corner, our thanks for sponsoring.
								Turn it off if you prefer a plain screen.
							</label>
							<Switch
								id="sponsor-glow-switch"
								checked={glow}
								onCheckedChange={setSponsorGlow}
							/>
						</div>
					</Panel>
				)}

				<section aria-labelledby="theme-heading" className="grid gap-4">
					<div className="flex flex-wrap items-end justify-between gap-3">
						<div className="min-w-0">
							<h2
								id="theme-heading"
								className="text-sm font-semibold [font-stretch:100%]"
							>
								Theme
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								{themeLabel(name)}
								{name !== DEFAULT_THEME && (
									<>
										{" · "}
										<button
											type="button"
											onClick={() => pick(DEFAULT_THEME)}
											className="rounded-sm text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
										>
											Back to LogiStack Default
										</button>
									</>
								)}
							</p>
						</div>
						<div className="relative w-full sm:w-64">
							<Search
								aria-hidden
								className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								type="search"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Filter themes"
								aria-label="Filter themes"
								className="pl-8"
							/>
						</div>
					</div>

					{groups.length === 0 ? (
						<EmptyState
							icon={Palette}
							title="No theme matches"
							description={`Nothing is called “${filter.trim()}”. Try a colour such as green or violet.`}
						/>
					) : (
						<div role="radiogroup" aria-label="Theme" className="grid gap-6">
							{groups.map((g) => (
								<div key={g.label ?? "default"} className="grid gap-2.5">
									{g.label && (
										<h3 className="text-xs font-medium text-muted-foreground">
											{g.label}
										</h3>
									)}
									<div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]">
										{g.items.map((e) => (
											<ThemeCard
												key={e.id}
												entry={e}
												mode={resolved}
												selected={e.id === name}
												onSelect={() => pick(e.id)}
											/>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</section>
			</div>
		</Page>
	);
}

/** A radio whose face is a small render of the app in that theme. */
function ThemeCard({
	entry,
	mode,
	selected,
	onSelect,
}: {
	entry: Entry;
	mode: "light" | "dark";
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<label className="group grid cursor-pointer gap-2">
			<input
				type="radio"
				name="theme"
				value={entry.id}
				checked={selected}
				onChange={onSelect}
				className="peer sr-only"
			/>
			<span
				aria-hidden
				// `theme-default` resets to LogiStack's tokens; the inline variables then paint this theme.
				style={toStyle(entry.vars?.[mode])}
				className={cn(
					"theme-default flex h-24 overflow-hidden rounded-xl bg-background ring-1 ring-border transition-[box-shadow,scale] duration-(--duration-fast) group-active:scale-[0.98]",
					"peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
					selected && "ring-2 ring-brand",
				)}
			>
				<span className="grid w-7 content-start gap-1.5 border-r border-sidebar-border bg-sidebar px-1.5 pt-2.5">
					<span className="h-1.5 rounded-full bg-sidebar-primary" />
					<span className="h-1.5 rounded-full bg-sidebar-foreground/25" />
					<span className="h-1.5 rounded-full bg-sidebar-foreground/25" />
				</span>
				<span className="grid flex-1 content-start gap-2 p-2.5">
					<span className="grid gap-1.5 rounded-[calc(var(--radius)*0.75)] bg-card p-2 shadow-card ring-1 ring-border">
						<span className="flex items-center gap-1.5">
							<span className="text-xs leading-none font-semibold text-card-foreground">
								Aa
							</span>
							<span className="h-1 flex-1 rounded-full bg-muted-foreground/30" />
						</span>
						<span className="flex items-center gap-1">
							<span className="size-1.5 rounded-full bg-ok" />
							<span className="size-1.5 rounded-full bg-busy" />
							<span className="size-1.5 rounded-full bg-bad" />
							<span className="ml-auto h-3.5 w-8 rounded-[calc(var(--radius)*0.5)] bg-primary" />
						</span>
					</span>
				</span>
			</span>
			<span className="flex items-center justify-between gap-2 px-0.5 text-sm">
				<span className={cn("truncate", selected && "font-medium")}>
					{entry.label}
				</span>
				{selected && (
					<Check aria-hidden className="size-4 shrink-0 text-brand" />
				)}
			</span>
		</label>
	);
}

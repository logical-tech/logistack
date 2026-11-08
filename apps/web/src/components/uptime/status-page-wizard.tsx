import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { z } from "zod";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
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
import { Instructions, Summary } from "@/components/wizard/parts";
import type { WizardApi, WizardStep } from "@/components/wizard/wizard";
import type { ProjectSummary } from "@/lib/api/types";
import type { Monitor, StatusPage, StatusPageInput } from "@/lib/api/uptime";
import { cn } from "@/lib/utils";

type Section = StatusPageInput["sections"] extends (infer S)[] | undefined
	? S
	: never;

export type PageValues = {
	title: string;
	slug: string;
	slugTouched: boolean;
	description: string;
	projectId: string;
	sections: Section[];
	accent: string;
	appearance: "auto" | "light" | "dark";
	logoUrl: string;
	websiteUrl: string;
	hostname: string;
	historyDays: string;
	published: boolean;
};

export const emptyPage: PageValues = {
	title: "",
	slug: "",
	slugTouched: false,
	description: "",
	projectId: "",
	sections: [{ name: "Services", monitors: [] }],
	accent: "#2563eb",
	appearance: "auto",
	logoUrl: "",
	websiteUrl: "",
	hostname: "",
	historyDays: "90",
	published: true,
};

export function pageValuesOf(p: StatusPage): PageValues {
	return {
		title: p.title,
		slug: p.slug,
		slugTouched: true,
		description: p.description,
		projectId: p.projectId ?? "",
		sections: p.sections,
		accent: p.theme.accent ?? "#2563eb",
		appearance: p.theme.appearance ?? "auto",
		logoUrl: p.theme.logoUrl ?? "",
		websiteUrl: p.theme.websiteUrl ?? "",
		hostname: p.hostname ?? "",
		historyDays: String(p.historyDays),
		published: p.published,
	};
}

export function toPageInput(v: PageValues): StatusPageInput {
	return {
		title: v.title.trim(),
		slug: v.slug,
		description: v.description.trim(),
		projectId: v.projectId || null,
		hostname: v.hostname.trim().toLowerCase() || null,
		sections: v.sections.map((s) => ({
			name: s.name.trim(),
			monitors: s.monitors.map((m) => ({
				monitorId: m.monitorId,
				...(m.label?.trim() && { label: m.label.trim() }),
			})),
		})),
		theme: {
			accent: v.accent,
			appearance: v.appearance,
			...(v.logoUrl.trim() && { logoUrl: v.logoUrl.trim() }),
			...(v.websiteUrl.trim() && { websiteUrl: v.websiteUrl.trim() }),
		},
		historyDays: Number(v.historyDays) as 30 | 60 | 90,
		published: v.published,
	};
}

const slugify = (s: string) =>
	s
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);

const optionalUrl = (protocols: RegExp, what: string) =>
	z
		.string()
		.trim()
		.refine((s) => !s || (protocols.test(s) && URL.canParse(s)), what);

function Basics({
	w,
	projects,
}: {
	w: WizardApi<PageValues>;
	projects: ProjectSummary[];
}) {
	return (
		<div className="grid max-w-xl gap-5">
			<Field
				id="wz-title"
				label="Title"
				error={w.error("title")}
				hint="Usually your product or company name."
			>
				<Input
					id="wz-title"
					value={w.values.title}
					onChange={(e) => {
						w.set("title", e.target.value);
						if (!w.values.slugTouched) w.set("slug", slugify(e.target.value));
					}}
					placeholder="Acme"
					autoFocus
					aria-invalid={!!w.error("title") || undefined}
				/>
			</Field>
			<Field
				id="wz-slug"
				label="Address"
				error={w.error("slug")}
				hint={`Served at ${typeof location === "undefined" ? "" : location.origin}/status/${w.values.slug || "…"}`}
			>
				<Input
					id="wz-slug"
					value={w.values.slug}
					onChange={(e) => {
						w.set("slug", e.target.value.toLowerCase());
						w.set("slugTouched", true);
					}}
					aria-invalid={!!w.error("slug") || undefined}
				/>
			</Field>
			<Field id="wz-description" label="Description" optional>
				<Textarea
					{...w.bind("description")}
					rows={2}
					placeholder="Live status of the Acme shop and API."
				/>
			</Field>
			<Field
				id="wz-projectId"
				label="Project"
				optional
				hint="Who may edit the page: members of this project, or organization admins only."
			>
				<Select
					value={w.values.projectId || "none"}
					onValueChange={(p) => w.set("projectId", p === "none" ? "" : p)}
				>
					<SelectTrigger id="wz-projectId" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">Whole organization</SelectItem>
						{projects.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
		</div>
	);
}

function Sections({
	w,
	monitors,
}: {
	w: WizardApi<PageValues>;
	monitors: Monitor[];
}) {
	const sections = w.values.sections;
	const used = new Set(
		sections.flatMap((s) => s.monitors.map((m) => m.monitorId)),
	);
	const byId = new Map(monitors.map((m) => [m.id, m]));
	const write = (next: Section[]) => w.set("sections", next);
	const edit = (i: number, s: Section) =>
		write(sections.map((x, j) => (j === i ? s : x)));
	return (
		<div className="grid max-w-2xl gap-4">
			{monitors.length === 0 && (
				<Instructions>
					<p>
						No monitors yet. Create one under Uptime first; a page shows
						monitors, not services.
					</p>
				</Instructions>
			)}
			{sections.map((s, i) => {
				const free = monitors.filter((m) => !used.has(m.id));
				return (
					<fieldset
						// biome-ignore lint/suspicious/noArrayIndexKey: sections have no id; order is the identity
						key={i}
						className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-border"
					>
						<div className="flex items-end gap-2">
							<Field id={`sec-${i}`} label="Section" className="flex-1">
								<Input
									id={`sec-${i}`}
									value={s.name}
									onChange={(e) => edit(i, { ...s, name: e.target.value })}
									placeholder="Services"
								/>
							</Field>
							{sections.length > 1 && (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={`Remove section ${s.name || i + 1}`}
									onClick={() => write(sections.filter((_, j) => j !== i))}
								>
									<X />
								</Button>
							)}
						</div>
						{s.monitors.length > 0 && (
							<ul className="grid gap-2">
								{s.monitors.map((m, k) => {
									const mon = byId.get(m.monitorId);
									const move = (d: -1 | 1) => {
										const next = [...s.monitors];
										const [x] = next.splice(k, 1);
										next.splice(k + d, 0, x as Section["monitors"][number]);
										edit(i, { ...s, monitors: next });
									};
									return (
										<li key={m.monitorId} className="flex items-center gap-2">
											<Input
												aria-label={`Public name for ${mon?.name ?? "monitor"}`}
												value={m.label ?? ""}
												placeholder={mon?.name ?? "Deleted monitor"}
												onChange={(e) =>
													edit(i, {
														...s,
														monitors: s.monitors.map((x, j) =>
															j === k ? { ...x, label: e.target.value } : x,
														),
													})
												}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label="Move up"
												disabled={k === 0}
												onClick={() => move(-1)}
											>
												<ArrowUp />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label="Move down"
												disabled={k === s.monitors.length - 1}
												onClick={() => move(1)}
											>
												<ArrowDown />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label={`Remove ${m.label || mon?.name}`}
												onClick={() =>
													edit(i, {
														...s,
														monitors: s.monitors.filter((_, j) => j !== k),
													})
												}
											>
												<X />
											</Button>
										</li>
									);
								})}
							</ul>
						)}
						{free.length > 0 && (
							<Select
								value=""
								onValueChange={(id) =>
									edit(i, {
										...s,
										monitors: [
											...s.monitors,
											{ monitorId: id, label: byId.get(id)?.name ?? "" },
										],
									})
								}
							>
								<SelectTrigger
									className="w-full sm:w-64"
									aria-label={`Add a monitor to ${s.name || "this section"}`}
								>
									<SelectValue placeholder="Add a monitor" />
								</SelectTrigger>
								<SelectContent>
									{free.map((m) => (
										<SelectItem key={m.id} value={m.id}>
											{m.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</fieldset>
				);
			})}
			<div className="flex items-center justify-between gap-3">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => write([...sections, { name: "", monitors: [] }])}
				>
					<Plus data-icon="inline-start" />
					Add section
				</Button>
				<p className="text-xs text-muted-foreground">
					Public names default to the monitor's; change them to hide internal
					names.
				</p>
			</div>
			{w.error("sections") && (
				<p className="text-xs text-bad-text">{w.error("sections")}</p>
			)}
		</div>
	);
}

/** A miniature of the public page, in the chosen accent and appearance. */
function Preview({ v }: { v: PageValues }) {
	const dark = v.appearance === "dark";
	const bars = Array.from({ length: 45 }, (_, i) => ({
		id: `day-${i}`,
		color: i === 31 ? "#ca8a04" : i === 38 ? "#dc2626" : "#16a34a",
	}));
	return (
		<div
			aria-hidden
			className={cn(
				"overflow-hidden rounded-xl p-5 ring-1 ring-border transition-colors duration-(--duration-fast)",
				dark ? "bg-[#0a0a0a] text-[#fafafa]" : "bg-white text-[#0a0a0a]",
			)}
		>
			<div className="mb-3 flex items-center gap-2">
				{v.logoUrl && /^https:\/\//.test(v.logoUrl) && (
					<img src={v.logoUrl} alt="" className="h-5 w-auto" />
				)}
				<span className="text-sm font-semibold">
					{v.title || "Your status page"}
				</span>
			</div>
			<div
				className={cn(
					"mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium",
					dark ? "bg-[#111]" : "bg-[#fafafa]",
				)}
			>
				<span
					className="size-2 rounded-full"
					style={{ background: v.accent }}
				/>
				All systems operational
			</div>
			<p className="mb-1.5 text-xs">
				{v.sections[0]?.monitors[0]?.label || "Website"}
			</p>
			<div className="flex h-5 gap-px">
				{bars.map((b) => (
					<span
						key={b.id}
						className="flex-1 rounded-[1px]"
						style={{ background: b.color }}
					/>
				))}
			</div>
		</div>
	);
}

function Branding({ w }: { w: WizardApi<PageValues> }) {
	return (
		<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
			<div className="grid max-w-xl content-start gap-5">
				<Field
					id="wz-accent"
					label="Accent colour"
					hint="The status dot when everything is up."
					error={w.error("accent")}
				>
					<div className="flex items-center gap-2">
						<input
							type="color"
							aria-label="Pick the accent colour"
							value={w.values.accent}
							onChange={(e) => w.set("accent", e.target.value)}
							className="size-9 cursor-pointer rounded-md bg-transparent"
						/>
						<Input {...w.bind("accent")} className="max-w-32 tabular" />
					</div>
				</Field>
				<Field
					id="wz-appearance"
					label="Appearance"
					hint="Auto follows each visitor's system setting."
				>
					<Segmented
						label="Appearance"
						value={w.values.appearance}
						onChange={(a) => w.set("appearance", a)}
						options={[
							{ value: "auto", label: "Auto" },
							{ value: "light", label: "Light" },
							{ value: "dark", label: "Dark" },
						]}
					/>
				</Field>
				<Field
					id="wz-logoUrl"
					label="Logo URL"
					optional
					hint="An https link to an image, shown beside the title."
					error={w.error("logoUrl")}
				>
					<Input
						{...w.bind("logoUrl")}
						placeholder="https://acme.dev/logo.svg"
					/>
				</Field>
				<Field
					id="wz-websiteUrl"
					label="Website"
					optional
					hint="Linked from the footer."
					error={w.error("websiteUrl")}
				>
					<Input {...w.bind("websiteUrl")} placeholder="https://acme.dev" />
				</Field>
				<Field id="wz-historyDays" label="History">
					<Segmented
						label="Days of history"
						value={w.values.historyDays}
						onChange={(d) => w.set("historyDays", d)}
						options={[
							{ value: "30", label: "30 days" },
							{ value: "60", label: "60 days" },
							{ value: "90", label: "90 days" },
						]}
					/>
				</Field>
			</div>
			<Preview v={w.values} />
		</div>
	);
}

function Domain({ w }: { w: WizardApi<PageValues> }) {
	return (
		<div className="grid max-w-xl gap-5">
			<Field
				id="wz-hostname"
				label="Custom domain"
				optional
				error={w.error("hostname")}
				hint="Leave empty to use the /status address only."
			>
				<Input {...w.bind("hostname")} placeholder="status.acme.dev" />
			</Field>
			<Instructions>
				<p>
					Point the name at this server first: a <strong>CNAME</strong> to this
					dashboard's hostname, or an <strong>A</strong> record to its IP
					address.
				</p>
				<p>
					LogiStack then routes it and obtains the certificate on its own. That
					domain serves the status page only, never the dashboard or the API.
				</p>
			</Instructions>
			<label
				htmlFor="wz-published"
				className="flex cursor-pointer items-start justify-between gap-6 rounded-lg bg-muted/50 px-4 py-3 dark:bg-muted/30"
			>
				<span className="grid gap-0.5">
					<span className="text-sm font-medium">Published</span>
					<span className="text-xs text-muted-foreground">
						Unpublished pages answer 404 to visitors.
					</span>
				</span>
				<Switch
					id="wz-published"
					checked={w.values.published}
					onCheckedChange={(c) => w.set("published", c)}
				/>
			</label>
		</div>
	);
}

export function pageSteps(
	edit: boolean,
	projects: ProjectSummary[],
	monitors: Monitor[],
): WizardStep<PageValues>[] {
	const names = new Map(monitors.map((m) => [m.id, m.name]));
	return [
		{
			id: "basics",
			title: "Basics",
			description: "The page's title and public address.",
			schema: z.object({
				title: z.string().trim().min(1, "Give the page a title.").max(100),
				slug: z
					.string()
					.regex(
						/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
						"Lowercase letters, digits and dashes.",
					)
					.max(63),
			}),
			render: (w) => <Basics w={w} projects={projects} />,
		},
		{
			id: "monitors",
			title: "Monitors",
			description:
				"Group the monitors visitors see, in the order they see them.",
			schema: z.object({
				sections: z
					.array(z.object({ monitors: z.array(z.unknown()) }))
					.refine(
						(s) => s.some((x) => x.monitors.length > 0),
						"Add at least one monitor.",
					),
			}),
			render: (w) => <Sections w={w} monitors={monitors} />,
		},
		{
			id: "branding",
			title: "Branding",
			description:
				"Colour, appearance and logo. The page stays plain HTML, fast on any device.",
			schema: z.object({
				accent: z
					.string()
					.regex(/^#[0-9a-fA-F]{6}$/, "A hex colour like #2563eb."),
				logoUrl: optionalUrl(/^https:\/\//, "An https URL."),
				websiteUrl: optionalUrl(
					/^https?:\/\//,
					"A full URL starting with https://.",
				),
			}),
			render: (w) => <Branding w={w} />,
		},
		{
			id: "domain",
			title: "Domain",
			description: "Optionally serve the page on a domain of your own.",
			schema: z.object({
				hostname: z
					.string()
					.trim()
					.refine(
						(s) =>
							!s ||
							/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s),
						"A domain name like status.acme.dev.",
					),
			}),
			render: (w) => <Domain w={w} />,
		},
		{
			id: "review",
			title: edit ? "Review and save" : "Review and create",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "basics",
							title: "Basics",
							rows: [
								{ label: "Title", value: w.values.title },
								{ label: "Address", value: `/status/${w.values.slug}` },
								...(w.values.description
									? [{ label: "Description", value: w.values.description }]
									: []),
							],
						},
						{
							stepId: "monitors",
							title: "Monitors",
							rows: w.values.sections.map((s, i) => ({
								label: s.name || `Section ${i + 1}`,
								value:
									s.monitors
										.map((m) => m.label || names.get(m.monitorId))
										.join(", ") || "Empty",
							})),
						},
						{
							stepId: "branding",
							title: "Branding",
							rows: [
								{
									label: "Accent",
									value: (
										<span className="inline-flex items-center gap-2 tabular">
											<span
												className="size-3 rounded-full"
												style={{ background: w.values.accent }}
											/>
											{w.values.accent}
										</span>
									),
								},
								{ label: "Appearance", value: w.values.appearance },
								{ label: "History", value: `${w.values.historyDays} days` },
							],
						},
						{
							stepId: "domain",
							title: "Domain",
							rows: [
								{ label: "Custom domain", value: w.values.hostname || "None" },
								{
									label: "Published",
									value: w.values.published ? "Yes" : "No",
								},
							],
						},
					]}
				/>
			),
		},
	];
}

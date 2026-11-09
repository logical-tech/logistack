import type { CsvImportConfig, CsvUpload } from "@logistack/contracts";
import { csvDateFormats, parseCsvDate } from "@logistack/core/work-csv";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileSpreadsheet, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import {
	useWorkCsvUpload,
	useWorkFields,
	useWorkLists,
	useWorkProjects,
} from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";

const TARGETS = {
	skip: "Don't import",
	title: "Title",
	description: "Description",
	status: "Status",
	assignee: "Assignee (email or name)",
	priority: "Priority",
	startDate: "Start date",
	dueDate: "Due date",
	tags: "Tags",
	parent: "Parent (title or ID)",
	externalId: "ID (updates on re-import)",
} as const;
type Builtin = keyof typeof TARGETS;

type V = {
	projectId: string;
	listId: string;
	/** Column index → a builtin target or `field:<id>`. */
	columns: Record<string, string>;
	dateFormat: string;
};

const GUESS: [RegExp, Builtin][] = [
	[/^(title|name|task|summary)$/i, "title"],
	[/desc|notes?|details/i, "description"],
	[/status|state/i, "status"],
	[/assign|owner/i, "assignee"],
	[/priority/i, "priority"],
	[/start/i, "startDate"],
	[/due|deadline|end/i, "dueDate"],
	[/tags?|labels?/i, "tags"],
	[/parent/i, "parent"],
	[/^(id|ref|key|external.?id)$/i, "externalId"],
];

const guessColumns = (headers: string[]) => {
	const used = new Set<string>();
	return Object.fromEntries(
		headers.map((h, i) => {
			const hit =
				GUESS.find(([re, t]) => re.test(h.trim()) && !used.has(t))?.[1] ??
				"skip";
			if (hit !== "skip") used.add(hit);
			return [String(i), hit];
		}),
	);
};

/** CSV → one list (plan 12.6): upload, target, map columns, preview, import. */
export function CsvWizard({
	step,
	onStepChange,
}: {
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const [upload, setUpload] = useState<(CsvUpload & { name: string }) | null>(
		null,
	);
	const qc = useQueryClient();
	const navigate = useNavigate();

	const steps: WizardStep<V>[] = [
		{
			id: "upload",
			title: "Upload",
			description:
				"A CSV up to 10 MB. The first row names the columns; delimiter and encoding are detected.",
			ready: () => (upload ? true : "Upload a CSV file"),
			render: (w) => <UploadStep w={w} upload={upload} onUpload={setUpload} />,
		},
		{
			id: "target",
			title: "Target",
			schema: z.object({
				projectId: z.string().min(1, "Pick a project"),
				listId: z.string().min(1, "Pick a list"),
			}),
			render: (w) => <TargetStep w={w} />,
		},
		{
			id: "columns",
			title: "Columns",
			description:
				"Statuses match yours by name; unknown ones land in the backlog.",
			schema: z.object({
				columns: z
					.record(z.string(), z.string())
					.refine(
						(c) => Object.values(c).filter((t) => t === "title").length === 1,
						"Map exactly one column to Title",
					),
			}),
			render: (w) => upload && <ColumnsStep w={w} upload={upload} />,
		},
		{
			id: "preview",
			title: "Preview",
			description:
				"The first 20 rows as they will import. Highlighted cells won't come through.",
			render: (w) => upload && <PreviewStep w={w} upload={upload} />,
		},
		{
			id: "import",
			title: "Import",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "upload",
							title: "File",
							rows: [
								{ label: "Name", value: upload?.name ?? "" },
								{
									label: "Rows",
									value: (upload?.rowCount ?? 0).toLocaleString(),
								},
							],
						},
						{
							stepId: "columns",
							title: "Columns",
							rows: Object.entries(w.values.columns)
								.filter(([, t]) => t !== "skip")
								.map(([i, t]) => ({
									label: upload?.headers[Number(i)] ?? `Column ${i}`,
									value: TARGETS[t as Builtin] ?? "Custom field",
								})),
						},
					]}
				/>
			),
		},
	];

	return (
		<Wizard
			id="work-import-csv"
			steps={steps}
			defaultValues={
				{
					projectId: "",
					listId: "",
					columns: {},
					dateFormat: "YYYY-MM-DD",
				} as V
			}
			step={step}
			onStepChange={onStepChange}
			finishLabel="Import tasks"
			onComplete={async (v) => {
				if (!upload) throw new Error("Upload the file again.");
				const columns: CsvImportConfig["columns"] = Object.fromEntries(
					Object.entries(v.columns).map(([i, t]) => [
						i,
						t.startsWith("field:")
							? { to: "field" as const, fieldId: t.slice(6) }
							: t === "startDate" || t === "dueDate"
								? { to: t, dateFormat: v.dateFormat }
								: { to: t as Exclude<Builtin, "startDate" | "dueDate"> },
					]),
				);
				const imp = await api.work.imports.create({
					kind: "csv",
					config: {
						listId: v.listId,
						delimiter: upload.delimiter,
						encoding: upload.encoding,
						uploadId: upload.uploadId,
						columns,
					},
				});
				await api.work.imports.run(imp.id);
				await qc.invalidateQueries({ queryKey: ["work", "imports"] });
				await navigate({
					to: "/work/import/$importId",
					params: { importId: imp.id },
				});
			}}
		/>
	);
}

function UploadStep({
	w,
	upload,
	onUpload,
}: {
	w: WizardApi<V>;
	upload: (CsvUpload & { name: string }) | null;
	onUpload: (u: CsvUpload & { name: string }) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const send = useWorkCsvUpload();
	const [drag, setDrag] = useState(false);
	const pick = (file: File | undefined) => {
		if (!file) return;
		send.mutate(file, {
			onSuccess: (u) => {
				onUpload({ ...u, name: file.name });
				const columns = guessColumns(u.headers);
				w.set("columns", columns);
				// The first format every sample date parses with.
				const samples = Object.entries(columns)
					.filter(([, t]) => t === "startDate" || t === "dueDate")
					.flatMap(([i]) =>
						u.rows.map((r) => r[Number(i)]?.trim() ?? "").filter(Boolean),
					);
				const format = csvDateFormats.find((f) =>
					samples.every((v) => parseCsvDate(v, f)),
				);
				if (samples.length && format) w.set("dateFormat", format);
			},
		});
	};
	return (
		<div className="grid gap-3">
			<button
				type="button"
				onClick={() => input.current?.click()}
				onDragOver={(e) => {
					e.preventDefault();
					setDrag(true);
				}}
				onDragLeave={() => setDrag(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDrag(false);
					pick(e.dataTransfer.files[0]);
				}}
				className={cn(
					"grid place-items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors t-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					drag ? "border-brand bg-brand/5" : "hover:bg-muted/50",
				)}
			>
				{upload ? (
					<FileSpreadsheet
						className="size-6 text-muted-foreground"
						aria-hidden
					/>
				) : (
					<Upload className="size-6 text-muted-foreground" aria-hidden />
				)}
				<span className="text-sm font-medium">
					{send.isPending
						? "Reading…"
						: upload
							? upload.name
							: "Drop a CSV here, or choose a file"}
				</span>
				{upload && (
					<span className="text-sm text-muted-foreground">
						{upload.rowCount.toLocaleString()} rows · {upload.headers.length}{" "}
						columns · delimiter{" "}
						<code className="font-mono">
							{upload.delimiter === "\t" ? "tab" : upload.delimiter}
						</code>{" "}
						· {upload.encoding}
					</span>
				)}
			</button>
			<input
				ref={input}
				type="file"
				accept=".csv,text/csv"
				className="sr-only"
				tabIndex={-1}
				onChange={(e) => pick(e.target.files?.[0])}
			/>
			{send.isError && (
				<p className="text-sm text-bad-text">{send.error.message}</p>
			)}
		</div>
	);
}

function TargetStep({ w }: { w: WizardApi<V> }) {
	const projects = useWorkProjects().data ?? [];
	const lists = (useWorkLists(w.values.projectId).data ?? []).filter(
		(l) => !l.archivedAt,
	);
	return (
		<div className="grid gap-5 sm:grid-cols-2">
			<Field id="csv-project" label="Project" error={w.error("projectId")}>
				<Select
					value={w.values.projectId}
					onValueChange={(v) => {
						w.set("projectId", v);
						w.set("listId", "");
					}}
				>
					<SelectTrigger id="csv-project" className="w-full">
						<SelectValue placeholder="Pick a project" />
					</SelectTrigger>
					<SelectContent>
						{projects.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{[...p.folderPath, p.name].join(" / ")}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
			<Field id="csv-list" label="List" error={w.error("listId")}>
				<Select
					value={w.values.listId}
					onValueChange={(v) => w.set("listId", v)}
					disabled={!w.values.projectId}
				>
					<SelectTrigger id="csv-list" className="w-full">
						<SelectValue placeholder="Pick a list" />
					</SelectTrigger>
					<SelectContent>
						{lists.map((l) => (
							<SelectItem key={l.id} value={l.id}>
								{l.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>
		</div>
	);
}

function ColumnsStep({ w, upload }: { w: WizardApi<V>; upload: CsvUpload }) {
	const fields = useWorkFields(w.values.projectId).data ?? [];
	const hasDates = Object.values(w.values.columns).some(
		(t) => t === "startDate" || t === "dueDate",
	);
	return (
		<div className="grid gap-5">
			<div className="overflow-hidden rounded-lg ring-1 ring-border">
				<ul className="divide-y">
					{upload.headers.map((h, i) => {
						const key = String(i);
						const sample = upload.rows.map((r) => r[i]).find((c) => c?.trim());
						return (
							<li
								key={key}
								className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 px-4 py-2.5"
							>
								<span className="min-w-0">
									<span className="block truncate text-sm font-medium">
										{h || `Column ${i + 1}`}
									</span>
									<span className="block truncate text-xs text-muted-foreground">
										{sample ? `e.g. ${sample}` : "Empty in the first rows"}
									</span>
								</span>
								<Select
									value={w.values.columns[key] ?? "skip"}
									onValueChange={(v) =>
										w.set("columns", { ...w.values.columns, [key]: v })
									}
								>
									<SelectTrigger
										aria-label={`Import ${h} as`}
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{Object.entries(TARGETS).map(([k, label]) => (
												<SelectItem key={k} value={k}>
													{label}
												</SelectItem>
											))}
										</SelectGroup>
										{fields.length > 0 && (
											<SelectGroup>
												<SelectLabel>Custom fields</SelectLabel>
												{fields.map((f) => (
													<SelectItem key={f.id} value={`field:${f.id}`}>
														{f.name}
													</SelectItem>
												))}
											</SelectGroup>
										)}
									</SelectContent>
								</Select>
							</li>
						);
					})}
				</ul>
			</div>
			{w.error("columns") && (
				<p className="text-sm text-bad-text">{w.error("columns")}</p>
			)}
			{hasDates && (
				<Field
					id="csv-date-format"
					label="Date format"
					hint="How dates are written in the file."
				>
					<Select
						value={w.values.dateFormat}
						onValueChange={(v) => w.set("dateFormat", v)}
					>
						<SelectTrigger id="csv-date-format" className="w-full sm:w-60">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{csvDateFormats.map((f) => (
								<SelectItem key={f} value={f}>
									{f}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}
		</div>
	);
}

function PreviewStep({ w, upload }: { w: WizardApi<V>; upload: CsvUpload }) {
	const mapped = Object.entries(w.values.columns).filter(
		([, t]) => t !== "skip",
	);
	const invalid = (target: string, value: string) =>
		(target === "title" && !value.trim()) ||
		((target === "startDate" || target === "dueDate") &&
			value.trim() !== "" &&
			!parseCsvDate(value, w.values.dateFormat));
	const bad = upload.rows.filter((r) =>
		mapped.some(([i, t]) => invalid(t, r[Number(i)] ?? "")),
	).length;
	return (
		<div className="grid gap-3">
			<p className="text-sm text-muted-foreground" aria-live="polite">
				{bad
					? `${bad} of the first ${upload.rows.length} rows have a problem.`
					: `The first ${upload.rows.length} rows look good.`}
			</p>
			<div className="max-h-[28rem] overflow-auto rounded-lg ring-1 ring-border">
				<table className="w-full text-sm">
					<thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
						<tr className="border-b">
							{mapped.map(([i, t]) => (
								<th key={i} className="px-3 py-2 font-medium whitespace-nowrap">
									{TARGETS[t as Builtin] ?? "Custom field"}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y">
						{upload.rows.map((r, n) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: preview rows are positional
							<tr key={n}>
								{mapped.map(([i, t]) => {
									const v = r[Number(i)] ?? "";
									return (
										<td
											key={i}
											className={cn(
												"max-w-56 truncate px-3 py-2",
												invalid(t, v) && "bg-bad/10 text-bad-text",
											)}
											title={v}
										>
											{v || (t === "title" ? "Missing" : "")}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<Button
				type="button"
				variant="link"
				size="sm"
				className="justify-self-start px-0 text-muted-foreground"
				onClick={() => w.goTo("columns")}
			>
				Change the mapping
			</Button>
		</div>
	);
}

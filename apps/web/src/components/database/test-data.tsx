import type { Faker } from "@faker-js/faker";
import type { Cell, DatabaseSchema, DbTable } from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Dices, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ChoiceGroup } from "@/components/wizard/parts";
import { ApiError } from "@/lib/api";
import { type DbTableRef, databaseApi } from "@/lib/api/database";
import {
	AUTO,
	type ColumnPlan,
	GENERATORS,
	generateRows,
	LOCALES,
	type Locale,
	loadFaker,
	PRESETS,
	presetDdl,
	presetDropSql,
	REFERENCE,
	type SqlDialect,
	suggest,
} from "@/lib/fake-data";
import { cn } from "@/lib/utils";

/** Rows per write: the api's own batch limit. */
const BATCH = 500;
const MAX_ROWS = 10_000;

export const sqlDialectOf = (s: DatabaseSchema): SqlDialect | null =>
	s.engine === "postgres"
		? "postgres"
		: s.engine === "mysql" || s.engine === "mariadb"
			? "mysql"
			: s.engine === "libsql"
				? "sqlite"
				: null;

const groups = [...new Set(GENERATORS.map((g) => g.group))];

function useFaker(locale: Locale) {
	const [faker, setFaker] = useState<Faker | null>(null);
	useEffect(() => {
		let live = true;
		void loadFaker(locale).then((f) => live && setFaker(f));
		return () => {
			live = false;
		};
	}, [locale]);
	return faker;
}

/** Up to 500 values of a key column, paged, so references point at rows that exist. */
async function keyPool(
	serviceId: string,
	ref: DbTableRef,
	column: string,
): Promise<Cell[]> {
	const out: Cell[] = [];
	let cursor: string | undefined;
	do {
		const page = await databaseApi.rows(serviceId, ref, {
			sort: [],
			filter: [],
			...(cursor ? { cursor } : {}),
		});
		const at = page.columns.findIndex((c) => c.name === column);
		if (at < 0) break;
		for (const r of page.rows) out.push(r[at] ?? null);
		cursor = page.nextCursor ?? undefined;
	} while (cursor && out.length < 500);
	return out;
}

/** Inserts in batches; returns every row as written, aligned with the table's columns. */
async function insertAll(
	serviceId: string,
	ref: DbTableRef,
	rows: Record<string, Cell>[],
	onProgress: (done: number) => void,
) {
	const written: (Cell[] | null)[] = [];
	for (let i = 0; i < rows.length; i += BATCH) {
		const res = await databaseApi.write(
			serviceId,
			ref,
			rows.slice(i, i + BATCH).map((values) => ({ op: "insert", values })),
		);
		written.push(...res.rows);
		onProgress(Math.min(i + BATCH, rows.length));
	}
	return written;
}

const errorText = (e: unknown) =>
	e instanceof ApiError && e.status === 403
		? "Your role can read this database but not write to it."
		: e instanceof Error
			? e.message
			: String(e);

function LocalePicker({
	value,
	onChange,
}: {
	value: Locale;
	onChange: (l: Locale) => void;
}) {
	return (
		<Field id="td-locale" label="Locale">
			<Select value={value} onValueChange={(v) => onChange(v as Locale)}>
				<SelectTrigger id="td-locale" className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(LOCALES).map(([k, l]) => (
						<SelectItem key={k} value={k}>
							{l.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</Field>
	);
}

function GeneratorSelect({
	value,
	onChange,
	label,
	reference,
}: {
	value: string;
	onChange: (id: string) => void;
	label: string;
	reference?: string;
}) {
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger size="sm" className="w-full" aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent className="max-h-80">
				<SelectItem value={AUTO}>Database default</SelectItem>
				{reference && (
					<SelectItem value={REFERENCE}>Existing row of {reference}</SelectItem>
				)}
				<SelectSeparator />
				{groups.map((g) => (
					<SelectGroup key={g}>
						<SelectLabel>{g}</SelectLabel>
						{GENERATORS.filter((x) => x.group === g).map((x) => (
							<SelectItem key={x.id} value={x.id}>
								{x.label}
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

const show = (c: Cell | undefined) =>
	c === undefined
		? "default"
		: c === null
			? "NULL"
			: typeof c === "object"
				? c.value
				: String(c);

/** Mockaroo-style: a generator per column, suggested from its name and type, then N rows. */
export function FillTableDialog({
	open,
	onOpenChange,
	serviceId,
	database,
	schema,
	table,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	serviceId: string;
	database?: string;
	schema: string;
	table: DbTable;
}) {
	const qc = useQueryClient();
	const [locale, setLocale] = useState<Locale>("en");
	const faker = useFaker(locale);
	const fkOf = useMemo(() => {
		const m = new Map<
			string,
			{ schema: string; table: string; column: string }
		>();
		for (const fk of table.foreignKeys ?? [])
			for (const [i, c] of fk.columns.entries())
				m.set(c, {
					schema: fk.refSchema,
					table: fk.refTable,
					column: fk.refColumns[i] ?? "id",
				});
		return m;
	}, [table]);
	const singleKey = table.columns.filter((c) => c.primaryKey).length === 1;
	const initial = () =>
		table.columns.map(
			(c): ColumnPlan => ({
				name: c.name,
				type: c.type,
				generator: suggest(c, { reference: fkOf.has(c.name), singleKey }),
				nulls: 0,
			}),
		);
	const [plan, setPlan] = useState<ColumnPlan[]>(initial);
	const [count, setCount] = useState("100");
	const [seed, setSeed] = useState(0);
	const [busy, setBusy] = useState<{ done: number; total: number } | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the dialog opens on a table
	useEffect(() => {
		if (open) {
			setPlan(initial());
			setError(null);
		}
	}, [open, table]);

	const preview = useMemo(() => {
		if (!faker) return [];
		faker.seed(seed + 1);
		const fake = Object.fromEntries(
			plan
				.filter((p) => p.generator === REFERENCE)
				.map((p) => [p.name, [`→ ${fkOf.get(p.name)?.table ?? "?"}`]]),
		);
		return generateRows(faker, plan, 5, fake);
	}, [faker, plan, seed, fkOf]);

	const n = Number(count);
	const validCount = Number.isInteger(n) && n >= 1 && n <= MAX_ROWS;
	const set = (i: number, patch: Partial<ColumnPlan>) =>
		setPlan((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

	const run = async () => {
		if (!faker || !validCount) return;
		setError(null);
		setBusy({ done: 0, total: n });
		try {
			faker.seed();
			const refs: Record<string, Cell[]> = {};
			for (const p of plan)
				if (p.generator === REFERENCE) {
					const fk = fkOf.get(p.name);
					if (!fk) continue;
					refs[p.name] = await keyPool(
						serviceId,
						{ database, schema: fk.schema, table: fk.table },
						fk.column,
					);
					if (
						!refs[p.name]?.length &&
						!table.columns.find((c) => c.name === p.name)?.nullable
					)
						throw new Error(
							`${fk.table} is empty: fill it first, so ${p.name} has rows to point at.`,
						);
				}
			const rows = generateRows(faker, plan, n, refs);
			await insertAll(
				serviceId,
				{ database, schema, table: table.name },
				rows,
				(done) => setBusy({ done, total: n }),
			);
			await qc.invalidateQueries({ queryKey: ["database", serviceId] });
			toast.success(`${n.toLocaleString()} rows added to ${table.name}`, {
				icon: <Dices className="size-4" />,
			});
			onOpenChange(false);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Generate test data for {table.name}</DialogTitle>
					<DialogDescription>
						Each column gets a generator suggested from its name and type.
						Change any of them, preview, then insert.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-5">
					<div className="grid gap-4 sm:grid-cols-[8rem_10rem]">
						<Field id="td-count" label="Rows">
							<Input
								id="td-count"
								value={count}
								onChange={(e) => setCount(e.target.value)}
								inputMode="numeric"
								className="tabular"
								aria-invalid={!validCount || undefined}
							/>
						</Field>
						<LocalePicker value={locale} onChange={setLocale} />
					</div>
					<div className="max-h-[42vh] overflow-y-auto rounded-lg ring-1 ring-border">
						<table className="w-full text-left text-sm">
							<thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
								<tr>
									<th className="px-3 py-2 font-medium">Column</th>
									<th className="px-3 py-2 font-medium">Generator</th>
									<th className="w-24 px-3 py-2 font-medium">NULL %</th>
								</tr>
							</thead>
							<tbody className="divide-y">
								{plan.map((p, i) => {
									const col = table.columns[i];
									return (
										<tr key={p.name}>
											<td className="px-3 py-1.5">
												<span className="block truncate font-mono text-xs">
													{p.name}
												</span>
												<span className="block truncate text-2xs text-muted-foreground">
													{p.type}
												</span>
											</td>
											<td className="px-3 py-1.5">
												<GeneratorSelect
													value={p.generator}
													onChange={(g) => set(i, { generator: g })}
													label={`Generator for ${p.name}`}
													reference={fkOf.get(p.name)?.table}
												/>
											</td>
											<td className="px-3 py-1.5">
												<Input
													aria-label={`Share of NULLs in ${p.name}`}
													value={String(p.nulls)}
													disabled={!col?.nullable || p.generator === AUTO}
													onChange={(e) =>
														set(i, {
															nulls: Math.max(
																0,
																Math.min(100, Number(e.target.value) || 0),
															),
														})
													}
													inputMode="numeric"
													className="h-8 tabular"
												/>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					<div className="grid gap-2">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">Preview</h3>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setSeed((s) => s + 1)}
								disabled={!faker}
							>
								<RefreshCw data-icon="inline-start" />
								Shuffle
							</Button>
						</div>
						<div className="overflow-x-auto rounded-lg ring-1 ring-border">
							<table className="w-full text-left font-mono text-xs">
								<thead className="bg-muted/60 text-muted-foreground">
									<tr>
										{plan.map((p) => (
											<th
												key={p.name}
												className="px-2.5 py-1.5 font-medium whitespace-nowrap"
											>
												{p.name}
											</th>
										))}
									</tr>
								</thead>
								<tbody className="divide-y">
									{faker ? (
										preview.map((r, i) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no identity
											<tr key={i}>
												{plan.map((p) => (
													<td
														key={p.name}
														className={cn(
															"max-w-56 truncate px-2.5 py-1.5 whitespace-nowrap",
															!(p.name in r) && "text-muted-foreground",
														)}
													>
														{show(r[p.name])}
													</td>
												))}
											</tr>
										))
									) : (
										<tr>
											<td
												className="px-2.5 py-3 text-muted-foreground"
												colSpan={plan.length}
											>
												Loading generators…
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
					</div>
					{error && (
						<p className="text-sm text-bad-text" role="alert">
							{error}
						</p>
					)}
				</div>
				<DialogFooter className="items-center">
					{busy && (
						<span
							className="mr-auto text-sm text-muted-foreground tabular"
							aria-live="polite"
						>
							{busy.done.toLocaleString()} of {busy.total.toLocaleString()} rows
						</span>
					)}
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={!!busy}
					>
						Cancel
					</Button>
					<Button onClick={run} disabled={!faker || !validCount || !!busy}>
						{busy && <Loader2 className="animate-spin" />}
						Insert {validCount ? n.toLocaleString() : ""} rows
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

const SCALES = { "0.25": "Small", "1": "Normal", "5": "Large" } as const;

/** Creates a preset's tables in one script, then fills them parents first. */
export function PresetDialog({
	open,
	onOpenChange,
	serviceId,
	data,
	schema,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	serviceId: string;
	data: DatabaseSchema;
	/** Where the tables go: a Postgres schema, the MySQL database, SQLite's main. */
	schema: string;
	onCreated: (firstTable: string) => void;
}) {
	const qc = useQueryClient();
	const dialect = sqlDialectOf(data);
	const [presetId, setPresetId] = useState(PRESETS[0]?.id ?? "");
	const [prefix, setPrefix] = useState("");
	const [scale, setScale] = useState<keyof typeof SCALES>("1");
	const [locale, setLocale] = useState<Locale>("en");
	const faker = useFaker(locale);
	const [step, setStep] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const preset = PRESETS.find((p) => p.id === presetId);
	const existing = new Set(
		data.schemas.find((s) => s.name === schema)?.tables.map((t) => t.name) ??
			[],
	);
	const clash =
		preset?.tables.filter((t) => existing.has(prefix + t.name)) ?? [];
	const validPrefix = /^[A-Za-z_][A-Za-z0-9_]*$|^$/.test(prefix);
	const rowsOf = (n: number) => Math.max(1, Math.round(n * Number(scale)));
	const database = data.engine === "postgres" ? data.database : undefined;

	const run = async () => {
		if (!preset || !dialect || !faker) return;
		setError(null);
		let created = false;
		try {
			setStep("Creating tables…");
			const ddl = await databaseApi.query(serviceId, {
				sql: presetDdl(preset, dialect, schema, prefix),
				readOnly: false,
				...(database ? { database } : {}),
			});
			if (ddl.error) throw new Error(ddl.error.message);
			created = true;
			const fresh = await databaseApi.schema(serviceId, database);
			const tables = fresh.schemas.find((s) => s.name === schema)?.tables ?? [];
			const ids = new Map<string, Cell[]>();
			faker.seed();
			for (const t of preset.tables) {
				const real = tables.find((x) => x.name === prefix + t.name);
				if (!real) throw new Error(`${prefix + t.name} was not created`);
				const n = rowsOf(t.rows);
				setStep(`Filling ${prefix + t.name} (${n.toLocaleString()} rows)…`);
				const plan: ColumnPlan[] = real.columns.map((c) => {
					const spec = t.columns.find((x) => x.name === c.name);
					return {
						name: c.name,
						type: c.type,
						generator: spec?.generator ?? suggest(c),
						nulls: spec?.nulls ?? 0,
					};
				});
				const refs = Object.fromEntries(
					t.columns
						.filter((c) => c.references)
						.map((c) => [c.name, ids.get(c.references as string) ?? []]),
				);
				const written = await insertAll(
					serviceId,
					{ database, schema, table: real.name },
					generateRows(faker, plan, n, refs),
					() => undefined,
				);
				const at = real.columns.findIndex((c) => c.name === "id");
				ids.set(
					t.name,
					written.flatMap((r) => (r && at >= 0 ? [r[at] ?? null] : [])),
				);
			}
			await qc.invalidateQueries({ queryKey: ["database", serviceId] });
			toast.success(`${preset.label} dataset created`, {
				description: `${preset.tables.length} ${preset.tables.length === 1 ? "table" : "tables"} in ${schema}`,
				icon: <Dices className="size-4" />,
			});
			onOpenChange(false);
			onCreated(prefix + (preset.tables[0]?.name ?? ""));
		} catch (e) {
			// Half-filled tables would block a retry with the same names, so they go.
			if (created)
				await databaseApi
					.query(serviceId, {
						sql: presetDropSql(preset, dialect, schema, prefix),
						readOnly: false,
						...(database ? { database } : {}),
					})
					.catch(() => undefined);
			await qc.invalidateQueries({ queryKey: ["database", serviceId] });
			setError(
				`${errorText(e)}${created ? " The tables it created were removed." : ""}`,
			);
		} finally {
			setStep(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(o) => !step && onOpenChange(o)}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Add a sample dataset</DialogTitle>
					<DialogDescription>
						Creates the tables in{" "}
						<span className="font-mono text-foreground">{schema}</span> and
						fills them with realistic fake data, foreign keys included.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-5">
					<ChoiceGroup
						label="Dataset"
						columns={2}
						value={presetId}
						onChange={setPresetId}
						choices={PRESETS.map((p) => ({
							value: p.id,
							title: p.label,
							description: p.description,
						}))}
					/>
					<div className="grid gap-4 sm:grid-cols-3">
						<Field
							id="td-prefix"
							label="Table prefix"
							optional
							error={validPrefix ? undefined : "Letters, digits and _ only."}
						>
							<Input
								id="td-prefix"
								value={prefix}
								onChange={(e) => setPrefix(e.target.value)}
								placeholder="demo_"
								className="font-mono"
								spellCheck={false}
							/>
						</Field>
						<Field id="td-scale" label="Size">
							<Select
								value={scale}
								onValueChange={(v) => setScale(v as keyof typeof SCALES)}
							>
								<SelectTrigger id="td-scale" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(SCALES).map(([k, l]) => (
										<SelectItem key={k} value={k}>
											{l}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<LocalePicker value={locale} onChange={setLocale} />
					</div>
					{preset && (
						<ul className="flex flex-wrap gap-1.5 text-xs">
							{preset.tables.map((t) => (
								<li
									key={t.name}
									className={cn(
										"rounded-md bg-muted px-2 py-1 font-mono",
										existing.has(prefix + t.name) &&
											"text-bad-text ring-1 ring-bad/40",
									)}
								>
									{prefix + t.name}{" "}
									<span className="text-muted-foreground tabular">
										{rowsOf(t.rows).toLocaleString()}
									</span>
								</li>
							))}
						</ul>
					)}
					{clash.length > 0 && (
						<p className="text-sm text-bad-text">
							{clash.map((t) => prefix + t.name).join(", ")} already{" "}
							{clash.length === 1 ? "exists" : "exist"}. Set a prefix to keep
							both.
						</p>
					)}
					{error && (
						<p className="text-sm text-bad-text" role="alert">
							{error}
						</p>
					)}
				</div>
				<DialogFooter className="items-center">
					{step && (
						<span
							className="mr-auto text-sm text-muted-foreground"
							aria-live="polite"
						>
							{step}
						</span>
					)}
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={!!step}
					>
						Cancel
					</Button>
					<Button
						onClick={run}
						disabled={
							!faker || !dialect || !!step || clash.length > 0 || !validPrefix
						}
					>
						{step && <Loader2 className="animate-spin" />}
						Create dataset
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

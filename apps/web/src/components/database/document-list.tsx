import { json } from "@codemirror/lang-json";
import type { DbTable, DocumentWrite } from "@logistack/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
	Braces,
	ChevronRight,
	Loader2,
	Pencil,
	Plus,
	RotateCcw,
	SearchX,
	Trash2,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { ScriptEditor } from "@/components/backups/script-editor";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { ApiError } from "@/lib/api/adapter";
import {
	type DocumentsFind,
	documentsQuery,
	reasonOf,
	useWriteDocument,
} from "@/lib/api/database";
import { cn } from "@/lib/utils";
import { literal, parseObject, pretty, readable } from "./ejson";
import { MOD } from "./sql-panel";

type Doc = Record<string, unknown>;
type DocId = Extract<DocumentWrite, { op: "delete" }>["id"];

const FIELDS = [
	{ key: "filter", label: "Filter", hint: '{ "status": "paid" }' },
	{ key: "sort", label: "Sort", hint: '{ "_id": -1 }' },
	{ key: "projection", label: "Fields", hint: '{ "name": 1 }' },
] as const;

const idText = (doc: Doc) => JSON.stringify(doc._id);
const FORBIDDEN_TEXT =
	"Your role can view this database but not change it. Nothing was saved.";

/** One collection's documents as collapsible Extended JSON, found by filter, sort and projection. */
export function DocumentList({
	serviceId,
	database,
	collection,
	find,
	onFind,
	forbidden,
	onForbidden,
}: {
	serviceId: string;
	database: string;
	collection: DbTable;
	find: DocumentsFind;
	onFind: (find: DocumentsFind) => void;
	forbidden: boolean;
	onForbidden: () => void;
}) {
	const ref = { database, collection: collection.name };
	const docs = useInfiniteQuery(documentsQuery(serviceId, ref, find));
	const write = useWriteDocument(serviceId, ref);
	const [draft, setDraft] = useState(find);
	const [invalid, setInvalid] = useState<Partial<Record<string, string>>>({});
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [editor, setEditor] = useState<
		{ mode: "insert" } | { mode: "replace"; doc: Doc } | null
	>(null);
	const [deleting, setDeleting] = useState<Doc | null>(null);
	const findKey = JSON.stringify(find);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the URL is the source; re-seed the inputs when it moves.
	useEffect(() => setDraft(find), [findKey]);

	const canWrite = collection.kind === "collection" && !forbidden;
	const projected = !!find.projection?.trim();
	const canEdit = canWrite && !projected;
	const reason =
		collection.kind !== "collection"
			? "Views are read-only. Edit the collection they read from."
			: forbidden
				? "Read-only: your role can view this database but not change it."
				: projected
					? "Clear Fields to edit: saving replaces the whole document."
					: null;

	const apply = (e: FormEvent) => {
		e.preventDefault();
		const errors = Object.fromEntries(
			FIELDS.flatMap(({ key }) => {
				const p = parseObject(draft[key] ?? "");
				return p.ok ? [] : [[key, p.error]];
			}),
		);
		setInvalid(errors);
		if (Object.keys(errors).length) return;
		onFind({
			filter: draft.filter?.trim() || undefined,
			sort: draft.sort?.trim() || undefined,
			projection: draft.projection?.trim() || undefined,
		});
	};
	const filtered = FIELDS.some(({ key }) => find[key]?.trim());

	const remove = (doc: Doc) =>
		write.mutate(
			{ op: "delete", id: doc._id as DocId },
			{
				onSuccess: () => {
					toast.success("Document deleted");
					setDeleting(null);
				},
				onError: (e) => {
					setDeleting(null);
					if (e instanceof ApiError && e.status === 403) {
						onForbidden();
						toast.error("Couldn't delete", { description: FORBIDDEN_TEXT });
					} else if (reasonOf(e) === "stale") {
						toast.error("Already deleted", {
							description:
								"Someone deleted this document after you loaded it. The list is refreshed.",
						});
						docs.refetch();
					} else toast.error("Couldn't delete", { description: e.message });
				},
			},
		);

	const loaded = (docs.data?.pages ?? []).flatMap((p) => p.documents);
	const error = docs.error;

	return (
		<>
			<form
				onSubmit={apply}
				className="grid gap-2 border-b px-3 py-2 sm:px-4"
				aria-label={`Find in ${collection.name}`}
			>
				<div className="flex flex-wrap items-center gap-2">
					{FIELDS.map(({ key, label, hint }) => (
						<label
							key={key}
							htmlFor={`find-${key}`}
							className={cn(
								"flex h-8 min-w-0 items-center rounded-lg ring-1 ring-input transition-shadow duration-(--duration-quick) focus-within:ring-2 focus-within:ring-ring",
								key === "filter"
									? "min-w-56 flex-[2_1_16rem]"
									: "flex-[1_1_9rem]",
								invalid[key] && "ring-destructive",
							)}
						>
							<span className="shrink-0 pl-2.5 text-xs font-medium text-muted-foreground">
								{label}
							</span>
							<Input
								id={`find-${key}`}
								value={draft[key] ?? ""}
								onChange={(e) => {
									setDraft((d) => ({ ...d, [key]: e.target.value }));
									if (invalid[key])
										setInvalid((x) => ({ ...x, [key]: undefined }));
								}}
								placeholder={hint}
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								aria-invalid={!!invalid[key]}
								aria-describedby={invalid[key] ? "find-error" : undefined}
								className="h-8 border-0 bg-transparent font-mono text-[12.5px] shadow-none ring-0 [font-size-adjust:0.47] focus-visible:ring-0 dark:bg-transparent"
							/>
						</label>
					))}
					<Button type="submit" size="sm" variant="outline">
						Find
					</Button>
					{filtered && (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setInvalid({});
								onFind({});
							}}
						>
							Reset
						</Button>
					)}
					{canWrite && (
						<Button
							type="button"
							size="sm"
							className="ml-auto"
							onClick={() => setEditor({ mode: "insert" })}
						>
							<Plus data-icon="inline-start" />
							Insert
						</Button>
					)}
				</div>
				{(Object.values(invalid).some(Boolean) || error) && (
					<p id="find-error" role="alert" className="text-xs text-bad-text">
						{Object.entries(invalid)
							.filter(([, v]) => v)
							.map(
								([k, v]) => `${FIELDS.find((f) => f.key === k)?.label}: ${v}`,
							)
							.join(" ") || (error instanceof Error ? error.message : "")}
					</p>
				)}
			</form>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{docs.isPending ? (
					<SkeletonRows rows={8} />
				) : error && !loaded.length ? (
					<EmptyState
						icon={SearchX}
						title="Couldn't run this find"
						description="Fix the filter, sort or fields above and press Find. Extended JSON only: $where, $function and $accumulator are not allowed."
						className="m-4"
					/>
				) : !loaded.length ? (
					<EmptyState
						icon={Braces}
						title={
							filtered
								? "No documents match"
								: `${collection.name} has no documents`
						}
						description={
							filtered
								? "Nothing in this collection matches the filter. Reset it to see every document."
								: "Documents your app writes appear here, ready to read and edit."
						}
						className="m-4"
					>
						{canWrite && !filtered && (
							<Button onClick={() => setEditor({ mode: "insert" })}>
								<Plus data-icon="inline-start" />
								Insert a document
							</Button>
						)}
					</EmptyState>
				) : (
					<ul aria-label={`Documents in ${collection.name}`}>
						{loaded.map((doc) => {
							const key = idText(doc);
							return (
								<DocumentRow
									key={key}
									doc={doc}
									open={open.has(key)}
									onToggle={() =>
										setOpen((s) => {
											const next = new Set(s);
											if (!next.delete(key)) next.add(key);
											return next;
										})
									}
									onEdit={
										canEdit
											? () => setEditor({ mode: "replace", doc })
											: undefined
									}
									onDelete={canWrite ? () => setDeleting(doc) : undefined}
								/>
							);
						})}
					</ul>
				)}
				{docs.hasNextPage && (
					<div className="flex justify-center p-3">
						<Button
							variant="outline"
							size="sm"
							disabled={docs.isFetchingNextPage}
							onClick={() => docs.fetchNextPage()}
						>
							{docs.isFetchingNextPage && <Loader2 className="animate-spin" />}
							Load more
						</Button>
					</div>
				)}
			</div>

			<div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
				<span className="tabular" aria-live="polite">
					{loaded.length.toLocaleString("en")}{" "}
					{docs.hasNextPage
						? "loaded"
						: loaded.length === 1
							? "document"
							: "documents"}
					{!filtered && collection.rows !== null && docs.hasNextPage && (
						<> of about {collection.rows.toLocaleString("en")}</>
					)}
				</span>
				{reason && <span className="sm:ml-auto">{reason}</span>}
			</div>

			<DocumentEditor
				key={editor?.mode === "replace" ? idText(editor.doc) : editor?.mode}
				state={editor}
				collection={collection.name}
				pending={write.isPending}
				onClose={() => setEditor(null)}
				onReload={() => docs.refetch()}
				onSave={(op, onError) =>
					write.mutate(op, {
						onSuccess: () => {
							toast.success(
								op.op === "insert" ? "Document inserted" : "Document saved",
							);
							setEditor(null);
						},
						onError: (e) => {
							if (e instanceof ApiError && e.status === 403) onForbidden();
							onError(e);
						},
					})
				}
			/>

			<ConfirmDialog
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete this document?"
				description={
					<>
						<span className="font-mono text-[12.5px] [font-size-adjust:0.47] break-all text-foreground">
							_id {deleting && preview(deleting._id)}
						</span>{" "}
						is removed from {collection.name}. Deleted documents can't be
						recovered.
					</>
				}
				confirmLabel="Delete document"
				pending={write.isPending}
				onConfirm={() => deleting && remove(deleting)}
			/>
		</>
	);
}

function DocumentRow({
	doc,
	open,
	onToggle,
	onEdit,
	onDelete,
}: {
	doc: Doc;
	open: boolean;
	onToggle: () => void;
	onEdit?: () => void;
	onDelete?: () => void;
}) {
	const view = readable(doc) as Doc;
	const { _id, ...rest } = view;
	return (
		<li className="border-b last:border-b-0">
			<div className="group flex items-start gap-1 px-2 py-1.5 transition-colors duration-(--duration-quick) hover:bg-muted/40 sm:px-3">
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="flex min-h-8 min-w-0 flex-1 items-start gap-1.5 rounded-md py-1 text-left font-mono text-[12.5px] leading-6 [font-size-adjust:0.47] outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<ChevronRight
						className={cn(
							"mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-quick)",
							open && "rotate-90",
						)}
						aria-hidden
					/>
					<span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:gap-3">
						<span className="shrink-0">
							<Value value={_id} />
						</span>
						{!open && (
							<span className="min-w-0 truncate text-muted-foreground">
								{Object.entries(rest)
									.map(([k, v]) => `${k}: ${preview(v)}`)
									.join(", ")}
							</span>
						)}
					</span>
				</button>
				<div className="flex shrink-0 items-center opacity-100 transition-opacity duration-(--duration-quick) md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
					<CopyButton value={() => pretty(doc)} label="Copy as Extended JSON" />
					{onEdit && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Edit document"
							className="text-muted-foreground"
							onClick={onEdit}
						>
							<Pencil />
						</Button>
					)}
					{onDelete && (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Delete document"
							className="text-muted-foreground hover:text-bad-text"
							onClick={onDelete}
						>
							<Trash2 />
						</Button>
					)}
				</div>
			</div>
			{open && (
				<div className="t-reveal overflow-x-auto px-3 pb-3 pl-9 font-mono text-[12.5px] leading-6 [font-size-adjust:0.47] sm:pl-10">
					<Fields value={rest} depth={0} />
				</div>
			)}
		</li>
	);
}

function preview(v: unknown): string {
	const lit = literal(v);
	if (lit) return lit.text ? `${lit.type}(${lit.text})` : lit.type;
	if (Array.isArray(v)) return v.length ? "[…]" : "[]";
	if (v !== null && typeof v === "object") return "{…}";
	return JSON.stringify(v);
}

/** A leaf value, coloured like the editor: strings green, numbers and literals red, types blue. */
function Value({ value }: { value: unknown }) {
	const lit = literal(value);
	if (lit)
		return (
			<span className="break-all">
				<span className="text-info-text">{lit.type}</span>
				{lit.text && (
					<>
						<span className="text-muted-foreground">(</span>
						<span className="text-ok-text">{lit.text}</span>
						<span className="text-muted-foreground">)</span>
					</>
				)}
			</span>
		);
	if (typeof value === "string")
		return (
			<span className="break-all text-ok-text">{JSON.stringify(value)}</span>
		);
	return <span className="text-bad-text">{JSON.stringify(value)}</span>;
}

function Fields({ value, depth }: { value: object; depth: number }) {
	const entries = Object.entries(value);
	const array = Array.isArray(value);
	return (
		<ul>
			{entries.map(([k, v]) => (
				<Field key={k} name={array ? null : k} value={v} depth={depth} />
			))}
		</ul>
	);
}

function Field({
	name,
	value,
	depth,
}: {
	name: string | null;
	value: unknown;
	depth: number;
}) {
	const nested =
		value !== null && typeof value === "object" && !literal(value)
			? (value as object)
			: null;
	const size = nested ? Object.keys(nested).length : 0;
	const [open, setOpen] = useState(depth < 2);
	const label = name !== null && (
		<>
			<span className="text-foreground">{name}</span>
			<span className="text-muted-foreground">: </span>
		</>
	);
	if (!nested || !size)
		return (
			<li className="pl-5">
				{label}
				{nested ? (
					<span className="text-muted-foreground">
						{Array.isArray(nested) ? "[]" : "{}"}
					</span>
				) : (
					<Value value={value} />
				)}
			</li>
		);
	const [l, r] = Array.isArray(nested) ? ["[", "]"] : ["{", "}"];
	return (
		<li>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="inline-flex items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--duration-quick)",
						open && "rotate-90",
					)}
					aria-hidden
				/>
				<span>
					{label}
					<span className="text-muted-foreground">
						{open ? l : `${l} ${size} ${size === 1 ? "item" : "items"} ${r}`}
					</span>
				</span>
			</button>
			{open && (
				<>
					<div className="ml-[0.4375rem] border-l pl-2">
						<Fields value={nested} depth={depth + 1} />
					</div>
					<span className="pl-5 text-muted-foreground">{r}</span>
				</>
			)}
		</li>
	);
}

const SAVE_ERRORS = {
	stale:
		"This document was deleted after you loaded it, so nothing was saved. Your text stays here.",
};

function DocumentEditor({
	state,
	collection,
	pending,
	onClose,
	onSave,
	onReload,
}: {
	state: { mode: "insert" } | { mode: "replace"; doc: Doc } | null;
	collection: string;
	pending: boolean;
	onClose: () => void;
	onSave: (op: DocumentWrite, onError: (e: Error) => void) => void;
	onReload: () => void;
}) {
	const [text, setText] = useState(() =>
		state?.mode === "replace" ? pretty(state.doc) : "{\n  \n}",
	);
	const [mode, setMode] = useState(state?.mode ?? "insert");
	const [error, setError] = useState<{ text: string; stale?: boolean } | null>(
		null,
	);
	const [checked, setChecked] = useState(false);
	const parsed = parseObject(text);
	const invalid = checked && !parsed.ok;

	const save = () => {
		setChecked(true);
		setError(null);
		if (!parsed.ok) return;
		const op: DocumentWrite =
			mode === "replace" && state?.mode === "replace"
				? {
						op: "replace",
						id: state.doc._id as DocId,
						document: parsed.value,
					}
				: { op: "insert", document: parsed.value };
		onSave(op, (e) =>
			setError(
				e instanceof ApiError && e.status === 403
					? { text: FORBIDDEN_TEXT }
					: reasonOf(e) === "stale"
						? { text: SAVE_ERRORS.stale, stale: true }
						: { text: `Nothing was saved: ${e.message}` },
			),
		);
	};

	return (
		<Sheet open={!!state} onOpenChange={(o) => !o && onClose()}>
			<SheetContent className="w-full gap-0 p-0 data-[side=right]:sm:max-w-2xl">
				<SheetHeader className="border-b p-4 pr-12">
					<SheetTitle>
						{mode === "insert" ? `Insert into ${collection}` : "Edit document"}
					</SheetTitle>
					<SheetDescription>
						Extended JSON. Wrapped values such as{" "}
						<code className="font-mono text-[12px]">{'{"$oid": …}'}</code> and{" "}
						<code className="font-mono text-[12px]">
							{'{"$numberLong": …}'}
						</code>{" "}
						keep their BSON type; a plain whole number is stored as an int.
					</SheetDescription>
				</SheetHeader>
				<form
					className="flex min-h-0 flex-1 flex-col"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							save();
						}
					}}
				>
					<div className="min-h-0 flex-1 p-4">
						<ScriptEditor
							id="document-editor"
							label="Document"
							value={text}
							onChange={(v) => {
								setText(v);
								setError(null);
							}}
							language={json()}
							hint="{ }"
							invalid={invalid}
							describedBy="document-error"
							className="h-full"
						/>
					</div>
					<div
						id="document-error"
						className="min-h-6 px-4 text-xs"
						role="alert"
					>
						{invalid && !parsed.ok && (
							<span className="text-bad-text">
								Not valid Extended JSON, nothing was sent. {parsed.error}
							</span>
						)}
						{error && <span className="text-bad-text">{error.text}</span>}
					</div>
					<SheetFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t p-3">
						<span
							className={cn(
								"mr-auto hidden items-center gap-2 text-xs text-muted-foreground",
								!error?.stale && "sm:flex",
							)}
						>
							<KbdGroup>
								<Kbd>{MOD}</Kbd>
								<Kbd>↵</Kbd>
							</KbdGroup>
							saves
						</span>
						{error?.stale && (
							<>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										onReload();
										onClose();
									}}
								>
									<RotateCcw data-icon="inline-start" />
									Reload documents
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										setMode("insert");
										setError(null);
									}}
								>
									Insert it again
								</Button>
							</>
						)}

						<Button type="button" variant="ghost" size="sm" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={pending}>
							{pending && <Loader2 className="animate-spin" />}
							{mode === "insert" ? "Insert document" : "Save document"}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}

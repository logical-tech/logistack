import type {
	DatabaseSchema,
	RedisBytes,
	RedisKey,
	RedisValue,
	RedisWrite,
	RespValue,
} from "@logistack/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	KeyRound,
	Loader2,
	Pencil,
	Search,
	SearchX,
	SquareTerminal,
	Timer,
	Trash2,
	X,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/adapter";
import {
	keysQuery,
	keyValueQuery,
	reasonOf,
	useRedisCommand,
	useWriteKey,
} from "@/lib/api/database";
import { cn } from "@/lib/utils";
import {
	bytesId,
	bytesText,
	isBinary,
	parseArgv,
	prettyJson,
	sizeText,
	ttlText,
} from "./redis";

const FORBIDDEN_TEXT =
	"Your role can view this database but not change it. Nothing was saved.";
const MONO = "font-mono text-[12.5px] [font-size-adjust:0.47]";
const TYPE_LABEL: Record<string, string> = {
	string: "string",
	hash: "hash",
	list: "list",
	set: "set",
	zset: "zset",
	stream: "stream",
};

type Op = RedisWrite extends infer W
	? W extends RedisWrite
		? Omit<W, "db" | "key">
		: never
	: never;

/** A Redis service: a logical-database picker and a SCAN pattern over a key list, beside the open key. */
export function KeyBrowser({
	serviceId,
	schema,
	db,
	match,
	onNavigate,
	forbidden,
	onForbidden,
}: {
	serviceId: string;
	schema: DatabaseSchema;
	db: number;
	match: string;
	onNavigate: (next: { db?: number; match?: string }) => void;
	forbidden: boolean;
	onForbidden: () => void;
}) {
	const keys = useInfiniteQuery(keysQuery(serviceId, db, match));
	const [draft, setDraft] = useState(match);
	const [open, setOpen] = useState<RedisKey | null>(null);
	useEffect(() => {
		setDraft(match);
	}, [match]);

	// SCAN may repeat a key across batches; the list shows it once.
	const seen = new Set<string>();
	const loaded = (keys.data?.pages ?? [])
		.flatMap((p) => p.keys)
		.filter((k) => {
			const id = bytesId(k.key);
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	// A sparse pattern can scan a long way before its first match; keep going a while on our own.
	const autoPages = useRef(0);
	const { hasNextPage, isFetching, fetchNextPage } = keys;
	useEffect(() => {
		if (loaded.length || !hasNextPage || isFetching || autoPages.current >= 20)
			return;
		autoPages.current++;
		fetchNextPage();
	}, [loaded.length, hasNextPage, isFetching, fetchNextPage]);
	const total = schema.schemas[db]?.keys;
	const filtered = match !== "*";

	const apply = (e: FormEvent) => {
		e.preventDefault();
		setOpen(null);
		autoPages.current = 0;
		onNavigate({ match: draft.trim() || "*" });
	};
	const moveFocus = (e: KeyboardEvent<HTMLUListElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const items = [
			...e.currentTarget.querySelectorAll<HTMLButtonElement>(
				"button[data-key]",
			),
		];
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = items[at + (e.key === "ArrowDown" ? 1 : -1)];
		if (next) {
			e.preventDefault();
			next.focus();
		}
	};

	return (
		<>
			<section
				aria-label="Keys"
				className={cn(
					"min-w-0 flex-col border-r md:flex md:w-[22rem] md:shrink-0",
					open ? "hidden" : "flex w-full",
				)}
			>
				<form
					onSubmit={apply}
					aria-label="Find keys"
					className="flex items-center gap-2 border-b px-3 py-2"
				>
					<Select
						value={String(db)}
						onValueChange={(v) => {
							setOpen(null);
							onNavigate({ db: Number(v) });
						}}
					>
						<SelectTrigger
							size="sm"
							aria-label="Logical database"
							className="w-[4.5rem] shrink-0 tabular"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{schema.schemas.map((s) => (
								<SelectItem key={s.name} value={s.name}>
									<span className="tabular">db{s.name}</span>
									<span className="ml-auto pl-3 text-xs text-muted-foreground tabular">
										{(s.keys ?? 0).toLocaleString("en")}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<label
						htmlFor="key-match"
						className="flex h-8 min-w-0 flex-1 items-center rounded-lg ring-1 ring-input transition-shadow duration-(--duration-quick) focus-within:ring-2 focus-within:ring-ring"
					>
						<Search
							className="ml-2.5 size-3.5 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<span className="sr-only">Key pattern</span>
						<Input
							id="key-match"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="session:*"
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							className={cn(
								"h-8 border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 dark:bg-transparent",
								MONO,
							)}
						/>
					</label>
					<Button type="submit" size="sm" variant="outline">
						Scan
					</Button>
				</form>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{keys.isPending ? (
						<SkeletonRows rows={10} />
					) : keys.isError && !loaded.length ? (
						<EmptyState
							icon={SearchX}
							title="Couldn't scan the keys"
							description={
								keys.error instanceof Error
									? keys.error.message
									: "Try again in a moment."
							}
							className="m-4"
						>
							<Button variant="outline" onClick={() => keys.refetch()}>
								Try again
							</Button>
						</EmptyState>
					) : !loaded.length ? (
						keys.hasNextPage ? (
							<p className="px-4 py-6 text-center text-xs text-muted-foreground text-pretty">
								No match in the part of the keyspace scanned so far.
							</p>
						) : (
							<EmptyState
								icon={KeyRound}
								title={filtered ? "No keys match" : `db${db} is empty`}
								description={
									filtered
										? `Nothing in db${db} matches ${match}. Patterns use Redis globs: * any run, ? one character, [abc] a set.`
										: "Keys your app writes to this logical database appear here."
								}
								className="m-4"
							/>
						)
					) : (
						<ul aria-label={`Keys in db${db}`} onKeyDown={moveFocus}>
							{loaded.map((k) => (
								<KeyRow
									key={bytesId(k.key)}
									k={k}
									current={!!open && bytesId(open.key) === bytesId(k.key)}
									onOpen={() => setOpen(k)}
								/>
							))}
						</ul>
					)}
					{keys.hasNextPage && (
						<div className="flex justify-center p-3">
							<Button
								variant="outline"
								size="sm"
								disabled={keys.isFetchingNextPage}
								onClick={() => keys.fetchNextPage()}
							>
								{keys.isFetchingNextPage && (
									<Loader2 className="animate-spin" />
								)}
								Load more
							</Button>
						</div>
					)}
				</div>
				<div className="flex min-h-10 items-center border-t px-3 py-1.5 text-xs text-muted-foreground">
					<span className="tabular" aria-live="polite">
						{loaded.length.toLocaleString("en")}{" "}
						{loaded.length === 1 ? "key" : "keys"}
						{keys.hasNextPage
							? " so far, scan continues"
							: filtered
								? " match"
								: ""}
						{!filtered && keys.hasNextPage && total !== undefined && (
							<> of {total.toLocaleString("en")}</>
						)}
					</span>
				</div>
			</section>

			<section
				aria-label="Key"
				className={cn(
					"min-w-0 flex-1 flex-col",
					open ? "flex" : "hidden md:flex",
				)}
			>
				{open ? (
					<KeyDetail
						key={`${db}:${bytesId(open.key)}`}
						serviceId={serviceId}
						db={db}
						k={open}
						forbidden={forbidden}
						onForbidden={onForbidden}
						onClose={() => setOpen(null)}
						onRenamed={setOpen}
					/>
				) : (
					<EmptyState
						icon={KeyRound}
						title="Pick a key"
						description="Its value opens here, paged by type, ready to read and edit."
						className="m-auto"
					/>
				)}
			</section>
		</>
	);
}

function TypeBadge({ type }: { type: string }) {
	return (
		<span className="inline-flex h-5 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-medium text-muted-foreground">
			{TYPE_LABEL[type] ?? type}
		</span>
	);
}

function Ttl({ ms }: { ms: number | null }) {
	if (ms === null) return null;
	return (
		<span
			className={cn("tabular", ms < 60_000 && "text-warn-text")}
			title={`Expires in ${ttlText(ms)}`}
		>
			{ttlText(ms)}
		</span>
	);
}

function KeyRow({
	k,
	current,
	onOpen,
}: {
	k: RedisKey;
	current: boolean;
	onOpen: () => void;
}) {
	return (
		<li className="border-b last:border-b-0">
			<button
				type="button"
				data-key
				aria-current={current || undefined}
				onClick={onOpen}
				className={cn(
					"flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left outline-none transition-colors duration-(--duration-quick) hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					current && "bg-muted",
				)}
			>
				<TypeBadge type={k.type} />
				<span className={cn("min-w-0 flex-1 truncate", MONO)}>
					<BytesText value={k.key} />
				</span>
				<span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
					<Ttl ms={k.ttlMs} />
					{k.bytes !== null && (
						<span className="hidden tabular sm:inline">
							{sizeText(k.bytes)}
						</span>
					)}
				</span>
			</button>
		</li>
	);
}

/** Bytes as text; binary ones as their base64 with a tag saying so. */
function BytesText({ value }: { value: RedisBytes }) {
	if (!isBinary(value)) return <>{bytesText(value)}</>;
	return (
		<>
			<span className="mr-1.5 rounded bg-info/15 px-1 font-sans text-[10.5px] font-medium text-info-text [font-size-adjust:none]">
				base64
			</span>
			{bytesText(value)}
		</>
	);
}

type Confirm = {
	title: string;
	description: ReactNode;
	label: string;
	done: string;
	op: Op;
};

function KeyDetail({
	serviceId,
	db,
	k,
	forbidden,
	onForbidden,
	onClose,
	onRenamed,
}: {
	serviceId: string;
	db: number;
	k: RedisKey;
	forbidden: boolean;
	onForbidden: () => void;
	onClose: () => void;
	onRenamed: (k: RedisKey) => void;
}) {
	const value = useInfiniteQuery(keyValueQuery(serviceId, db, k.key));
	const write = useWriteKey(serviceId);
	const [edit, setEdit] = useState<"ttl" | "rename" | null>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const canWrite = !forbidden;
	const first = value.data?.pages[0];

	const run = (op: Op, done: string, after?: (k: RedisKey | null) => void) =>
		write.mutate({ ...op, db, key: k.key } as RedisWrite, {
			onSuccess: (r) => {
				toast.success(done);
				setConfirm(null);
				after?.(r.key);
			},
			onError: (e) => {
				setConfirm(null);
				if (e instanceof ApiError && e.status === 403) {
					onForbidden();
					toast.error("Nothing was saved", { description: FORBIDDEN_TEXT });
				} else if (reasonOf(e) === "stale") {
					toast.error("This key changed", {
						description: `${e.message[0]?.toUpperCase()}${e.message.slice(1)}. Nothing was saved; the key is reloaded.`,
					});
					value.refetch();
				} else toast.error("Nothing was saved", { description: e.message });
			},
		});

	const length =
		first &&
		`${first.length.toLocaleString("en")} ${
			first.type === "string"
				? first.length === 1
					? "byte"
					: "bytes"
				: first.length === 1
					? "item"
					: "items"
		}`;

	return (
		<>
			<header className="border-b px-3 py-2.5 sm:px-4">
				<div className="flex items-start gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Back to keys"
						className="-ml-1 text-muted-foreground md:hidden"
						onClick={onClose}
					>
						<ArrowLeft />
					</Button>
					<h3 className={cn("min-w-0 flex-1 break-all pt-1 leading-5", MONO)}>
						<BytesText value={k.key} />
					</h3>
					<div className="flex shrink-0 items-center">
						<CopyButton value={bytesText(k.key)} label="Copy key name" />
						{canWrite && (
							<>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Rename key"
									aria-expanded={edit === "rename"}
									className="text-muted-foreground"
									onClick={() => setEdit(edit === "rename" ? null : "rename")}
								>
									<Pencil />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Delete key"
									className="text-muted-foreground hover:text-bad-text"
									onClick={() =>
										setConfirm({
											title: "Delete this key?",
											description: (
												<>
													<span
														className={cn("break-all text-foreground", MONO)}
													>
														{bytesText(k.key)}
													</span>{" "}
													and its whole value are removed from db{db}. This
													can't be undone.
												</>
											),
											label: "Delete key",
											done: "Key deleted",
											op: { op: "delete" },
										})
									}
								>
									<Trash2 />
								</Button>
							</>
						)}
					</div>
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-0 text-xs text-muted-foreground md:pl-0">
					<TypeBadge type={k.type} />
					{length && <span className="tabular">{length}</span>}
					{k.bytes !== null && (
						<span className="tabular">{sizeText(k.bytes)} in memory</span>
					)}
					<button
						type="button"
						disabled={!canWrite}
						aria-expanded={edit === "ttl"}
						onClick={() => setEdit(edit === "ttl" ? null : "ttl")}
						className="inline-flex items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
					>
						<Timer className="size-3.5" aria-hidden />
						{k.ttlMs === null ? (
							"No expiry"
						) : (
							<>
								Expires in <Ttl ms={k.ttlMs} />
							</>
						)}
					</button>
				</div>
				{edit && (
					<InlineEdit
						key={edit}
						mode={edit}
						k={k}
						pending={write.isPending}
						onCancel={() => setEdit(null)}
						onSave={(op) =>
							run(
								op,
								op.op === "rename"
									? "Key renamed"
									: op.op === "persist"
										? "Expiry removed"
										: "Expiry set",
								(next) => {
									setEdit(null);
									if (next) onRenamed(next);
								},
							)
						}
					/>
				)}
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{value.isPending ? (
					<SkeletonRows rows={8} />
				) : value.isError ? (
					<EmptyState
						icon={SearchX}
						title={
							reasonOf(value.error) === "missing" ||
							(value.error instanceof ApiError && value.error.status === 404)
								? "This key is gone"
								: "Couldn't read this key"
						}
						description={
							value.error instanceof ApiError && value.error.status === 404
								? "It expired or was deleted after the list loaded."
								: value.error.message
						}
						className="m-4"
					>
						<Button variant="outline" onClick={onClose}>
							Back to keys
						</Button>
					</EmptyState>
				) : (
					<ValueView
						pages={value.data.pages}
						canWrite={canWrite}
						pending={write.isPending}
						onWrite={(op, done) => run(op, done)}
						onConfirm={setConfirm}
					/>
				)}
				{value.hasNextPage && (
					<div className="flex justify-center p-3">
						<Button
							variant="outline"
							size="sm"
							disabled={value.isFetchingNextPage}
							onClick={() => value.fetchNextPage()}
						>
							{value.isFetchingNextPage && <Loader2 className="animate-spin" />}
							Load more
						</Button>
					</div>
				)}
			</div>
			{forbidden && (
				<div className="flex min-h-10 items-center border-t px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
					Read-only: your role can view this database but not change it.
				</div>
			)}

			<ConfirmDialog
				open={!!confirm}
				onOpenChange={(o) => !o && setConfirm(null)}
				title={confirm?.title ?? ""}
				description={confirm?.description}
				confirmLabel={confirm?.label ?? ""}
				pending={write.isPending}
				onConfirm={() =>
					confirm &&
					run(confirm.op, confirm.done, (next) => {
						if (!next) onClose();
					})
				}
			/>
		</>
	);
}

function InlineEdit({
	mode,
	k,
	pending,
	onCancel,
	onSave,
}: {
	mode: "ttl" | "rename";
	k: RedisKey;
	pending: boolean;
	onCancel: () => void;
	onSave: (op: Op) => void;
}) {
	const [text, setText] = useState(
		mode === "rename"
			? bytesText(k.key)
			: k.ttlMs === null
				? ""
				: String(Math.round(k.ttlMs / 1000)),
	);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.select();
	}, []);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (mode === "rename") {
			if (!text) return setError("A key needs a name.");
			if (text === bytesText(k.key)) return onCancel();
			return onSave({ op: "rename", to: text });
		}
		const s = Number(text);
		if (!Number.isInteger(s) || s < 1)
			return setError("Enter a whole number of seconds, 1 or more.");
		onSave({ op: "expire", ttlMs: s * 1000 });
	};
	return (
		<form
			onSubmit={submit}
			onKeyDown={(e) => e.key === "Escape" && onCancel()}
			className="t-reveal mt-2.5 grid gap-1.5"
			aria-label={mode === "rename" ? "Rename key" : "Set expiry"}
		>
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor="key-edit" className="text-xs font-medium">
					{mode === "rename" ? "New name" : "Expire in (seconds)"}
				</label>
				<Input
					ref={ref}
					id="key-edit"
					value={text}
					inputMode={mode === "ttl" ? "numeric" : undefined}
					onChange={(e) => {
						setText(e.target.value);
						setError(null);
					}}
					aria-invalid={!!error}
					aria-describedby={error ? "key-edit-error" : undefined}
					spellCheck={false}
					className={cn(
						"h-8 min-w-0",
						mode === "rename" ? "flex-[1_1_14rem]" : "w-28 tabular",
						MONO,
					)}
				/>
				<Button type="submit" size="sm" disabled={pending}>
					{pending && <Loader2 className="animate-spin" />}
					{mode === "rename" ? "Rename" : "Set expiry"}
				</Button>
				{mode === "ttl" && k.ttlMs !== null && (
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={pending}
						onClick={() => onSave({ op: "persist" })}
					>
						Remove expiry
					</Button>
				)}
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
			{error && (
				<p id="key-edit-error" role="alert" className="text-xs text-bad-text">
					{error}
				</p>
			)}
		</form>
	);
}

type Row = {
	id: string;
	cells: ReactNode[];
	/** Fills the editor with this row. */
	edit?: Record<string, RedisBytes>;
	remove?: { op: Op; noun: "field" | "member"; name: RedisBytes };
};

/** The value of one key: a string editor, or a table per collection type with its own editor above. */
function ValueView({
	pages,
	canWrite,
	pending,
	onWrite,
	onConfirm,
}: {
	pages: RedisValue[];
	canWrite: boolean;
	pending: boolean;
	onWrite: (op: Op, done: string) => void;
	onConfirm: (c: Confirm) => void;
}) {
	const head = pages[0] as RedisValue;
	if (head.type === "string")
		return (
			<StringValue
				value={head}
				canWrite={canWrite}
				pending={pending}
				onSave={(v) => onWrite({ op: "set", value: v }, "Value saved")}
			/>
		);
	let columns: string[];
	let rows: Row[];
	let editor: EditorSpec | null = null;
	switch (head.type) {
		case "hash":
			columns = ["Field", "Value"];
			rows = pages.flatMap((p) =>
				p.type === "hash"
					? p.entries.map((e) => ({
							id: bytesId(e.field),
							cells: [
								<BytesText key="f" value={e.field} />,
								<BytesText key="v" value={e.value} />,
							],
							edit: { field: e.field, value: e.value },
							remove: {
								op: { op: "hdel", field: e.field },
								noun: "field",
								name: e.field,
							},
						}))
					: [],
			);
			editor = {
				fields: ["field", "value"],
				label: "Set field",
				toOp: (v) => ({
					op: "hset",
					field: v.field ?? "",
					value: v.value ?? "",
				}),
				done: "Field saved",
			};
			break;
		case "set":
			columns = ["Member"];
			rows = pages.flatMap((p) =>
				p.type === "set"
					? p.members.map((m) => ({
							id: bytesId(m),
							cells: [<BytesText key="m" value={m} />],
							remove: {
								op: { op: "srem", member: m },
								noun: "member",
								name: m,
							},
						}))
					: [],
			);
			editor = {
				fields: ["member"],
				label: "Add member",
				toOp: (v) => ({ op: "sadd", member: v.member ?? "" }),
				done: "Member added",
			};
			break;
		case "zset":
			columns = ["Score", "Member"];
			rows = pages.flatMap((p) =>
				p.type === "zset"
					? p.members.map((m) => ({
							id: bytesId(m.member),
							cells: [
								<span key="s" className="tabular">
									{m.score}
								</span>,
								<BytesText key="m" value={m.member} />,
							],
							edit: { member: m.member, score: m.score },
							remove: {
								op: { op: "zrem", member: m.member },
								noun: "member",
								name: m.member,
							},
						}))
					: [],
			);
			editor = {
				fields: ["member", "score"],
				label: "Set score",
				toOp: (v) => ({
					op: "zadd",
					member: v.member ?? "",
					score: Number(v.score),
				}),
				check: (v) =>
					Number.isFinite(Number(v.score)) && v.score?.trim()
						? null
						: "The score must be a number.",
				done: "Score saved",
			};
			break;
		case "list": {
			columns = ["Index", "Value"];
			let i = 0;
			rows = pages.flatMap((p) =>
				p.type === "list"
					? p.items.map((item) => {
							const index = i++;
							return {
								id: String(index),
								cells: [
									<span key="i" className="tabular text-muted-foreground">
										{index}
									</span>,
									<BytesText key="v" value={item} />,
								],
								edit: { index: String(index), value: item },
							};
						})
					: [],
			);
			editor = {
				fields: ["index", "value"],
				label: "Set item",
				toOp: (v) => ({
					op: "lset",
					index: Number(v.index),
					value: v.value ?? "",
				}),
				check: (v) =>
					Number.isInteger(Number(v.index)) && v.index?.trim()
						? null
						: "The index must be a whole number.",
				done: "Item saved",
			};
			break;
		}
		case "stream":
			columns = ["ID", "Fields"];
			rows = pages.flatMap((p) =>
				p.type === "stream"
					? p.entries.map((e) => ({
							id: e.id,
							cells: [
								<span key="id" className="tabular text-muted-foreground">
									{e.id}
								</span>,
								<span key="f" className="flex flex-wrap gap-x-3">
									{e.fields.map((f) => (
										<span key={bytesId(f.field)}>
											<span className="text-muted-foreground">
												<BytesText value={f.field} />
											</span>{" "}
											<BytesText value={f.value} />
										</span>
									))}
								</span>,
							],
						}))
					: [],
			);
			break;
	}
	return (
		<CollectionTable
			columns={columns}
			rows={rows}
			editor={canWrite ? editor : null}
			pending={pending}
			onWrite={onWrite}
			onRemove={
				canWrite
					? (r) =>
							r.remove &&
							onConfirm({
								title: `Remove this ${r.remove.noun}?`,
								description: (
									<>
										<span className={cn("break-all text-foreground", MONO)}>
											<BytesText value={r.remove.name} />
										</span>{" "}
										is removed from the key. Removing the last one deletes the
										key.
									</>
								),
								label: `Remove ${r.remove.noun}`,
								done:
									r.remove.noun === "field"
										? "Field removed"
										: "Member removed",
								op: r.remove.op,
							})
					: undefined
			}
			note={
				head.type === "stream"
					? "Streams are read-only here. Append entries with XADD in the command view."
					: null
			}
		/>
	);
}

type EditorSpec = {
	fields: string[];
	label: string;
	toOp: (v: Record<string, string>) => Op;
	check?: (v: Record<string, string>) => string | null;
	done: string;
};

function CollectionTable({
	columns,
	rows,
	editor,
	pending,
	onWrite,
	onRemove,
	note,
}: {
	columns: string[];
	rows: Row[];
	editor: EditorSpec | null;
	pending: boolean;
	onWrite: (op: Op, done: string) => void;
	onRemove?: (r: Row) => void;
	note: string | null;
}) {
	const [draft, setDraft] = useState<Record<string, string>>({});
	// A binary field or member edits as itself; its text is not editable.
	const [locked, setLocked] = useState<Record<string, RedisBytes>>({});
	const [error, setError] = useState<string | null>(null);
	const firstInput = useRef<HTMLInputElement>(null);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!editor) return;
		const problem = editor.check?.(draft) ?? null;
		if (problem) return setError(problem);
		const op = editor.toOp(draft) as Record<string, unknown>;
		for (const [f, v] of Object.entries(locked)) op[f] = v;
		onWrite(op as Op, editor.done);
		setDraft({});
		setLocked({});
	};
	const fill = (r: Row) => {
		if (!r.edit) return;
		const next: Record<string, string> = {};
		const lock: Record<string, RedisBytes> = {};
		for (const [f, v] of Object.entries(r.edit)) {
			next[f] = bytesText(v);
			if (isBinary(v) && f !== "value") lock[f] = v;
		}
		setDraft(next);
		setLocked(lock);
		setError(null);
		firstInput.current?.focus();
	};

	return (
		<>
			{editor && (
				<form
					onSubmit={submit}
					aria-label={editor.label}
					className="grid gap-1.5 border-b px-3 py-2 sm:px-4"
				>
					<div className="flex flex-wrap items-center gap-2">
						{editor.fields.map((f, i) => (
							<label
								key={f}
								htmlFor={`kv-${f}`}
								className={cn(
									"flex h-8 min-w-0 items-center rounded-lg ring-1 ring-input transition-shadow duration-(--duration-quick) focus-within:ring-2 focus-within:ring-ring",
									f === "value" || f === "member"
										? "flex-[2_1_12rem]"
										: "flex-[1_1_7rem]",
								)}
							>
								<span className="shrink-0 pl-2.5 text-xs font-medium text-muted-foreground capitalize">
									{f}
								</span>
								<Input
									ref={i === 0 ? firstInput : undefined}
									id={`kv-${f}`}
									value={draft[f] ?? ""}
									readOnly={!!locked[f]}
									inputMode={
										f === "index" || f === "score" ? "decimal" : undefined
									}
									onChange={(e) => {
										setDraft((d) => ({ ...d, [f]: e.target.value }));
										setError(null);
									}}
									spellCheck={false}
									autoCapitalize="off"
									className={cn(
										"h-8 border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 dark:bg-transparent",
										MONO,
									)}
								/>
							</label>
						))}
						<Button type="submit" size="sm" disabled={pending}>
							{pending && <Loader2 className="animate-spin" />}
							{editor.label}
						</Button>
						{Object.values(draft).some(Boolean) && (
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="Clear"
								className="text-muted-foreground"
								onClick={() => {
									setDraft({});
									setLocked({});
									setError(null);
								}}
							>
								<X />
							</Button>
						)}
					</div>
					{error && (
						<p role="alert" className="text-xs text-bad-text">
							{error}
						</p>
					)}
				</form>
			)}
			{note && (
				<p className="border-b px-3 py-2 text-xs text-muted-foreground sm:px-4">
					{note}
				</p>
			)}
			<table className={cn("w-full table-fixed", MONO)}>
				<thead className="sr-only">
					<tr>
						{columns.map((c) => (
							<th key={c}>{c}</th>
						))}
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr
							key={r.id}
							className="group border-b align-top transition-colors duration-(--duration-quick) last:border-b-0 hover:bg-muted/40"
						>
							{r.cells.map((cell, i) => (
								<td
									// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional.
									key={i}
									className={cn(
										"px-3 py-2 leading-5 break-all sm:px-4",
										i === 0 && r.cells.length > 1 && "w-[38%] sm:w-[32%]",
									)}
								>
									{cell}
								</td>
							))}
							<td className="w-[4.75rem] py-1 pr-2 text-right">
								<span className="inline-flex opacity-100 transition-opacity duration-(--duration-quick) md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
									{editor && r.edit && (
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Edit"
											className="text-muted-foreground"
											onClick={() => fill(r)}
										>
											<Pencil />
										</Button>
									)}
									{onRemove && r.remove && (
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Remove"
											className="text-muted-foreground hover:text-bad-text"
											onClick={() => onRemove(r)}
										>
											<Trash2 />
										</Button>
									)}
								</span>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	);
}

function StringValue({
	value,
	canWrite,
	pending,
	onSave,
}: {
	value: Extract<RedisValue, { type: "string" }>;
	canWrite: boolean;
	pending: boolean;
	onSave: (v: string) => void;
}) {
	const text = bytesText(value.value);
	const json = isBinary(value.value) ? null : prettyJson(text);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(json ?? text);
	const editable = canWrite && !value.truncated && !isBinary(value.value);
	const why = value.truncated
		? `Showing the first MiB of ${value.length.toLocaleString("en")} bytes. Large values are read-only here.`
		: isBinary(value.value)
			? "Binary value, shown as base64. Binary values are read-only here."
			: null;
	if (editing)
		return (
			<form
				className="flex h-full flex-col gap-2 p-3 sm:p-4"
				onSubmit={(e) => {
					e.preventDefault();
					// Pretty-printed JSON goes back compact, as most writers store it.
					const out =
						json && prettyJson(draft)
							? JSON.stringify(JSON.parse(draft))
							: draft;
					onSave(out);
					setEditing(false);
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") setEditing(false);
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
						e.currentTarget.requestSubmit();
				}}
			>
				<label htmlFor="string-value" className="sr-only">
					Value
				</label>
				<Textarea
					id="string-value"
					autoFocus
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					spellCheck={false}
					className={cn("min-h-48 flex-1 resize-none", MONO)}
				/>
				<div className="flex items-center justify-end gap-2">
					<span className="mr-auto text-xs text-muted-foreground">
						Saving keeps the key's expiry.
					</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setEditing(false)}
					>
						Cancel
					</Button>
					<Button type="submit" size="sm" disabled={pending}>
						{pending && <Loader2 className="animate-spin" />}
						Save value
					</Button>
				</div>
			</form>
		);
	return (
		<div className="grid gap-2 p-3 sm:p-4">
			<div className="flex items-center gap-2">
				{json && (
					<span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
						JSON
					</span>
				)}
				{why && (
					<span className="text-xs text-muted-foreground text-pretty">
						{why}
					</span>
				)}
				<span className="ml-auto flex items-center">
					<CopyButton value={text} label="Copy value" />
					{editable && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								setDraft(json ?? text);
								setEditing(true);
							}}
						>
							<Pencil data-icon="inline-start" />
							Edit
						</Button>
					)}
				</span>
			</div>
			<pre
				className={cn(
					"overflow-x-auto rounded-lg bg-muted/40 p-3 leading-5 whitespace-pre-wrap break-all ring-1 ring-border",
					MONO,
				)}
			>
				{json ??
					(isBinary(value.value) ? (
						<BytesText value={value.value} />
					) : (
						text || (
							<span className="text-muted-foreground">(empty string)</span>
						)
					))}
			</pre>
		</div>
	);
}

type Ran = {
	id: number;
	db: number;
	line: string;
	reply?: RespValue;
	error?: string;
	ms?: number;
};
const HISTORY_KEY = (serviceId: string) => `ls:redis-history:${serviceId}`;

/** One command at a time, redis-cli style: Up and Down walk the history, Enter runs. */
export function RedisConsole({
	serviceId,
	db,
	forbidden,
	onForbidden,
}: {
	serviceId: string;
	db: number;
	forbidden: boolean;
	onForbidden: () => void;
}) {
	const command = useRedisCommand(serviceId);
	const [line, setLine] = useState("");
	const [ran, setRan] = useState<Ran[]>([]);
	const [history, setHistory] = useState<string[]>(() => {
		try {
			return JSON.parse(localStorage.getItem(HISTORY_KEY(serviceId)) ?? "[]");
		} catch {
			return [];
		}
	});
	const [at, setAt] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const end = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a reply lands.
	useEffect(() => {
		// Chromium's scrollIntoView returns a promise, which must not reach React as a cleanup.
		void end.current?.scrollIntoView({ block: "end" });
	}, [ran]);

	if (forbidden)
		return (
			<EmptyState
				icon={SquareTerminal}
				title="Commands need write access"
				description="Your role can browse this database but not run commands on it."
				className="m-auto"
			/>
		);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		let argv: string[];
		try {
			argv = parseArgv(line);
		} catch (err) {
			return setError((err as Error).message);
		}
		if (!argv.length) return;
		const id = Date.now();
		const text = line.trim();
		const nextHistory = [...history.filter((h) => h !== text), text].slice(-50);
		setHistory(nextHistory);
		try {
			localStorage.setItem(HISTORY_KEY(serviceId), JSON.stringify(nextHistory));
		} catch {}
		setAt(null);
		setLine("");
		setRan((r) => [...r, { id, db, line: text }]);
		command.mutate(
			{ db, argv },
			{
				onSuccess: (res) =>
					setRan((r) =>
						r.map((x) =>
							x.id === id ? { ...x, reply: res.reply, ms: res.durationMs } : x,
						),
					),
				onError: (err) => {
					if (err instanceof ApiError && err.status === 403) onForbidden();
					setRan((r) =>
						r.map((x) =>
							x.id === id
								? {
										...x,
										error: err.message.replace(/^database command: /, ""),
									}
								: x,
						),
					);
				},
			},
		);
	};
	const recall = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
		if (!history.length) return;
		e.preventDefault();
		const i =
			e.key === "ArrowUp"
				? Math.max(0, (at ?? history.length) - 1)
				: at === null
					? null
					: at + 1 >= history.length
						? null
						: at + 1;
		setAt(i);
		setLine(i === null ? "" : (history[i] ?? ""));
	};

	return (
		<section
			aria-label="Redis commands"
			className="flex min-w-0 flex-1 flex-col"
		>
			<div
				className={cn("min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4", MONO)}
				aria-live="polite"
			>
				{!ran.length ? (
					<div className="grid h-full place-items-center text-center font-sans text-sm text-muted-foreground">
						<p className="max-w-sm text-pretty">
							Run one command against db{db}, such as{" "}
							<code className={MONO}>HGETALL session:42</code>. Reads and key
							writes only: FLUSHALL, CONFIG, KEYS, EVAL and other server
							commands are refused.
						</p>
					</div>
				) : (
					<ol className="grid gap-3">
						{ran.map((r) => (
							<li key={r.id}>
								<div className="flex items-baseline gap-2">
									<span className="text-muted-foreground tabular">
										db{r.db}&gt;
									</span>
									<span className="min-w-0 break-all">{r.line}</span>
									{r.ms !== undefined && (
										<span className="ml-auto shrink-0 font-sans text-[11px] text-muted-foreground tabular">
											{r.ms < 1 ? "<1" : Math.round(r.ms)} ms
										</span>
									)}
								</div>
								<div className="mt-1 pl-4">
									{r.error ? (
										<span className="text-bad-text">{r.error}</span>
									) : r.reply ? (
										<Resp value={r.reply} />
									) : (
										<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
									)}
								</div>
							</li>
						))}
					</ol>
				)}
				<div ref={end} />
			</div>
			<form onSubmit={submit} className="grid gap-1 border-t px-3 py-2 sm:px-4">
				<label
					htmlFor="redis-command"
					className="flex h-9 items-center rounded-lg ring-1 ring-input transition-shadow duration-(--duration-quick) focus-within:ring-2 focus-within:ring-ring"
				>
					<span
						className={cn("shrink-0 pl-3 text-muted-foreground tabular", MONO)}
					>
						db{db}&gt;
					</span>
					<span className="sr-only">Command</span>
					<Input
						id="redis-command"
						value={line}
						onChange={(e) => {
							setLine(e.target.value);
							setError(null);
						}}
						onKeyDown={recall}
						placeholder="GET user:1"
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						autoComplete="off"
						aria-invalid={!!error}
						className={cn(
							"h-9 border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 dark:bg-transparent",
							MONO,
						)}
					/>
					<Button
						type="submit"
						size="sm"
						variant="ghost"
						className="mr-1"
						disabled={!line.trim()}
					>
						Run
					</Button>
				</label>
				<p className="min-h-4 text-xs text-muted-foreground">
					{error ? (
						<span role="alert" className="text-bad-text">
							{error}
						</span>
					) : (
						"Enter runs. Up and Down walk your history. Every command is audited."
					)}
				</p>
			</form>
		</section>
	);
}

/** A reply as redis-cli prints it: (integer), (nil), quoted strings, numbered arrays. */
function Resp({ value }: { value: RespValue }): ReactNode {
	switch (value.type) {
		case "null":
			return <span className="text-muted-foreground">(nil)</span>;
		case "integer":
			return (
				<span>
					<span className="text-muted-foreground">(integer) </span>
					<span className="tabular">{value.value}</span>
				</span>
			);
		case "error":
			return <span className="text-bad-text">(error) {value.value}</span>;
		case "string":
			return isBinary(value.value) ? (
				<BytesText value={value.value} />
			) : (
				<span className="break-all text-ok-text">
					{JSON.stringify(value.value)}
				</span>
			);
		case "array":
			if (!value.items.length)
				return <span className="text-muted-foreground">(empty array)</span>;
			return (
				<ol className="grid gap-0.5">
					{value.items.map((item, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: replies are positional.
						<li key={i} className="flex gap-2">
							<span className="shrink-0 text-muted-foreground tabular">
								{i + 1})
							</span>
							<span className="min-w-0">
								<Resp value={item} />
							</span>
						</li>
					))}
				</ol>
			);
	}
}

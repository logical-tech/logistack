import type { RowFilter, RowSort } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	Database,
	Dices,
	Loader2,
	Maximize2,
	Minimize2,
	Plus,
	RotateCw,
	SquareTerminal,
	Unplug,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { ENGINE } from "@/components/projects/service-list";
import { Segmented } from "@/components/segmented";
import { ServiceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { type DocumentsFind, reasonOf, schemaQuery } from "@/lib/api/database";
import {
	type ServiceOverview,
	useServiceMutation,
} from "@/lib/api/service-ops";
import { cn } from "@/lib/utils";
import { EMPTY_STAGED, type Staged } from "./cells";
import { DataGrid } from "./data-grid";
import {
	type DbObject,
	DropDatabaseDialog,
	DropObjectDialog,
	dialectOf,
	NewDatabaseDialog,
	NewTableDialog,
	templateSql,
} from "./ddl";
import { DocumentList } from "./document-list";
import { DumpRestore } from "./dump-restore";
import { KeyBrowser, RedisConsole } from "./key-browser";
import { RoleWizard } from "./role-wizard";
import { RolesView } from "./roles-view";
import { SchemaDiagram } from "./schema-diagram";
import { SchemaTree, TablePicker, type TreeActions } from "./schema-tree";
import { defaultSchema } from "./sql-editor";
import { prependSqlDraft, SqlPanel } from "./sql-panel";
import { PresetDialog, sqlDialectOf } from "./test-data";

export type DatabaseView = "data" | "diagram" | "sql" | "roles";

export type DatabaseLocation = {
	view: DatabaseView;
	/** Postgres: the database browsed, when not the service's default one. */
	database: string | undefined;
	schema: string | undefined;
	table: string | undefined;
	sort: RowSort[];
	filter: RowFilter[];
	/** MongoDB's find: Extended JSON filter, sort and projection. */
	find: DocumentsFind;
	/** Redis: the SCAN pattern; `schema` is the logical database. */
	match: string;
	/** Roles view: the chosen role's `roleKey`. */
	role: string | undefined;
	/** Roles view: the new-role wizard is open, at `step`. */
	newRole: boolean;
	step: string | undefined;
};

const errorText = (e: unknown) =>
	e instanceof Error ? e.message : "Something went wrong.";

/** The Database tab: a schema tree beside a grid of the chosen table's rows. */
export function ServiceDatabase({
	service,
	at,
	onNavigate,
}: {
	service: ServiceOverview;
	at: DatabaseLocation;
	onNavigate: (
		next: Partial<DatabaseLocation>,
		opts?: { replace?: boolean },
	) => void;
}) {
	const spec = service.spec.kind === "database" ? service.spec : null;
	const supported =
		spec?.engine === "postgres" ||
		spec?.engine === "mysql" ||
		spec?.engine === "mariadb" ||
		spec?.engine === "mongo" ||
		spec?.engine === "redis" ||
		spec?.engine === "libsql";
	const running = service.status.observed === "running";
	const [redeployed, setRedeployed] = useState(false);
	const schema = useQuery({
		...schemaQuery(service.id, at.database),
		enabled: supported && running,
		// After a redeploy, keep asking until the service has joined the network.
		refetchInterval: (q) =>
			redeployed && reasonOf(q.state.error) === "unreachable" ? 3000 : false,
	});
	const deploy = useServiceMutation(service.id, () =>
		api.serviceOps.deploy(service.id),
	);
	// Each table keeps its own staged edits, so moving between tables loses nothing.
	const [staged, setStaged] = useState<Record<string, Staged>>({});
	// The web app learns a missing write grant from the api's 403 on the first save.
	const [forbidden, setForbidden] = useState(false);
	const [newTable, setNewTable] = useState<string | null>(null);
	const [newDatabase, setNewDatabase] = useState(false);
	const [dropDatabase, setDropDatabase] = useState<string | null>(null);
	const [dropObject, setDropObject] = useState<DbObject | null>(null);
	const [presetting, setPresetting] = useState(false);
	// Full screen: the explorer covers the page, so wide tables show more columns and rows.
	const [full, setFull] = useState(false);
	useEffect(() => {
		if (!full) return;
		const onKey = (e: KeyboardEvent) => {
			// Esc closes an open dialog or menu first.
			if (
				e.key === "Escape" &&
				!document.querySelector("[role=dialog], [role=menu], [role=listbox]")
			)
				setFull(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [full]);
	const engine = spec ? ENGINE[spec.engine] : "This engine";
	// Dumps run in the replica itself, so they work before the explorer can connect.
	const bar = (leading?: ReactNode) => (
		<div className="mb-3 flex items-center gap-2">
			{leading}
			{spec && running && (
				<div className="ml-auto flex items-center gap-1.5">
					<DumpRestore
						serviceId={service.id}
						name={service.name}
						engine={spec.engine}
					/>
					{schema.isSuccess && (
						<Button
							variant="outline"
							size="icon-sm"
							aria-pressed={full}
							aria-label={full ? "Exit full screen" : "Full screen"}
							title={full ? "Exit full screen (Esc)" : "Full screen"}
							onClick={() => setFull((x) => !x)}
						>
							{full ? <Minimize2 /> : <Maximize2 />}
						</Button>
					)}
				</div>
			)}
		</div>
	);

	if (!supported)
		return (
			<>
				{running && bar()}
				<EmptyState
					icon={Database}
					title={`Browsing ${engine} is coming soon`}
					description={
						running
							? `Download a dump or restore one from the menu above. Browsing and editing ${engine} follow in the next releases.`
							: "The explorer reads and edits Postgres, MySQL, MariaDB and libSQL tables, MongoDB collections and Redis keys."
					}
				/>
			</>
		);
	if (!running)
		return (
			<EmptyState
				icon={Database}
				title={
					service.status.observed === "starting"
						? `${engine} is starting`
						: `${engine} isn't running`
				}
				description={
					<>
						Tables appear here once the service reports healthy.
						<span className="mt-3 flex justify-center">
							<ServiceStatus status={service.status.observed} />
						</span>
					</>
				}
			/>
		);
	if (schema.isPending)
		return (
			<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
				<SkeletonRows rows={8} />
			</div>
		);
	if (schema.isError)
		return (
			<>
				{bar()}
				{reasonOf(schema.error) === "unreachable" ? (
					<EmptyState
						icon={Unplug}
						title={
							redeployed
								? "Waiting for the redeploy"
								: "Redeploy to open the explorer"
						}
						description={
							redeployed
								? "The explorer connects as soon as the new deployment is healthy. Data stays on its volume."
								: "This database was deployed before the explorer existed, so it isn't on the explorer's private network yet. A redeploy attaches it; data stays on its volume."
						}
					>
						<Button
							disabled={deploy.isPending || redeployed}
							onClick={() =>
								deploy.mutate(undefined, {
									onSuccess: () => {
										setRedeployed(true);
										toast.success(`Redeploying ${service.name}`);
									},
									onError: (e) =>
										toast.error("Couldn't redeploy", {
											description: errorText(e),
										}),
								})
							}
						>
							{deploy.isPending || redeployed ? (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							) : (
								<RotateCw data-icon="inline-start" />
							)}
							{redeployed ? "Redeploying" : "Redeploy"}
						</Button>
					</EmptyState>
				) : at.database && reasonOf(schema.error) === "missing" ? (
					<EmptyState
						icon={Database}
						title={`${at.database} doesn't exist`}
						description="It may have been dropped. The service's own database is still there."
					>
						<Button
							variant="outline"
							onClick={() =>
								onNavigate({
									database: undefined,
									schema: undefined,
									table: undefined,
									sort: [],
									filter: [],
								})
							}
						>
							Open the default database
						</Button>
					</EmptyState>
				) : (
					<EmptyState
						icon={Database}
						title="Couldn't read the schema"
						description={errorText(schema.error)}
					>
						<Button variant="outline" onClick={() => schema.refetch()}>
							Try again
						</Button>
					</EmptyState>
				)}
			</>
		);

	const frame = cn(
		"isolate flex overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border",
		full ? "min-h-0 flex-1" : "h-[min(76dvh,46rem)] min-h-[28rem]",
	);
	const shell = (node: ReactNode) =>
		full ? (
			<div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background p-3 sm:p-4">
				{node}
			</div>
		) : (
			node
		);
	if (schema.data.engine === "redis") {
		const db = Math.min(
			Number(at.schema) || 0,
			Math.max(0, schema.data.schemas.length - 1),
		);
		return shell(
			<>
				{bar(
					<Segmented
						label="Explorer view"
						value={at.view}
						onChange={(view) => onNavigate({ view })}
						options={[
							{ value: "data", label: "Keys" },
							{ value: "sql", label: "Command" },
						]}
					/>,
				)}
				<div className={frame}>
					{at.view === "sql" ? (
						<RedisConsole
							serviceId={service.id}
							db={db}
							forbidden={forbidden}
							onForbidden={() => setForbidden(true)}
						/>
					) : (
						<KeyBrowser
							key={db}
							serviceId={service.id}
							schema={schema.data}
							db={db}
							match={at.match}
							onNavigate={(next) =>
								onNavigate({
									...(next.db !== undefined && { schema: String(next.db) }),
									...(next.match !== undefined && { match: next.match }),
								})
							}
							forbidden={forbidden}
							onForbidden={() => setForbidden(true)}
						/>
					)}
				</div>
			</>,
		);
	}

	// Mongo has no SQL editor: finds run from the document list.
	const mongo = schema.data.engine === "mongo";
	// One database, token auth: no roles, and DDL goes through the SQL editor.
	const sqlite = schema.data.engine === "libsql";
	const noun = mongo ? "collections" : "tables";
	const data = schema.data;
	const dialect = dialectOf(data);
	const pg = dialect === "postgres";
	const markForbidden = () => setForbidden(true);
	const databases = data.databases ?? [];
	const switcher = mongo
		? bar()
		: bar(
				<>
					<Segmented
						label="Explorer view"
						value={at.view}
						onChange={(view) =>
							onNavigate({ view, newRole: false, step: undefined })
						}
						options={[
							{ value: "data", label: "Data" },
							{ value: "diagram", label: "Diagram" },
							{ value: "sql", label: "SQL" },
							...(sqlite ? [] : [{ value: "roles" as const, label: "Roles" }]),
						]}
					/>
					{sqlDialectOf(data) && (
						<Button
							variant="outline"
							size="sm"
							disabled={forbidden}
							onClick={() => setPresetting(true)}
						>
							<Dices data-icon="inline-start" />
							Sample dataset
						</Button>
					)}
					{/* Data and SQL pick the database in the tree and editor; these views have no tree. */}
					{(at.view === "diagram" || at.view === "roles") &&
						databases.length > 1 && (
							<Select
								value={data.database}
								onValueChange={(name) =>
									onNavigate({
										database: name === data.defaultDatabase ? undefined : name,
										schema: undefined,
										table: undefined,
										sort: [],
										filter: [],
										newRole: false,
										step: undefined,
									})
								}
							>
								<SelectTrigger size="sm" className="w-44" aria-label="Database">
									<Database data-icon="inline-start" />
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{databases.map((d) => (
										<SelectItem key={d} value={d}>
											{d}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
				</>,
			);
	const dialogs = !mongo && (
		<>
			{sqlDialectOf(data) && (
				<PresetDialog
					open={presetting}
					onOpenChange={setPresetting}
					serviceId={service.id}
					data={data}
					schema={at.schema ?? defaultSchema(data)}
					onCreated={(table) =>
						onNavigate({
							view: "data",
							schema: at.schema ?? defaultSchema(data),
							table,
							sort: [],
							filter: [],
						})
					}
				/>
			)}
			{newTable !== null && (
				<NewTableDialog
					open
					onOpenChange={(o) => !o && setNewTable(null)}
					serviceId={service.id}
					database={at.database}
					dialect={dialect}
					schema={newTable}
					existing={
						data.schemas
							.find((s) => s.name === newTable)
							?.tables.map((t) => t.name) ?? []
					}
					onCreated={(table) =>
						onNavigate({
							view: "data",
							schema: newTable,
							table,
							sort: [],
							filter: [],
						})
					}
					onForbidden={markForbidden}
				/>
			)}
			<NewDatabaseDialog
				open={newDatabase}
				onOpenChange={setNewDatabase}
				serviceId={service.id}
				noun="database"
				onCreated={(name) =>
					pg &&
					onNavigate({
						database: name,
						schema: undefined,
						table: undefined,
						sort: [],
						filter: [],
					})
				}
				onForbidden={markForbidden}
			/>
			<DropDatabaseDialog
				name={dropDatabase}
				noun="database"
				serviceId={service.id}
				onOpenChange={(o) => !o && setDropDatabase(null)}
				onDropped={(name) => {
					setDropDatabase(null);
					if (pg && name === at.database)
						onNavigate({
							database: undefined,
							schema: undefined,
							table: undefined,
							sort: [],
							filter: [],
						});
				}}
			/>
			<DropObjectDialog
				object={dropObject}
				dialect={dialect}
				serviceId={service.id}
				database={at.database}
				onOpenChange={(o) => !o && setDropObject(null)}
				onDropped={(o) => {
					setDropObject(null);
					if (
						o.kind === "table" &&
						o.schema === at.schema &&
						o.name === at.table
					)
						onNavigate({ table: undefined, sort: [], filter: [] });
				}}
				onForbidden={markForbidden}
			/>
		</>
	);
	const firstSchema =
		data.schemas.find((s) => s.name === defaultSchema(data))?.name ??
		data.schemas[0]?.name;
	const openSqlWith = (text: string) => {
		prependSqlDraft(service.id, data, text);
		onNavigate({ view: "sql" });
	};
	const actions: TreeActions | undefined =
		mongo || sqlite
			? undefined
			: {
					dialect,
					databases: data.databases,
					defaultDatabase: data.defaultDatabase,
					onDatabase: (name) =>
						onNavigate({
							database: name === data.defaultDatabase ? undefined : name,
							schema: undefined,
							table: undefined,
							sort: [],
							filter: [],
						}),
					onNewDatabase: () => setNewDatabase(true),
					onDropDatabase: setDropDatabase,
					onNew: (s, what) =>
						what === "table"
							? setNewTable(s)
							: openSqlWith(templateSql(dialect, what, s)),
					onDrop: setDropObject,
				};

	if (at.view === "diagram" && !mongo)
		return shell(
			<>
				{switcher}
				<section aria-label="Schema diagram" className={frame}>
					<SchemaDiagram
						key={at.database ?? ""}
						schema={data}
						focus={at.schema}
						onOpen={(schema, table) =>
							onNavigate({ view: "data", schema, table, sort: [], filter: [] })
						}
					/>
				</section>
			</>,
		);

	if (at.view === "roles" && !mongo && !sqlite && at.newRole)
		return shell(
			<>
				{switcher}
				<section
					aria-label={pg ? "New role" : "New account"}
					className="rounded-xl bg-card p-5 shadow-card ring-1 ring-border sm:p-8"
				>
					<div className="mb-8 flex items-center gap-3">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Back to roles"
							onClick={() => onNavigate({ newRole: false, step: undefined })}
						>
							<ArrowLeft />
						</Button>
						<h2 className="text-base font-semibold">
							{pg
								? `New role on ${service.name}`
								: `New account on ${service.name}`}
						</h2>
					</div>
					<RoleWizard
						key={at.database ?? ""}
						serviceId={service.id}
						schema={data}
						database={at.database}
						step={at.step}
						onStepChange={(step, opts) => onNavigate({ step }, opts)}
						onDone={(role) =>
							onNavigate({ newRole: false, step: undefined, role })
						}
					/>
				</section>
			</>,
		);

	if (at.view === "roles" && !mongo && !sqlite)
		return shell(
			<>
				{switcher}
				<div className={frame}>
					<RolesView
						serviceId={service.id}
						schema={data}
						database={at.database}
						selected={at.role}
						onSelect={(role) => onNavigate({ role }, { replace: true })}
						onCreate={() => onNavigate({ newRole: true, step: undefined })}
						forbidden={forbidden}
						onForbidden={markForbidden}
					/>
				</div>
			</>,
		);

	if (at.view === "sql" && !mongo)
		return shell(
			<>
				{switcher}
				<section aria-label="SQL editor" className={frame}>
					<SqlPanel
						key={at.database ?? ""}
						serviceId={service.id}
						database={at.database}
						schema={data}
						forbidden={forbidden}
						onForbidden={markForbidden}
					/>
				</section>
			</>,
		);

	const schemas = data.schemas;
	const all = schemas.flatMap((s) =>
		s.tables.map((t) => ({ schema: s.name, table: t })),
	);
	const current =
		all.find((x) => x.schema === at.schema && x.table.name === at.table) ??
		all.find((x) => x.schema === defaultSchema(data)) ??
		all[0];
	if (!current && mongo)
		return shell(
			<>
				{bar()}
				<EmptyState
					icon={Database}
					title="No collections yet"
					description="Collections your app writes to appear here, ready to browse and edit. A dump restored from the menu above fills them too."
				/>
			</>,
		);
	const tableKey = current ? `${current.schema}.${current.table.name}` : "";
	const pending = (key: string) => {
		const s = staged[key];
		return s
			? Object.keys(s.edits).length +
					Object.keys(s.deletes).length +
					s.inserts.length
			: 0;
	};
	const select = (s: string, t: string) =>
		onNavigate({ schema: s, table: t, sort: [], filter: [], find: {} });
	const selected = current
		? { schema: current.schema, table: current.table.name }
		: undefined;

	return shell(
		<>
			{switcher}
			<div className={frame}>
				<SchemaTree
					key={at.database ?? ""}
					noun={noun}
					database={mongo ? service.name : data.database}
					schemas={schemas}
					selected={selected}
					pending={pending}
					onSelect={select}
					actions={actions}
				/>
				{current && selected ? (
					<section
						aria-label={`${mongo ? "Documents" : "Rows"} of ${tableKey}`}
						className="flex min-w-0 flex-1 flex-col"
					>
						<div className="border-b px-3 py-2 md:hidden">
							<TablePicker
								schemas={schemas}
								selected={selected}
								onSelect={select}
								label={mongo ? "Collection" : "Table"}
							/>
						</div>
						{mongo ? (
							<DocumentList
								key={tableKey}
								serviceId={service.id}
								database={current.schema}
								collection={current.table}
								find={at.find}
								onFind={(find) => onNavigate({ find })}
								forbidden={forbidden}
								onForbidden={markForbidden}
							/>
						) : (
							<DataGrid
								key={`${at.database ?? ""}:${tableKey}`}
								serviceId={service.id}
								database={at.database}
								schema={current.schema}
								table={current.table}
								sort={at.sort}
								filter={at.filter}
								onSort={(sort) => onNavigate({ sort })}
								onFilter={(filter) => onNavigate({ filter })}
								staged={staged[tableKey] ?? EMPTY_STAGED}
								onStage={(next) =>
									setStaged((all) => ({ ...all, [tableKey]: next }))
								}
								forbidden={forbidden}
								onForbidden={markForbidden}
							/>
						)}
					</section>
				) : (
					<section
						aria-label={`${data.database} is empty`}
						className="grid min-w-0 flex-1 place-items-center overflow-y-auto p-4 sm:p-8"
					>
						<EmptyState
							icon={Database}
							title={`${data.database} has no tables yet`}
							description="Create one here, or write any DDL in the SQL editor. Tables your app's migrations create show up here too."
							className="w-full max-w-xl bg-transparent dark:bg-transparent"
						>
							{firstSchema && (
								<Button
									disabled={forbidden}
									onClick={() => setNewTable(firstSchema)}
								>
									<Plus data-icon="inline-start" />
									Create table
								</Button>
							)}
							<Button
								variant="outline"
								onClick={() => onNavigate({ view: "sql" })}
							>
								<SquareTerminal data-icon="inline-start" />
								Open SQL editor
							</Button>
							{sqlDialectOf(data) && (
								<Button
									variant="outline"
									disabled={forbidden}
									onClick={() => setPresetting(true)}
								>
									<Dices data-icon="inline-start" />
									Add a sample dataset
								</Button>
							)}
						</EmptyState>
					</section>
				)}
			</div>
			{dialogs}
		</>,
	);
}

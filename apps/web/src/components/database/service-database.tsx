import type { RowFilter, RowSort } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import {
	Database,
	Loader2,
	Plus,
	RotateCw,
	SquareTerminal,
	Unplug,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/panel";
import { ENGINE } from "@/components/projects/service-list";
import { Segmented } from "@/components/segmented";
import { ServiceStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type DocumentsFind, reasonOf, schemaQuery } from "@/lib/api/database";
import {
	type ServiceOverview,
	useServiceMutation,
} from "@/lib/api/service-ops";
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
import { SchemaTree, TablePicker, type TreeActions } from "./schema-tree";
import { defaultSchema } from "./sql-editor";
import { prependSqlDraft, SqlPanel } from "./sql-panel";

export type DatabaseView = "data" | "sql";

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
	onNavigate: (next: Partial<DatabaseLocation>) => void;
}) {
	const spec = service.spec.kind === "database" ? service.spec : null;
	const supported =
		spec?.engine === "postgres" ||
		spec?.engine === "mysql" ||
		spec?.engine === "mariadb" ||
		spec?.engine === "mongo" ||
		spec?.engine === "redis";
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
	const engine = spec ? ENGINE[spec.engine] : "This engine";
	// Dumps run in the replica itself, so they work before the explorer can connect.
	const bar = (leading?: ReactNode) => (
		<div className="mb-3 flex items-center gap-2">
			{leading}
			{spec && running && (
				<div className="ml-auto">
					<DumpRestore
						serviceId={service.id}
						name={service.name}
						engine={spec.engine}
					/>
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
							: "The explorer reads and edits Postgres, MySQL and MariaDB tables, MongoDB collections and Redis keys."
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

	const frame =
		"isolate flex h-[min(76dvh,46rem)] min-h-[28rem] overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border";
	if (schema.data.engine === "redis") {
		const db = Math.min(
			Number(at.schema) || 0,
			Math.max(0, schema.data.schemas.length - 1),
		);
		return (
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
			</>
		);
	}

	// Mongo has no SQL editor: finds run from the document list.
	const mongo = schema.data.engine === "mongo";
	const noun = mongo ? "collections" : "tables";
	const data = schema.data;
	const dialect = dialectOf(data);
	const pg = dialect === "postgres";
	const markForbidden = () => setForbidden(true);
	const switcher = mongo
		? bar()
		: bar(
				<Segmented
					label="Explorer view"
					value={at.view}
					onChange={(view) => onNavigate({ view })}
					options={[
						{ value: "data", label: "Data" },
						{ value: "sql", label: "SQL" },
					]}
				/>,
			);
	const dialogs = !mongo && (
		<>
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
	const actions: TreeActions | undefined = mongo
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

	if (at.view === "sql" && !mongo)
		return (
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
			</>
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
		return (
			<>
				{bar()}
				<EmptyState
					icon={Database}
					title="No collections yet"
					description="Collections your app writes to appear here, ready to browse and edit. A dump restored from the menu above fills them too."
				/>
			</>
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

	return (
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
						</EmptyState>
					</section>
				)}
			</div>
			{dialogs}
		</>
	);
}

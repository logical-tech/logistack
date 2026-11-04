import {
	type DatabaseSchema,
	RoleHost,
	RoleName,
	RolePassword,
} from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { UserRound, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
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
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { ApiError } from "@/lib/api";
import { databaseApi } from "@/lib/api/database";
import { dialectOf } from "./ddl";
import {
	ACCESS_LABEL,
	ACCESS_LEVELS,
	type AccessLevel,
	accessSql,
	attributesSql,
	generatePassword,
	membershipSql,
	roleKey,
	script,
} from "./roles";
import { PasswordField, runStatements } from "./roles-view";

type Values = {
	name: string;
	host: string;
	kind: "login" | "group";
	password: string;
	createDb: boolean;
	createRole: boolean;
	groups: string[];
	access: Record<string, AccessLevel>;
};

const statementsFor = (schema: DatabaseSchema, v: Values) => {
	const d = dialectOf(schema);
	const role = { name: v.name, ...(d === "mysql" && { host: v.host }) };
	const created = {
		login: v.kind === "login",
		superuser: false,
		createDb: false,
		createRole: false,
	};
	return [
		...(d === "postgres"
			? [
					...attributesSql(role, created, {
						...created,
						createDb: v.createDb,
						createRole: v.createRole,
					}),
					...membershipSql(role, [], v.groups),
				]
			: []),
		...Object.entries(v.access).flatMap(([s, level]) =>
			level === "none" ? [] : accessSql(d, role, s, "none", level),
		),
	];
};

/** Creates a role in a few steps: who it is, its password, what it may touch, then a review. */
export function RoleWizard({
	serviceId,
	schema,
	database,
	step,
	onStepChange,
	onDone,
}: {
	serviceId: string;
	schema: DatabaseSchema;
	database: string | undefined;
	step: string | undefined;
	onStepChange: (step: string, opts: { replace: boolean }) => void;
	onDone: (key: string | undefined) => void;
}) {
	const qc = useQueryClient();
	const pg = dialectOf(schema) === "postgres";
	const roles = schema.roles ?? [];
	const schemas = schema.schemas.map((s) => s.name);
	const loginOf = (v: Values) => !pg || v.kind === "login";

	const steps: WizardStep<Values>[] = [
		{
			id: "role",
			title: pg ? "Role" : "Account",
			description: pg
				? "A login role is what an app signs in as. A group role holds privileges that login roles inherit."
				: "MySQL accounts are a name and the host they may connect from.",
			schema: (v) =>
				z.object({
					name: RoleName.refine(
						(n) =>
							!roles.some((r) => r.name === n && (pg || r.host === v.host)),
						"A role with this name already exists",
					),
					...(pg ? {} : { host: RoleHost }),
				}),
			render: (w) => (
				<div className="grid max-w-xl gap-6">
					<Field
						id="wz-name"
						label="Name"
						error={w.error("name")}
						hint="Letters, digits and _; one per app keeps access easy to revoke."
					>
						<Input
							{...w.bind("name")}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
							autoFocus
						/>
					</Field>
					{pg ? (
						<ChoiceGroup
							label="Kind"
							value={w.values.kind}
							onChange={(kind) => w.set("kind", kind)}
							choices={[
								{
									value: "login",
									title: "Login role",
									description: "Signs in with a password. For apps and people.",
									icon: UserRound,
								},
								{
									value: "group",
									title: "Group role",
									description: "Can't sign in; others inherit its privileges.",
									icon: UsersRound,
								},
							]}
						/>
					) : (
						<Field
							id="wz-host"
							label="Host"
							error={w.error("host")}
							hint="% allows any host. Services on LogiStack reach the database over its private network, so % is usually right."
						>
							<Input
								{...w.bind("host")}
								autoCapitalize="none"
								spellCheck={false}
								className="font-mono"
							/>
						</Field>
					)}
				</div>
			),
		},
		{
			id: "password",
			title: "Password",
			description: pg
				? "The engine only ever receives a SCRAM-SHA-256 hash of it, and it never reaches the audit log."
				: "Sent once to create the account; it never reaches the audit log.",
			when: loginOf,
			schema: z.object({ password: RolePassword }),
			render: (w) => (
				<div className="max-w-xl">
					<PasswordField
						id="wz-password"
						value={w.values.password}
						onChange={(p) => w.set("password", p)}
						error={w.error("password")}
					/>
				</div>
			),
		},
		{
			id: "access",
			title: "Access",
			description: pg
				? `Privileges in ${schema.database}. Other databases of the instance are set from their own Roles view.`
				: "Privileges on every table of each schema. Leave a schema at No access to keep it out of reach.",
			render: (w) => (
				<div className="grid max-w-2xl gap-8">
					<ul className="divide-y rounded-lg ring-1 ring-border">
						{schemas.map((s) => (
							<li key={s} className="flex items-center gap-4 px-4 py-2.5">
								<span className="min-w-0 flex-1 truncate font-mono text-sm">
									{s}
								</span>
								<Select
									value={w.values.access[s] ?? "none"}
									onValueChange={(level) =>
										w.set("access", {
											...w.values.access,
											[s]: level as AccessLevel,
										})
									}
								>
									<SelectTrigger
										size="sm"
										className="w-36"
										aria-label={`Access to ${s}`}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ACCESS_LEVELS.map((l) => (
											<SelectItem key={l} value={l}>
												{ACCESS_LABEL[l]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</li>
						))}
					</ul>
					{pg && roles.length > 0 && (
						<fieldset className="grid gap-3">
							<legend className="mb-1 text-sm font-medium">Member of</legend>
							<div className="grid gap-2 sm:grid-cols-2">
								{roles.map((r) => (
									<div
										key={r.name}
										className="flex items-center gap-2.5 text-sm"
									>
										<Checkbox
											id={`wz-group-${r.name}`}
											checked={w.values.groups.includes(r.name)}
											onCheckedChange={(on) =>
												w.set(
													"groups",
													on
														? [...w.values.groups, r.name].sort()
														: w.values.groups.filter((g) => g !== r.name),
												)
											}
										/>
										<label
											htmlFor={`wz-group-${r.name}`}
											className="min-w-0 truncate"
										>
											{r.name}
											{!r.login && (
												<span className="ml-2 text-xs text-muted-foreground">
													group
												</span>
											)}
										</label>
									</div>
								))}
							</div>
						</fieldset>
					)}
					{pg && (
						<div className="grid gap-3">
							{(
								[
									["createDb", "Create databases"],
									["createRole", "Create roles"],
								] as const
							).map(([key, label]) => (
								<div key={key} className="flex items-center gap-3 text-sm">
									<Switch
										id={`wz-${key}`}
										checked={w.values[key]}
										onCheckedChange={(on) => w.set(key, on)}
									/>
									<label htmlFor={`wz-${key}`}>{label}</label>
								</div>
							))}
						</div>
					)}
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"The role is created first, then these statements run in one transaction.",
			render: (w) => {
				const v = w.values;
				const sql = statementsFor(schema, v);
				const granted = Object.entries(v.access).filter(
					([, l]) => l !== "none",
				);
				return (
					<div className="grid max-w-2xl gap-5">
						<Summary
							w={w}
							sections={[
								{
									stepId: "role",
									title: pg ? "Role" : "Account",
									rows: [
										{
											label: "Name",
											value: (
												<span className="font-mono">
													{roleKey({
														name: v.name,
														...(!pg && { host: v.host }),
													})}
												</span>
											),
										},
										...(pg
											? [
													{
														label: "Kind",
														value:
															v.kind === "login" ? "Login role" : "Group role",
													},
												]
											: []),
									],
								},
								...(loginOf(v)
									? [
											{
												stepId: "password",
												title: "Password",
												rows: [
													{
														label: "Password",
														value: `${v.password.length} characters`,
													},
												],
											},
										]
									: []),
								{
									stepId: "access",
									title: "Access",
									rows: [
										{
											label: "Schemas",
											value: granted.length
												? granted
														.map(
															([s, l]) =>
																`${s}: ${ACCESS_LABEL[l].toLowerCase()}`,
														)
														.join(", ")
												: "None yet",
										},
										...(pg
											? [
													{
														label: "Member of",
														value: v.groups.length
															? v.groups.join(", ")
															: "None",
													},
												]
											: []),
									],
								},
							]}
						/>
						{sql.length > 0 && (
							<pre className="max-h-64 overflow-auto rounded-lg bg-muted/50 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap ring-1 ring-border">
								{script(sql)}
							</pre>
						)}
					</div>
				);
			},
		},
	];

	return (
		<Wizard
			id={`new-role:${serviceId}:${database ?? ""}`}
			steps={steps}
			defaultValues={{
				name: "",
				host: "%",
				kind: "login",
				password: generatePassword(),
				createDb: false,
				createRole: false,
				groups: [],
				access: {},
			}}
			secretKeys={["password"]}
			step={step}
			onStepChange={onStepChange}
			finishLabel={pg ? "Create role" : "Create account"}
			onComplete={async (v) => {
				const host = pg ? undefined : v.host;
				const key = roleKey({ name: v.name, host });
				try {
					await databaseApi.createRole(serviceId, {
						name: v.name,
						...(host !== undefined && { host }),
						...(loginOf(v) && { password: v.password }),
						login: loginOf(v),
					});
				} catch (e) {
					throw e instanceof ApiError && e.status === 403
						? new Error("Creating roles needs admin on this service.")
						: e;
				}
				const sql = statementsFor(schema, v);
				try {
					if (sql.length) await runStatements(serviceId, database, sql);
					toast.success(`Created ${key}`);
				} catch (e) {
					toast.warning(`Created ${key}, but its access wasn't applied`, {
						description: `${e instanceof Error ? e.message : String(e)} Set it from the role's page.`,
					});
				}
				await qc.invalidateQueries({ queryKey: ["database", serviceId] });
				onDone(key);
			}}
		/>
	);
}

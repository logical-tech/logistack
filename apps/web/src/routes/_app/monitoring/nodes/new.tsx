import { SshHost, SshUser } from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleCheck, Crown, Loader2, Server } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import {
	JoinLog,
	PreflightList,
	SshKeyField,
} from "@/components/monitoring/add-server-parts";
import {
	LabelEditor,
	labelKeyError,
} from "@/components/monitoring/label-editor";
import { LabelChips } from "@/components/monitoring/node-parts";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, TestPanel } from "@/components/wizard/parts";
import {
	type TestResult,
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { ApiError, api } from "@/lib/api";
import type {
	NodeJoin,
	NodeJoinInput,
	NodeJoinStep,
	NodeRole,
} from "@/lib/api/types";
import { stepParam } from "@/lib/search";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/monitoring/nodes/new")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Add server" },
	component: AddServer,
});

type V = {
	name: string;
	host: string;
	port: string;
	sshUser: string;
	sshKeyId: string;
	role: NodeRole;
	labels: Record<string, string>;
};

const DEFAULTS: V = {
	name: "",
	host: "",
	port: "22",
	sshUser: "root",
	sshKeyId: "",
	role: "worker",
	labels: {},
};

const WIZARD_ID = "add-server";
// The run id lives beside the answers, not in them: answers sign the test results.
const JOIN_KEY = `wizard:${WIZARD_ID}:join`;

const serverSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name the server, e.g. fra-5.")
		.max(100, "100 characters at most."),
	host: z
		.string()
		.trim()
		.refine((h) => SshHost.safeParse(h).success, "An IP address or hostname."),
	port: z
		.string()
		.regex(/^\d+$/, "Use a number.")
		.refine(
			(p) => Number(p) >= 1 && Number(p) <= 65_535,
			"Ports go from 1 to 65535.",
		),
	sshUser: z
		.string()
		.trim()
		.refine(
			(u) => SshUser.safeParse(u).success,
			"A POSIX user name, like root or deploy.",
		),
	sshKeyId: z.string().min(1, "Choose a key or generate one."),
	labels: z
		.record(z.string(), z.string())
		.refine(
			(l) => Object.keys(l).every((k) => !labelKeyError(k)),
			"A label key is invalid.",
		),
});

const toInput = (v: V): NodeJoinInput => ({
	name: v.name.trim(),
	host: v.host.trim(),
	port: Number(v.port),
	sshUser: v.sshUser.trim(),
	sshKeyId: v.sshKeyId,
	role: v.role,
	labels: v.labels,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = (j: NodeJoin, step: NodeJoinStep) =>
	j.step === step && (j.state === "succeeded" || j.state === "failed");

function loadJoin(): NodeJoin | null {
	try {
		const raw = sessionStorage.getItem(JOIN_KEY);
		const j = raw ? (JSON.parse(raw) as NodeJoin) : null;
		// A run that already joined can't be retested; start a fresh one.
		return j && !(j.step === "bootstrap" && j.state === "succeeded") ? j : null;
	} catch {
		return null;
	}
}

function ServerStep({ w }: { w: WizardApi<V> }) {
	return (
		<div className="grid gap-8">
			<section className="grid gap-4" aria-labelledby="sec-connection">
				<h3 id="sec-connection" className="text-sm font-semibold">
					Connection
				</h3>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field
						id="wz-name"
						label="Name"
						error={w.error("name")}
						hint="Shown in LogiStack; the server's hostname stays as it is."
						className="sm:col-span-2"
					>
						<Input {...w.bind("name")} placeholder="fra-5" autoComplete="off" />
					</Field>
					<Field
						id="wz-host"
						label="IP address or hostname"
						error={w.error("host")}
						hint="Reachable from this server on the SSH port."
					>
						<Input
							{...w.bind("host")}
							placeholder="49.12.88.52"
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
						/>
					</Field>
					<div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-4">
						<Field id="wz-port" label="Port" error={w.error("port")}>
							<Input
								{...w.bind("port")}
								inputMode="numeric"
								className="tabular"
							/>
						</Field>
						<Field
							id="wz-sshUser"
							label="SSH user"
							error={w.error("sshUser")}
							hint="root, or a user with passwordless sudo."
						>
							<Input
								{...w.bind("sshUser")}
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
							/>
						</Field>
					</div>
				</div>
			</section>

			<section className="grid gap-4" aria-labelledby="sec-key">
				<h3 id="sec-key" className="text-sm font-semibold">
					Access
				</h3>
				<SshKeyField
					value={w.values.sshKeyId}
					onChange={(id) => w.set("sshKeyId", id)}
					sshUser={w.values.sshUser}
					error={w.error("sshKeyId")}
				/>
			</section>

			<section className="grid gap-4" aria-labelledby="sec-role">
				<h3 id="sec-role" className="text-sm font-semibold">
					Role and labels
				</h3>
				<ChoiceGroup
					label="Swarm role"
					value={w.values.role}
					onChange={(r) => w.set("role", r)}
					choices={[
						{
							value: "worker",
							title: "Worker",
							description:
								"Runs services. The right choice for almost every server.",
							icon: Server,
						},
						{
							value: "manager",
							title: "Manager",
							description:
								"Also keeps swarm state. Use an odd number of managers: 3 or 5.",
							icon: Crown,
						},
					]}
				/>
				<LabelEditor
					value={w.values.labels}
					onChange={(l) => w.set("labels", l)}
				/>
			</section>
		</div>
	);
}

function AddServer() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const qc = useQueryClient();
	const [join, setJoinState] = useState<NodeJoin | null>(loadJoin);
	const joinRef = useRef(join);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const setJoin = useCallback((j: NodeJoin | null) => {
		joinRef.current = j;
		setJoinState(j);
		try {
			if (j) sessionStorage.setItem(JOIN_KEY, JSON.stringify(j));
			else sessionStorage.removeItem(JOIN_KEY);
		} catch {}
	}, []);

	const steps = useMemo<WizardStep<V>[]>(() => {
		/** Polls the run until `step` settles; ~1 s, the cadence the API asks for. */
		async function follow(j: NodeJoin, step: NodeJoinStep): Promise<NodeJoin> {
			let current = j;
			while (!done(current, step)) {
				await sleep(1000);
				if (!alive.current) throw new Error("Left the wizard");
				current = await api.joins.get(current.id);
				setJoin(current);
			}
			return current;
		}

		async function start(step: NodeJoinStep): Promise<NodeJoin> {
			const j = joinRef.current;
			if (!j) throw new Error("Run the SSH test first.");
			const queued = await api.joins.run(j.id, step);
			setJoin(queued);
			return follow(queued, step);
		}

		return [
			{
				id: "server",
				title: "Server",
				description:
					"The server to add, how LogiStack reaches it over SSH, and what it will do in the cluster.",
				schema: serverSchema,
				render: (w) => <ServerStep w={w} />,
			},
			{
				id: "ssh",
				title: "Test SSH",
				description:
					"LogiStack connects with the key and records the server's host key, so later steps can't be redirected to another machine.",
				test: async (v): Promise<TestResult> => {
					const input = toInput(v);
					const existing = joinRef.current;
					let queued: NodeJoin;
					try {
						queued = existing
							? await api.joins.update(existing.id, input)
							: await api.joins.create(input);
					} catch (e) {
						if (!(e instanceof ApiError && e.status === 404)) throw e;
						queued = await api.joins.create(input);
					}
					setJoin(queued);
					const j = await follow(queued, "test");
					return j.state === "succeeded"
						? {
								ok: true,
								message: `Connected to ${input.sshUser}@${input.host}`,
								detail: j.log.at(-1),
							}
						: {
								ok: false,
								message: "Couldn't connect over SSH",
								detail: `${j.error ?? "The connection failed."} Check the address, the port and that the public key is in ~/.ssh/authorized_keys.`,
							};
				},
				render: (w) => (
					<TestPanel
						w={w}
						idle={
							<>
								Connects to{" "}
								<span className="font-mono text-foreground">
									{w.values.sshUser}@{w.values.host}:{w.values.port}
								</span>{" "}
								and runs nothing but a handshake.
							</>
						}
					/>
				),
			},
			{
				id: "preflight",
				title: "Preflight",
				description:
					"Checks the operating system, privileges, resources and swarm ports. Warnings let you continue; a failed check doesn't.",
				test: async (): Promise<TestResult> => {
					const j = await start("preflight");
					const fails = j.checks.filter((c) => c.status === "fail").length;
					const warns = j.checks.filter((c) => c.status === "warn").length;
					if (j.state === "failed" || fails)
						return {
							ok: false,
							message: fails
								? `${fails} check${fails === 1 ? "" : "s"} failed`
								: "Preflight couldn't run",
							detail: fails
								? "Fix the server, then run the checks again."
								: (j.error ?? undefined),
						};
					return {
						ok: true,
						message: warns
							? `Ready, with ${warns} warning${warns === 1 ? "" : "s"}`
							: "All checks passed",
					};
				},
				render: (w) => (
					<div className="grid gap-4">
						<TestPanel
							w={w}
							action="Run checks"
							idle="Reads the system over SSH. Nothing is installed or changed."
						/>
						{join && join.step !== "test" && (
							<PreflightList checks={join.checks} />
						)}
					</div>
				),
			},
			{
				id: "bootstrap",
				title: "Bootstrap",
				description:
					"Installs Docker, joins the swarm, applies labels and starts the LogiStack agent. It's safe to run again if it stops halfway.",
				test: async (): Promise<TestResult> => {
					const j = await start("bootstrap");
					await qc.invalidateQueries({ queryKey: ["nodes"] });
					return j.state === "succeeded"
						? { ok: true, message: `${j.name} joined the cluster` }
						: {
								ok: false,
								message: "Bootstrap stopped",
								detail: j.error ?? "See the log for the last step that ran.",
							};
				},
				render: (w) => <BootstrapStep w={w} join={join} />,
			},
			{
				id: "done",
				title: "Done",
				render: (w) => <DoneStep w={w} join={join} />,
			},
		];
	}, [join, setJoin, qc]);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add server"
				description="Join a Linux server to the cluster over SSH. After this, LogiStack talks to it through its agent."
			/>
			<Wizard
				id={WIZARD_ID}
				steps={steps}
				defaultValues={DEFAULTS}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Open node"
				onComplete={async () => {
					const nodeId = joinRef.current?.nodeId;
					setJoin(null);
					toast.success("Server added", {
						description: "Its charts fill in as the agent reports.",
					});
					await navigate(
						nodeId
							? {
									to: "/monitoring/nodes/$nodeId",
									params: { nodeId },
									search: {},
								}
							: { to: "/monitoring/nodes" },
					);
				}}
			/>
		</Page>
	);
}

function BootstrapStep({
	w,
	join,
}: {
	w: WizardApi<V>;
	join: NodeJoin | null;
}) {
	const t = w.test;
	const lines = join?.step === "bootstrap" ? join.log : [];
	const running = t.phase === "running";
	const result = t.phase === "passed" || t.phase === "failed" ? t.result : null;
	return (
		<div className="grid gap-4">
			<div
				className="flex items-start gap-3 rounded-lg bg-muted/60 p-4 dark:bg-muted/40"
				aria-live="polite"
			>
				<span className="mt-0.5 grid size-5 shrink-0 place-items-center">
					{running ? (
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					) : t.phase === "passed" ? (
						<CircleCheck className="t-reveal size-5 text-ok-text" />
					) : (
						<span
							className={cn(
								"size-2 rounded-full",
								t.phase === "failed" ? "bg-bad" : "bg-idle",
							)}
						/>
					)}
				</span>
				<div className="min-w-0 flex-1">
					{result ? (
						<div key={result.message} className="t-swap">
							<p
								className={cn(
									"text-sm font-medium",
									!result.ok && "text-bad-text",
								)}
							>
								{result.message}
							</p>
							{result.detail && (
								<p className="mt-0.5 text-sm text-muted-foreground">
									{result.detail}
								</p>
							)}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							{running
								? "Bootstrapping. This takes a minute or two on a fresh server."
								: `Joins ${w.values.name || "the server"} as a ${w.values.role}.`}
						</p>
					)}
				</div>
				{t.phase !== "passed" && (
					<Button
						type="button"
						variant="outline"
						onClick={w.runTest}
						disabled={running}
					>
						{t.phase === "failed" ? "Run again" : "Start bootstrap"}
					</Button>
				)}
			</div>
			<JoinLog lines={lines} running={running} />
		</div>
	);
}

function DoneStep({ w, join }: { w: WizardApi<V>; join: NodeJoin | null }) {
	const v = w.values;
	const rows: [string, ReactNode][] = [
		["Name", v.name],
		[
			"Address",
			<span
				key="a"
				className="font-mono"
			>{`${v.sshUser}@${v.host}:${v.port}`}</span>,
		],
		[
			"Role",
			<span key="r" className="capitalize">
				{v.role}
			</span>,
		],
		[
			"Labels",
			Object.keys(v.labels).length ? (
				<LabelChips key="l" labels={v.labels} />
			) : (
				<span key="l" className="text-muted-foreground">
					None
				</span>
			),
		],
	];
	return (
		<div className="grid gap-5">
			<div className="flex items-start gap-3">
				<CircleCheck
					className="t-reveal mt-0.5 size-5 shrink-0 text-ok-text"
					aria-hidden
				/>
				<div>
					<p className="text-sm font-medium">{v.name} is part of the cluster</p>
					<p className="mt-0.5 text-sm text-muted-foreground">
						The agent reports every 10 seconds; its first charts appear within a
						minute. SSH is no longer needed for day-to-day work.
					</p>
				</div>
			</div>
			<dl className="grid gap-x-6 gap-y-2 rounded-lg bg-card px-4 py-3.5 text-sm ring-1 ring-border sm:grid-cols-[8rem_minmax(0,1fr)]">
				{rows.map(([k, val]) => (
					<div key={k} className="contents">
						<dt className="text-muted-foreground">{k}</dt>
						<dd className="min-w-0 break-words">{val}</dd>
					</div>
				))}
			</dl>
			{join?.nodeId && (
				<p className="text-sm text-muted-foreground">
					Services start landing on it as Swarm places them. Compare it with the
					others on the{" "}
					<Link
						to="/monitoring"
						className="text-foreground underline decoration-border hover:decoration-foreground"
					>
						Monitoring overview
					</Link>
					.
				</p>
			)}
		</div>
	);
}

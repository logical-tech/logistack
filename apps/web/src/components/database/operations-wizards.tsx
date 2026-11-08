import {
	type DatabaseEngine,
	DatabaseUpgradeInput,
	IpRange,
	PublicAccessInput,
} from "@logistack/contracts";
import { DATABASE_PORTS, isLaterVersion } from "@logistack/core";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Instructions, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { accessQuery, useDatabaseOps } from "@/lib/api/database-ops";

export const UPGRADE_STEPS = [
	{ id: "check", label: "Check" },
	{ id: "instance", label: "New instance" },
	{ id: "copy", label: "Copy" },
	{ id: "verify", label: "Verify" },
	{ id: "switch", label: "Switch" },
	{ id: "reverify", label: "Verify again" },
] as const;

type StepNav = {
	serviceId: string;
	engine: DatabaseEngine;
	step: string | undefined;
	onStepChange: (step: string, opts: { replace: boolean }) => void;
	onDone: () => void;
};

const lines = (text: string) =>
	text
		.split(/[\s,]+/)
		.map((l) => l.trim())
		.filter(Boolean);

const AllowList = z
	.string()
	.refine((t) => lines(t).length > 0, "Add at least one address or range")
	.refine((t) => lines(t).length <= 100, "At most 100 entries")
	.refine(
		(t) => lines(t).every((l) => IpRange.safeParse(l).success),
		"One address or CIDR range per line, like 203.0.113.7 or 198.51.100.0/24",
	);

const everyone = (text: string) =>
	lines(text).some((l) => l === "0.0.0.0/0" || l === "::/0");

function AllowListField({
	value,
	onChange,
	error,
	yourIp,
}: {
	value: string;
	onChange: (v: string) => void;
	error: string | undefined;
	yourIp: string | null;
}) {
	return (
		<div className="grid max-w-xl gap-4">
			<Field
				id="wz-allow"
				label="Allowed addresses"
				error={error}
				hint={
					yourIp
						? `One per line. You are connecting from ${yourIp}.`
						: "One per line: an address, or a range in CIDR notation."
				}
			>
				<Textarea
					id="wz-allow"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					rows={4}
					spellCheck={false}
					className="font-mono"
					aria-invalid={error ? true : undefined}
					aria-describedby="wz-allow-msg"
				/>
			</Field>
			{everyone(value) && (
				<Instructions>
					<p>
						<strong>Open to the whole internet.</strong> Anyone can try
						passwords against this port. Prefer your office or VPN ranges.
					</p>
				</Instructions>
			)}
		</div>
	);
}

type PublicValues = { hostname: string; port: string; allow: string };

/** Hostname and port, then who may connect, then a review; Caddy issues the certificate. */
export function PublicAccessWizard({
	serviceId,
	engine,
	step,
	onStepChange,
	onDone,
}: StepNav) {
	const { data } = useQuery(accessQuery(serviceId));
	const ops = useDatabaseOps(serviceId);
	const current = data?.access.find((a) => a.kind === "public");
	const steps: WizardStep<PublicValues>[] = [
		{
			id: "address",
			title: "Address",
			description:
				"Clients connect to this hostname. Point its DNS record at the node the database runs on; the certificate is issued for it.",
			schema: z.object({
				hostname: PublicAccessInput.shape.hostname,
				port: z.coerce
					.number({ error: "A port number" })
					.int()
					.min(1024, "From 1024 up")
					.max(65535, "Up to 65535"),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-6 sm:grid-cols-[minmax(0,1fr)_8rem]">
					<Field
						id="wz-hostname"
						label="Hostname"
						error={w.error("hostname")}
						hint="For example db.example.com"
					>
						<Input
							{...w.bind("hostname")}
							autoCapitalize="none"
							autoComplete="off"
							spellCheck={false}
							className="font-mono"
							autoFocus
						/>
					</Field>
					<Field id="wz-port" label="Port" error={w.error("port")}>
						<Input
							{...w.bind("port")}
							inputMode="numeric"
							className="font-mono tabular-nums"
						/>
					</Field>
				</div>
			),
		},
		{
			id: "sources",
			title: "Who can connect",
			description:
				"Connections from anywhere else are dropped before they reach the database.",
			schema: z.object({ allow: AllowList }),
			render: (w) => (
				<AllowListField
					value={w.values.allow}
					onChange={(v) => w.set("allow", v)}
					error={w.error("allow")}
					yourIp={data?.yourIp ?? null}
				/>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"Once the certificate exists the database restarts once to load it, then the port opens. Clients must use TLS; plain connections are refused.",
			render: (w) => (
				<div className="grid max-w-2xl gap-5">
					<Summary
						w={w}
						sections={[
							{
								stepId: "address",
								title: "Address",
								rows: [
									{
										label: "Endpoint",
										value: (
											<span className="font-mono">
												{w.values.hostname}:{w.values.port}
											</span>
										),
									},
									{ label: "Encryption", value: "TLS required" },
								],
							},
							{
								stepId: "sources",
								title: "Who can connect",
								rows: [
									{
										label: "Allowed",
										value: (
											<span className="font-mono">
												{lines(w.values.allow).join(", ")}
											</span>
										),
									},
								],
							},
						]}
					/>
				</div>
			),
		},
	];
	return (
		<Wizard
			id={`db-public:${serviceId}`}
			steps={steps}
			defaultValues={{
				hostname: current?.hostname ?? "",
				port: String(current?.port ?? DATABASE_PORTS[engine]),
				allow: current?.allowedCidrs.join("\n") ?? data?.yourIp ?? "",
			}}
			step={step}
			onStepChange={onStepChange}
			finishLabel={current ? "Save" : "Expose"}
			onComplete={async (v) => {
				await ops.setPublic.mutateAsync({
					hostname: v.hostname.trim().toLowerCase(),
					port: Number(v.port),
					allowedCidrs: lines(v.allow),
				});
				toast.success("Public access saved", {
					description: "The port opens once the certificate is issued.",
				});
				onDone();
			}}
		/>
	);
}

type ForwardValues = { minutes: "15" | "60" | "240" | "480"; allow: string };

/** How long, from where, then a review; the forward closes on its own. */
export function PortForwardWizard({
	serviceId,
	step,
	onStepChange,
	onDone,
}: StepNav) {
	const { data } = useQuery(accessQuery(serviceId));
	const ops = useDatabaseOps(serviceId);
	const tls = !!data?.access.some((a) => a.kind === "public");
	const steps: WizardStep<ForwardValues>[] = [
		{
			id: "duration",
			title: "Duration",
			description:
				"The port closes at the deadline, dropping anything still connected.",
			render: (w) => (
				<ChoiceGroup
					label="Duration"
					columns={4}
					value={w.values.minutes}
					onChange={(m) => w.set("minutes", m)}
					choices={[
						{ value: "15", title: "15 minutes", description: "A quick look" },
						{ value: "60", title: "1 hour", description: "A working session" },
						{ value: "240", title: "4 hours", description: "A migration" },
						{ value: "480", title: "8 hours", description: "The longest" },
					]}
				/>
			),
		},
		{
			id: "sources",
			title: "Who can connect",
			description: "Usually just you.",
			schema: z.object({
				allow: AllowList.refine((t) => lines(t).length <= 10, "At most 10"),
			}),
			render: (w) => (
				<AllowListField
					value={w.values.allow}
					onChange={(v) => w.set("allow", v)}
					error={w.error("allow")}
					yourIp={data?.yourIp ?? null}
				/>
			),
		},
		{
			id: "review",
			title: "Review",
			description: tls
				? "The database serves a certificate, so the forward requires TLS."
				: "The database has no certificate, so the forward is plain: traffic crosses the network unencrypted. Expose it publicly first to require TLS.",
			render: (w) => (
				<div className="grid max-w-2xl gap-5">
					<Summary
						w={w}
						sections={[
							{
								stepId: "duration",
								title: "Duration",
								rows: [
									{
										label: "Closes",
										value: new Date(
											Date.now() + Number(w.values.minutes) * 60_000,
										).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
										}),
									},
									{
										label: "Encryption",
										value: tls ? "TLS required" : "Plain, without TLS",
									},
								],
							},
							{
								stepId: "sources",
								title: "Who can connect",
								rows: [
									{
										label: "Allowed",
										value: (
											<span className="font-mono">
												{lines(w.values.allow).join(", ")}
											</span>
										),
									},
								],
							},
						]}
					/>
				</div>
			),
		},
	];
	return (
		<Wizard
			id={`db-forward:${serviceId}`}
			steps={steps}
			defaultValues={
				{
					minutes: "60" as const,
					allow: data?.yourIp ?? "",
				} satisfies ForwardValues
			}
			step={step}
			onStepChange={onStepChange}
			finishLabel="Open port"
			onComplete={async (v) => {
				const f = await ops.openForward.mutateAsync({
					minutes: Number(v.minutes),
					allowedCidrs: lines(v.allow),
				});
				toast.success(`Port ${f.port} is opening`, {
					description: "The connection string is in Port forwards.",
				});
				onDone();
			}}
		/>
	);
}

/** Later majors offered first for each engine; any later tag can be typed. */
const SUGGESTED: Partial<Record<DatabaseEngine, string[]>> = {
	postgres: ["17", "18"],
	mysql: ["8.4", "9.4"],
	mariadb: ["11.4", "11.8"],
	mongo: ["7.0", "8.0"],
};

type UpgradeValues = { version: string; writesStopped: boolean };

/** Target version, the one thing to do first, then a review of the steps and the rollback. */
export function UpgradeWizard({
	serviceId,
	engine,
	from,
	step,
	onStepChange,
	onDone,
}: StepNav & { from: string }) {
	const ops = useDatabaseOps(serviceId);
	const suffix = from.match(/-[a-z].*$/)?.[0] ?? "";
	const options = (SUGGESTED[engine] ?? [])
		.map((v) => v + suffix)
		.filter((v) => isLaterVersion(from, v));
	const steps: WizardStep<UpgradeValues>[] = [
		{
			id: "version",
			title: "Version",
			description: `The image tag to move to from ${from}.`,
			schema: z.object({
				version: DatabaseUpgradeInput.shape.version.refine(
					(v) => isLaterVersion(from, v),
					`Must be later than ${from}`,
				),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-5">
					<Field
						id="wz-version"
						label="Target version"
						error={w.error("version")}
						hint="The tag of the engine's official image, like 17 or 17-alpine."
					>
						<Input
							{...w.bind("version")}
							autoCapitalize="none"
							spellCheck={false}
							className="font-mono"
							autoFocus
						/>
					</Field>
					{options.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{options.map((v) => (
								<button
									key={v}
									type="button"
									onClick={() => w.set("version", v)}
									aria-pressed={w.values.version === v}
									className="t-press rounded-md bg-muted px-3 py-1.5 font-mono text-sm ring-1 ring-border transition-colors duration-(--duration-quick) hover:bg-accent aria-pressed:bg-primary aria-pressed:text-primary-foreground"
								>
									{v}
								</button>
							))}
						</div>
					)}
				</div>
			),
		},
		{
			id: "prepare",
			title: "Before you start",
			description:
				"The copy reads the database while it keeps running. Anything written after the copy starts is not carried over.",
			schema: z.object({
				writesStopped: z.literal(true, {
					error: "Confirm writes are stopped to continue",
				}),
			}),
			render: (w) => (
				<div className="grid max-w-xl gap-5">
					<Instructions>
						<p>
							<strong>Stop the apps that write to it.</strong> Scale them to
							zero or put them in maintenance mode until the upgrade finishes.
						</p>
						<p>
							<strong>Leave room on the node.</strong> The new instance gets its
							own volume beside the old one, which is kept unchanged as the way
							back.
						</p>
					</Instructions>
					<div className="flex items-start gap-3 text-sm">
						<Checkbox
							id="wz-writes"
							checked={w.values.writesStopped}
							onCheckedChange={(on) => w.set("writesStopped", on === true)}
							aria-invalid={w.error("writesStopped") ? true : undefined}
							aria-describedby="wz-writes-msg"
						/>
						<label htmlFor="wz-writes" className="grid gap-1">
							Nothing writes to the database now
							<span
								id="wz-writes-msg"
								className="text-xs text-bad-text empty:hidden"
							>
								{w.error("writesStopped")}
							</span>
						</label>
					</div>
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"If any check fails after the switch, the service goes back to the old version and volume on its own.",
			render: (w) => (
				<div className="grid max-w-2xl gap-5">
					<Summary
						w={w}
						sections={[
							{
								stepId: "version",
								title: "Version",
								rows: [
									{
										label: "Upgrade",
										value: (
											<span className="font-mono">
												{from} to {w.values.version}
											</span>
										),
									},
								],
							},
						]}
					/>
					<ol className="grid list-decimal gap-2 pl-5 text-sm text-muted-foreground marker:tabular-nums">
						<li>
							A new instance on {w.values.version} starts on its own volume.
						</li>
						<li>Every database is copied into it.</li>
						<li>Row counts per table must match exactly.</li>
						<li>The service switches to the new instance; it restarts once.</li>
						<li>The counts are checked again on the running service.</li>
					</ol>
				</div>
			),
		},
	];
	return (
		<Wizard
			id={`db-upgrade:${serviceId}`}
			steps={steps}
			defaultValues={{ version: options[0] ?? "", writesStopped: false }}
			step={step}
			onStepChange={onStepChange}
			finishLabel="Start upgrade"
			onComplete={async (v) => {
				await ops.startUpgrade.mutateAsync(v.version.trim());
				toast.success("Upgrade started", {
					description: "Follow it under Version.",
				});
				onDone();
			}}
		/>
	);
}

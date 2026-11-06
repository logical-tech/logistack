import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DatabaseBackup, HardDrive, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BackupKeyReveal } from "@/components/backups/backup-key";
import { CronField } from "@/components/backups/cron-field";
import { retentionText } from "@/components/backups/service-backups";
import { Field } from "@/components/field";
import { S3_PROVIDER, s3ProviderOf } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import {
	type PolicyWithKey,
	type ServiceBackups,
	s3DestinationsQuery,
	serviceBackupsQuery,
	useCreatePolicy,
} from "@/lib/api/backups";
import { browserTimezone, cronError, describeCron } from "@/lib/cron";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/backups/$serviceId/new")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Set up backups" },
	loader: ({ context, params }) =>
		Promise.all([
			context.queryClient.ensureQueryData(
				serviceBackupsQuery(params.serviceId),
			),
			context.queryClient.prefetchQuery(s3DestinationsQuery),
		]),
	component: NewPolicy,
});

type V = {
	/** "database", or "volume:<id>" for one of the service's volumes. */
	what: string;
	s3DestinationId: string;
	cron: string;
	timezone: string;
	keepCount: string;
	keepDays: string;
	verify: boolean;
	verifyCron: string;
	pauseService: boolean;
	encrypt: boolean;
};

const DUMP: Record<string, string> = {
	postgres:
		"pg_dump in custom format, compressed. Restores with pg_restore --clean.",
	mysql: "mysqldump with --single-transaction, so tables stay consistent.",
	mariadb: "mariadb-dump with --single-transaction, so tables stay consistent.",
	mongo: "mongodump --archive, gzip-compressed.",
	redis: "An RDB snapshot; restore it by copying it back into the data volume.",
	libsql: "An SQL dump from sqld; restore by copying the data volume back.",
};

const target = (v: V) =>
	v.what === "database"
		? { target: "database" as const, volumeName: null }
		: { target: "volume" as const, volumeName: v.what.slice("volume:".length) };

const whole = (label: string) =>
	z
		.string()
		.trim()
		.refine(
			(n) =>
				n === "" || (/^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= 10_000),
			`${label} must be a whole number from 1.`,
		);

function DestinationStep({ w }: { w: WizardApi<V> }) {
	const { data: destinations } = useQuery(s3DestinationsQuery);
	if (!destinations)
		return (
			<p className="text-sm text-muted-foreground">Loading destinations…</p>
		);
	if (!destinations.length)
		return (
			<div className="rounded-lg bg-muted/60 p-4 text-sm dark:bg-muted/40">
				<p className="font-medium">No S3 destination yet</p>
				<p className="mt-1 text-muted-foreground">
					Add a bucket first. This setup keeps its answers, so come back here
					when it's saved.
				</p>
				<Button asChild variant="outline" size="sm" className="mt-3">
					<Link to="/integrations/s3/new">
						<Plus data-icon="inline-start" />
						Add an S3 destination
					</Link>
				</Button>
			</div>
		);
	return (
		<div className="grid gap-3">
			<ChoiceGroup
				label="Destination"
				columns={1}
				value={w.values.s3DestinationId || undefined}
				invalid={!!w.error("s3DestinationId")}
				onChange={(id) => w.set("s3DestinationId", id)}
				choices={destinations.map((d) => ({
					value: d.id,
					title: d.name,
					description: `${d.bucket}${d.prefix ? `/${d.prefix}` : ""} on ${S3_PROVIDER[s3ProviderOf(d.endpoint)].label}`,
					icon: S3_PROVIDER[s3ProviderOf(d.endpoint)].icon,
				}))}
			/>
			{w.error("s3DestinationId") && (
				<p className="text-xs text-bad-text">{w.error("s3DestinationId")}</p>
			)}
			<Link
				to="/integrations/s3/new"
				className="text-sm text-muted-foreground hover:text-foreground hover:underline"
			>
				Add another destination
			</Link>
		</div>
	);
}

function ToggleRow({
	id,
	title,
	body,
	checked,
	onChange,
}: {
	id: string;
	title: string;
	body: string;
	checked: boolean;
	onChange: (c: boolean) => void;
}) {
	return (
		<label
			htmlFor={id}
			className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
		>
			<span>
				<span className="block font-medium">{title}</span>
				<span className="text-muted-foreground">{body}</span>
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</label>
	);
}

function buildSteps(data: ServiceBackups): WizardStep<V>[] {
	const engine = data.service.engine;
	const isDb = data.service.kind === "database";
	const volumeLabel = (v: V) =>
		data.volumes.find((x) => `volume:${x.id}` === v.what)?.label ?? "";
	return [
		{
			id: "what",
			title: "What to back up",
			description: isDb
				? "A dump is small and restores anywhere; a volume archive is a byte-for-byte copy of the files."
				: "Each policy archives one volume. Add another policy for the next one.",
			schema: z.object({ what: z.string().min(1, "Choose what to back up.") }),
			render: (w) => (
				<ChoiceGroup
					label="What to back up"
					columns={1}
					value={w.values.what || undefined}
					onChange={(what) => {
						w.set("what", what);
						if (what !== "database") w.set("verify", false);
					}}
					choices={[
						...(isDb
							? [
									{
										value: "database",
										title: `The ${engine ?? "database"} database`,
										description:
											(engine && DUMP[engine]) ??
											"A logical dump of every database.",
										icon: DatabaseBackup,
										badge: "Recommended",
									},
								]
							: []),
						...data.volumes.map((vol) => ({
							value: `volume:${vol.id}`,
							title: `Volume ${vol.label}`,
							description:
								vol.kind === "data"
									? "The data directory itself, as a compressed tar."
									: "A mounted volume, as a compressed tar.",
							icon: HardDrive,
						})),
					]}
				/>
			),
		},
		{
			id: "where",
			title: "Where it goes",
			description:
				"Backups are written under the destination's prefix, one folder per service.",
			schema: z.object({
				s3DestinationId: z.string().min(1, "Choose a destination."),
			}),
			render: (w) => <DestinationStep w={w} />,
		},
		{
			id: "when",
			title: "When it runs",
			description:
				"Pick a quiet hour. The preview shows the next runs in the chosen zone.",
			schema: z.object({
				cron: z
					.string()
					.refine((c) => !cronError(c), "Fix the cron expression."),
			}),
			render: (w) => (
				<CronField
					id="wz-cron"
					label="Back up"
					cron={w.values.cron}
					timezone={w.values.timezone}
					onCron={(c) => w.set("cron", c)}
					onTimezone={(tz) => w.set("timezone", tz)}
					error={w.error("cron")}
				/>
			),
		},
		{
			id: "keep",
			title: "How long to keep them",
			description:
				"Retention runs after every backup and deletes what falls outside it.",
			schema: z
				.object({
					keepCount: whole("Count"),
					keepDays: whole("Days"),
				})
				.refine((v) => v.keepCount.trim() || v.keepDays.trim(), {
					message: "Set a count, a number of days, or both.",
					path: ["keepCount"],
				}),
			render: (w) => (
				<div className="grid gap-5 sm:grid-cols-2">
					<Field
						id="wz-keepCount"
						label="Keep the newest"
						error={w.error("keepCount")}
						hint="Backups beyond this many are deleted, oldest first."
					>
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Input
								{...w.bind("keepCount")}
								inputMode="numeric"
								className="w-20 tabular"
							/>
							backups
						</div>
					</Field>
					<Field
						id="wz-keepDays"
						label="Delete after"
						optional
						error={w.error("keepDays")}
						hint="Backups older than this are deleted."
					>
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Input
								{...w.bind("keepDays")}
								inputMode="numeric"
								className="w-20 tabular"
							/>
							days
						</div>
					</Field>
				</div>
			),
		},
		{
			id: "verify",
			title: "Test restores",
			description:
				"A backup that has never been restored is a guess. Verify restores the newest one into a throwaway container and runs a sanity query; the live database is never touched.",
			when: (v) => v.what === "database",
			schema: (v) =>
				v.verify
					? z.object({
							verifyCron: z
								.string()
								.refine((c) => !cronError(c), "Fix the cron expression."),
						})
					: z.object({}),
			render: (w) => (
				<div className="grid gap-5">
					<ToggleRow
						id="wz-verify"
						title="Verify on a schedule"
						body="Failed verifies alert like failed backups."
						checked={w.values.verify}
						onChange={(c) => w.set("verify", c)}
					/>
					{w.values.verify && (
						<div className="t-reveal">
							<CronField
								id="wz-verifyCron"
								label="Verify"
								cron={w.values.verifyCron}
								timezone={w.values.timezone}
								onCron={(c) => w.set("verifyCron", c)}
								error={w.error("verifyCron")}
								hint={`In ${w.values.timezone.replaceAll("_", " ")}, like the backups.`}
							/>
						</div>
					)}
				</div>
			),
		},
		{
			id: "pause",
			title: "Consistency",
			description:
				"Files copied while a service writes them can be half-updated. Pausing it gives a clean copy at the cost of a short outage.",
			when: (v) => v.what.startsWith("volume:"),
			render: (w) => (
				<ToggleRow
					id="wz-pauseService"
					title={`Stop ${data.service.name} while archiving`}
					body="Scaled to zero for the copy, then back. Usually seconds to a few minutes, depending on size."
					checked={w.values.pauseService}
					onChange={(c) => w.set("pauseService", c)}
				/>
			),
		},
		{
			id: "encrypt",
			title: "Encryption",
			description:
				"The bucket's owner, and anyone holding its credentials, can read plain backups. Encrypted ones are unreadable without the key.",
			render: (w) => (
				<div className="grid gap-3">
					<ToggleRow
						id="wz-encrypt"
						title="Encrypt before upload"
						body="Each backup is encrypted with age on this server, so the bucket only ever holds ciphertext. Restores decrypt on their own."
						checked={w.values.encrypt}
						onChange={(c) => w.set("encrypt", c)}
					/>
					{w.values.encrypt && (
						<p className="t-reveal px-1 text-sm text-pretty text-muted-foreground">
							LogiStack creates a key and shows it once, after setup. Keep it
							outside this server: without it, nobody can read these backups if
							the server is lost. Encryption cannot be turned off later.
						</p>
					)}
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			description:
				"The first backup runs on schedule, or start it with Run now.",
			render: (w) => {
				const v = w.values;
				const t = target(v);
				return (
					<Summary
						w={w}
						sections={[
							{
								stepId: "what",
								title:
									t.target === "database"
										? "Database dump"
										: `Volume ${volumeLabel(v)}`,
								rows: [
									{ label: "Service", value: data.service.name },
									{
										label: "Destination",
										value: <DestinationName id={v.s3DestinationId} />,
									},
								],
							},
							{
								stepId: "encrypt",
								title: "Encryption",
								rows: [
									{
										label: "Before upload",
										value: v.encrypt
											? "Encrypted with age, key shown once"
											: "Off",
									},
								],
							},
							{
								stepId: "when",
								title: "Schedule",
								rows: [
									{
										label: "Runs",
										value: describeCron(v.cron) ?? (
											<span className="font-mono text-xs">{v.cron}</span>
										),
									},
									{
										label: "Time zone",
										value: v.timezone.replaceAll("_", " "),
									},
									{
										label: "Retention",
										value: retentionText({
											count: v.keepCount ? Number(v.keepCount) : undefined,
											days: v.keepDays ? Number(v.keepDays) : undefined,
										}),
									},
								],
							},
							t.target === "database"
								? {
										stepId: "verify",
										title: "Test restores",
										rows: [
											{
												label: "Verify",
												value: v.verify
													? (describeCron(v.verifyCron) ?? v.verifyCron)
													: "Off",
											},
										],
									}
								: {
										stepId: "pause",
										title: "Consistency",
										rows: [
											{
												label: "While archiving",
												value: v.pauseService
													? `${data.service.name} is stopped`
													: "Keeps running",
											},
										],
									},
						]}
					/>
				);
			},
		},
	];
}

function DestinationName({ id }: { id: string }) {
	const { data } = useQuery(s3DestinationsQuery);
	return data?.find((d) => d.id === id)?.name ?? "–";
}

function NewPolicy() {
	const { serviceId } = Route.useParams();
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data } = useQuery(serviceBackupsQuery(serviceId));
	const { data: destinations } = useQuery(s3DestinationsQuery);
	const create = useCreatePolicy();
	const [created, setCreated] = useState<PolicyWithKey | null>(null);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);
	const steps = useMemo(() => (data ? buildSteps(data) : []), [data]);
	if (!data) return null;

	if (created?.encryptionKey)
		return (
			<Page className="max-w-2xl">
				<PageHeader
					title="Save the backup key"
					description={
						<>
							Backups of{" "}
							<span className="text-foreground">{data.service.name}</span> are
							on and encrypted. Store the key somewhere safe before you leave
							this page.
						</>
					}
				/>
				<div className="t-reveal">
					<BackupKeyReveal
						policy={created}
						encryptionKey={created.encryptionKey}
					/>
				</div>
				<div className="mt-8 flex justify-end border-t pt-5">
					<Button asChild size="lg">
						<Link to="/backups/$serviceId" params={{ serviceId }}>
							I've saved the key
						</Link>
					</Button>
				</div>
			</Page>
		);

	const covered = new Set(
		data.policies.map((p) =>
			p.target === "database" ? "database" : `volume:${p.volumeName}`,
		),
	);
	const first =
		data.service.kind === "database" && !covered.has("database")
			? "database"
			: (data.volumes
					.map((v) => `volume:${v.id}`)
					.find((k) => !covered.has(k)) ?? "");

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title={`Back up ${data.service.name}`}
				description="Choose what, where and how often. Nothing runs until you confirm."
			/>
			<Wizard
				id={`new-backup:${serviceId}`}
				steps={steps}
				defaultValues={{
					what: first,
					s3DestinationId:
						destinations?.length === 1 ? (destinations[0]?.id ?? "") : "",
					cron: "0 3 * * *",
					timezone: browserTimezone(),
					keepCount: "14",
					keepDays: "",
					verify: data.service.kind === "database",
					verifyCron: "0 5 * * 0",
					pauseService: false,
					encrypt: true,
				}}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Start backing up"
				onComplete={async (v) => {
					const t = target(v);
					const policy = await create.mutateAsync({
						serviceId,
						...t,
						s3DestinationId: v.s3DestinationId,
						cron: v.cron.trim(),
						timezone: v.timezone,
						retention: {
							...(v.keepCount ? { count: Number(v.keepCount) } : {}),
							...(v.keepDays ? { days: Number(v.keepDays) } : {}),
						},
						verifyCron:
							t.target === "database" && v.verify ? v.verifyCron.trim() : null,
						pauseService: t.target === "volume" && v.pauseService,
						enabled: true,
						encrypt: v.encrypt,
					});
					if (policy.encryptionKey) return setCreated(policy);
					toast.success(`Backups of ${data.service.name} are on`, {
						description: describeCron(v.cron) ?? v.cron,
					});
					await navigate({ to: "/backups/$serviceId", params: { serviceId } });
				}}
			/>
		</Page>
	);
}

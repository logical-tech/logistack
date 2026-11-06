import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { S3_PROVIDER, type S3Provider } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import {
	Wizard,
	type WizardApi,
	type WizardStep,
} from "@/components/wizard/wizard";
import { backupsApi, useCreateS3Destination } from "@/lib/api/backups";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/integrations/s3_/new")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Add destination" },
	component: AddDestination,
});

type V = {
	provider: S3Provider;
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	forcePathStyle: boolean;
	accessKeyId: string;
	secretAccessKey: string;
	name: string;
};

type Preset = {
	description: string;
	endpoint: string;
	placeholder: string;
	region: string;
	pathStyle: boolean;
	endpointHint: string;
	regionHint: string;
	keys: ReactNode;
	href?: string;
	link?: string;
};

const PRESETS: Record<S3Provider, Preset> = {
	aws: {
		description: "Any region, with an IAM user's access key.",
		endpoint: "https://s3.eu-central-1.amazonaws.com",
		placeholder: "https://s3.eu-central-1.amazonaws.com",
		region: "eu-central-1",
		pathStyle: false,
		endpointHint: "https://s3.<region>.amazonaws.com, for the bucket's region.",
		regionHint: "The bucket's region, like eu-central-1 or us-east-1.",
		keys: (
			<>
				<p>
					In IAM, open a user meant only for backups, then{" "}
					<strong>Security credentials → Create access key</strong>.
				</p>
				<p>
					Its policy needs <strong>s3:PutObject</strong>,{" "}
					<strong>s3:GetObject</strong>, <strong>s3:DeleteObject</strong> and{" "}
					<strong>s3:ListBucket</strong> on this bucket, nothing else.
				</p>
			</>
		),
		href: "https://console.aws.amazon.com/iam/home#/users",
		link: "Open IAM users",
	},
	r2: {
		description: "No egress fees. One endpoint per Cloudflare account.",
		endpoint: "",
		placeholder: "https://<account-id>.r2.cloudflarestorage.com",
		region: "auto",
		pathStyle: false,
		endpointHint:
			"Your account ID is on the R2 overview page, next to the S3 API endpoint.",
		regionHint: "R2 ignores regions; keep auto.",
		keys: (
			<>
				<p>
					In R2, open <strong>Manage API tokens → Create API token</strong> with{" "}
					<strong>Object Read &amp; Write</strong>, scoped to this bucket.
				</p>
				<p>
					Copy the <strong>Access Key ID</strong> and{" "}
					<strong>Secret Access Key</strong>. Cloudflare shows the secret once.
				</p>
			</>
		),
		href: "https://dash.cloudflare.com/?to=/:account/r2/api-tokens",
		link: "Open R2 API tokens",
	},
	b2: {
		description: "Backblaze's S3-compatible API.",
		endpoint: "https://s3.eu-central-003.backblazeb2.com",
		placeholder: "https://s3.<region>.backblazeb2.com",
		region: "eu-central-003",
		pathStyle: false,
		endpointHint: "Shown as Endpoint on the bucket's page in Backblaze.",
		regionHint: "The middle part of the endpoint, like eu-central-003.",
		keys: (
			<>
				<p>
					Under <strong>Application Keys → Add a New Application Key</strong>,
					allow <strong>Read and Write</strong> on this bucket only.
				</p>
				<p>
					The <strong>keyID</strong> is the access key, the{" "}
					<strong>applicationKey</strong> is the secret.
				</p>
			</>
		),
		href: "https://secure.backblaze.com/app_keys.htm",
		link: "Open application keys",
	},
	hetzner: {
		description: "Object Storage in Falkenstein, Nuremberg or Helsinki.",
		endpoint: "https://fsn1.your-objectstorage.com",
		placeholder: "https://<location>.your-objectstorage.com",
		region: "fsn1",
		pathStyle: false,
		endpointHint: "fsn1, nbg1 or hel1, matching where the bucket lives.",
		regionHint: "The bucket's location: fsn1, nbg1 or hel1.",
		keys: (
			<p>
				In the Hetzner Console, open the project, then{" "}
				<strong>Security → S3 credentials → Generate credentials</strong>. The
				secret key is shown once.
			</p>
		),
		href: "https://console.hetzner.com/",
		link: "Open Hetzner Console",
	},
	minio: {
		description: "Your own MinIO, on this cluster or elsewhere.",
		endpoint: "",
		placeholder: "https://minio.example.com",
		region: "us-east-1",
		pathStyle: true,
		endpointHint: "The API address (port 9000 by default), not the console.",
		regionHint: "MinIO's default is us-east-1 unless MINIO_REGION is set.",
		keys: (
			<p>
				In the MinIO Console, <strong>Access Keys → Create access key</strong>,
				with a policy that allows put, get and delete on this bucket.
			</p>
		),
	},
	wasabi: {
		description: "Flat-priced storage; mind the 90-day minimum.",
		endpoint: "https://s3.eu-central-1.wasabisys.com",
		placeholder: "https://s3.<region>.wasabisys.com",
		region: "eu-central-1",
		pathStyle: false,
		endpointHint: "Use the service URL of the bucket's region.",
		regionHint: "The bucket's region, like eu-central-1.",
		keys: (
			<>
				<p>
					In the Wasabi Console,{" "}
					<strong>Access Keys → Create New Access Key</strong>, ideally for a
					sub-user limited to this bucket.
				</p>
				<p>
					Wasabi bills deleted objects for 90 days, so short retention costs the
					same as 90 days.
				</p>
			</>
		),
		href: "https://console.wasabisys.com/access_keys",
		link: "Open access keys",
	},
	custom: {
		description: "Ceph, Garage, SeaweedFS or any store that speaks S3.",
		endpoint: "",
		placeholder: "https://s3.example.com",
		region: "us-east-1",
		pathStyle: false,
		endpointHint: "HTTPS unless the store is on a private network.",
		regionHint: "Keep us-east-1 unless the store says otherwise.",
		keys: (
			<p>
				Any key pair with put, get and delete on the bucket. Requests are signed
				with Signature V4.
			</p>
		),
	},
};

const PROVIDERS: S3Provider[] = [
	"aws",
	"r2",
	"b2",
	"hetzner",
	"minio",
	"wasabi",
	"custom",
];

const DEFAULTS: V = {
	provider: "r2",
	endpoint: PRESETS.r2.endpoint,
	region: PRESETS.r2.region,
	bucket: "",
	prefix: "logistack",
	forcePathStyle: PRESETS.r2.pathStyle,
	accessKeyId: "",
	secretAccessKey: "",
	name: "",
};

const connection = (v: V) => ({
	endpoint: v.endpoint.trim().replace(/\/+$/, ""),
	region: v.region.trim(),
	bucket: v.bucket.trim(),
	prefix: v.prefix.trim().replace(/^\/+|\/+$/g, ""),
	accessKeyId: v.accessKeyId.trim(),
	secretAccessKey: v.secretAccessKey,
	forcePathStyle: v.forcePathStyle,
});

const objectPath = (v: V) => {
	const c = connection(v);
	return `${c.bucket || "<bucket>"}/${c.prefix ? `${c.prefix}/` : ""}`;
};

function ConnectionStep({ w }: { w: WizardApi<V> }) {
	const p = PRESETS[w.values.provider];
	return (
		<div className="grid gap-5">
			<Field
				id="wz-endpoint"
				label="Endpoint"
				error={w.error("endpoint")}
				hint={p.endpointHint}
			>
				<Input
					{...w.bind("endpoint")}
					placeholder={p.placeholder}
					inputMode="url"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
					autoFocus
				/>
			</Field>
			<div className="grid gap-5 sm:grid-cols-2">
				<Field id="wz-bucket" label="Bucket" error={w.error("bucket")}>
					<Input
						{...w.bind("bucket")}
						placeholder="acme-backups"
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
				<Field
					id="wz-region"
					label="Region"
					error={w.error("region")}
					hint={p.regionHint}
				>
					<Input
						{...w.bind("region")}
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
			</div>
			<Field
				id="wz-prefix"
				label="Prefix"
				optional
				error={w.error("prefix")}
				hint={`Backups land under ${objectPath(w.values)}backups/<policy>/, so one bucket can serve several instances.`}
			>
				<Input
					{...w.bind("prefix")}
					placeholder="logistack"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
				/>
			</Field>
			<label
				htmlFor="wz-forcePathStyle"
				className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3 text-sm dark:bg-muted/40"
			>
				<span>
					<span className="block font-medium">Path-style addressing</span>
					<span className="text-muted-foreground">
						Put the bucket in the path (host/bucket/key) instead of the
						hostname. MinIO and most self-hosted stores need it.
					</span>
				</span>
				<Switch
					id="wz-forcePathStyle"
					checked={w.values.forcePathStyle}
					onCheckedChange={(c) => w.set("forcePathStyle", c)}
				/>
			</label>
		</div>
	);
}

function KeysStep({ w }: { w: WizardApi<V> }) {
	const p = PRESETS[w.values.provider];
	return (
		<div className="grid gap-5">
			<Instructions href={p.href} link={p.link}>
				{p.keys}
			</Instructions>
			<div className="grid gap-5 sm:grid-cols-2">
				<Field
					id="wz-accessKeyId"
					label="Access key ID"
					error={w.error("accessKeyId")}
				>
					<Input
						{...w.bind("accessKeyId")}
						autoCapitalize="none"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
						autoFocus
					/>
				</Field>
				<Field
					id="wz-secretAccessKey"
					label="Secret access key"
					error={w.error("secretAccessKey")}
					hint="Encrypted at rest. Never shown again."
				>
					<Input
						{...w.bind("secretAccessKey")}
						type="password"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
					/>
				</Field>
			</div>
		</div>
	);
}

function NameStep({ w }: { w: WizardApi<V> }) {
	const v = w.values;
	const suggestion = `${S3_PROVIDER[v.provider].label} · ${v.bucket.trim()}`;
	const offered = useRef(false);
	// Offer a name once, without overwriting one the person typed.
	useEffect(() => {
		if (offered.current) return;
		offered.current = true;
		if (!v.name) w.set("name", suggestion);
	});
	const c = connection(v);
	return (
		<div className="grid gap-6">
			<Field
				id="wz-name"
				label="Name"
				error={w.error("name")}
				hint="Shown when picking where a backup policy writes."
			>
				<Input {...w.bind("name")} autoComplete="off" autoFocus />
			</Field>
			<Summary
				w={w}
				sections={[
					{
						stepId: "connection",
						title: S3_PROVIDER[v.provider].label,
						rows: [
							{
								label: "Endpoint",
								value: <span className="font-mono text-xs">{c.endpoint}</span>,
							},
							{
								label: "Bucket",
								value: (
									<span className="font-mono text-xs">
										{c.bucket}
										{c.prefix && (
											<span className="text-muted-foreground">/{c.prefix}</span>
										)}
									</span>
								),
							},
							{
								label: "Region",
								value: <span className="font-mono text-xs">{c.region}</span>,
							},
							{
								label: "Addressing",
								value: c.forcePathStyle ? "Path-style" : "Virtual-hosted",
							},
						],
					},
					{
						stepId: "keys",
						title: "Keys",
						rows: [
							{
								label: "Access key",
								value: (
									<span className="font-mono text-xs">{c.accessKeyId}</span>
								),
							},
							{ label: "Secret", value: "Set, encrypted on save" },
						],
					},
				]}
			/>
		</div>
	);
}

const STEPS: WizardStep<V>[] = [
	{
		id: "provider",
		title: "Where should backups go?",
		description:
			"Presets fill in the endpoint and addressing. Every option is plain S3 underneath.",
		render: (w) => (
			<ChoiceGroup
				label="Provider"
				value={w.values.provider}
				onChange={(provider) => {
					const p = PRESETS[provider];
					w.set("provider", provider);
					w.set("endpoint", p.endpoint);
					w.set("region", p.region);
					w.set("forcePathStyle", p.pathStyle);
				}}
				choices={PROVIDERS.map((value) => ({
					value,
					title: S3_PROVIDER[value].label,
					description: PRESETS[value].description,
					icon: S3_PROVIDER[value].icon,
				}))}
			/>
		),
	},
	{
		id: "connection",
		title: "Bucket",
		description:
			"Create the bucket first; LogiStack doesn't create one for you.",
		schema: z.object({
			endpoint: z
				.string()
				.trim()
				.pipe(
					z.url({
						protocol: /^https?$/,
						error: "Use the full URL, starting with https://.",
					}),
				)
				.refine((u) => !u.includes("<"), "Fill in your account ID."),
			region: z.string().trim().min(1, "Enter a region, or us-east-1."),
			bucket: z
				.string()
				.trim()
				.regex(
					/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
					"3 to 63 lowercase letters, digits, dots and dashes.",
				),
			prefix: z
				.string()
				.trim()
				.max(200, "Keep the prefix under 200 characters.")
				.regex(
					/^[A-Za-z0-9!_.*'()/-]*$/,
					"Use letters, digits and / - _ . only.",
				),
		}),
		render: (w) => <ConnectionStep w={w} />,
	},
	{
		id: "keys",
		title: "Access keys",
		description: "Use keys that reach this bucket and nothing else.",
		schema: z.object({
			accessKeyId: z.string().trim().min(1, "Paste the access key ID."),
			secretAccessKey: z.string().min(1, "Paste the secret access key."),
		}),
		render: (w) => <KeysStep w={w} />,
	},
	{
		id: "test",
		title: "Test the bucket",
		description: "Nothing is saved until the test passes and you confirm.",
		testKeys: [
			"endpoint",
			"region",
			"bucket",
			"prefix",
			"forcePathStyle",
			"accessKeyId",
			"secretAccessKey",
		],
		test: (v) => backupsApi.s3.test(connection(v)),
		render: (w) => (
			<div className="grid gap-4">
				<TestPanel
					w={w}
					action="Run test"
					idle={
						<>
							We'll write a small probe object to{" "}
							<span className="font-mono text-xs text-foreground">
								{objectPath(w.values)}.logistack-probe-…
							</span>
							, read it back and delete it.
						</>
					}
				/>
				<p className="text-sm text-muted-foreground">
					A pass means the keys can put, get and delete here: the three things
					backups, restores and retention do.
				</p>
			</div>
		),
	},
	{
		id: "name",
		title: "Name and review",
		description: "The destination is added when you confirm.",
		schema: z.object({
			name: z.string().trim().min(1, "Give it a name.").max(100),
		}),
		render: (w) => <NameStep w={w} />,
	},
];

function AddDestination() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const create = useCreateS3Destination();
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add an S3 destination"
				description="The bucket is tested with a real write, read and delete before anything is saved."
			/>
			<Wizard
				id="add-s3"
				steps={STEPS}
				defaultValues={DEFAULTS}
				secretKeys={["secretAccessKey"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Add destination"
				onComplete={async (v) => {
					const name = v.name.trim();
					await create.mutateAsync({ ...connection(v), name });
					toast.success(`${name} added`, {
						description: "Pick it when setting up backups for a service.",
					});
					await navigate({ to: "/integrations/s3" });
				}}
			/>
		</Page>
	);
}

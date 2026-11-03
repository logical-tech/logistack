import type { StorageEngine } from "@logistack/contracts";
import { Check, Minus } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { z } from "zod";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { Input } from "@/components/ui/input";
import type { SummarySection } from "@/components/wizard/parts";
import type {
	WizardApi,
	WizardStep,
	WizardValues,
} from "@/components/wizard/wizard";
import type { DomainInput } from "@/lib/api/types";
import { ENGINE_ORDER, STORAGE_ENGINES } from "@/lib/storage-engines";
import { cn } from "@/lib/utils";

export type DomainMode = "none" | "generated" | "custom";

/** The answers the object storage branch of the new-service wizard owns. */
export type StorageFields = {
	storageEngine: StorageEngine;
	s3Domain: DomainMode;
	s3Hostname: string;
	consoleDomain: DomainMode;
	consoleHostname: string;
};
export type StorageValues = WizardValues &
	StorageFields & { kind: string; name: string };

export const STORAGE_DEFAULTS = {
	storageEngine: "minio",
	s3Domain: "none",
	s3Hostname: "",
	consoleDomain: "none",
	consoleHostname: "",
} as const satisfies StorageFields;

const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/,
		"Use a hostname like s3.example.com",
	);

const hasConsole = (v: StorageValues) =>
	STORAGE_ENGINES[v.storageEngine].consolePort !== null;

/** Radio cards that compare engines honestly: what each does well, and what it lacks. */
function EnginePicker({
	value,
	onChange,
}: {
	value: StorageEngine;
	onChange: (e: StorageEngine) => void;
}) {
	return (
		<RadioGroupPrimitive.Root
			value={value}
			onValueChange={(v) => onChange(v as StorageEngine)}
			aria-label="Engine"
			className="grid gap-2 sm:grid-cols-2"
		>
			{ENGINE_ORDER.map((id) => {
				const e = STORAGE_ENGINES[id];
				return (
					<RadioGroupPrimitive.Item
						key={id}
						value={id}
						className={cn(
							"group relative grid content-start gap-3 rounded-lg bg-card p-4 text-left ring-1 ring-border outline-none t-press",
							"hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
							"data-[state=checked]:ring-2 data-[state=checked]:ring-foreground",
						)}
					>
						<span className="flex items-start gap-3">
							<span className="min-w-0 flex-1">
								<span className="flex items-baseline gap-2">
									<span className="text-sm font-semibold">{e.label}</span>
									<span className="text-xs text-muted-foreground">
										{e.license}
									</span>
								</span>
								<span className="mt-0.5 block text-sm text-pretty text-muted-foreground">
									{e.summary}
								</span>
							</span>
							<span
								aria-hidden
								className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ring-1 ring-input transition-colors duration-(--duration-quick) group-data-[state=checked]:bg-foreground group-data-[state=checked]:ring-foreground"
							>
								<span className="size-1.5 scale-0 rounded-full bg-background transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=checked]:scale-100" />
							</span>
						</span>
						<span className="grid gap-1 text-xs">
							{e.good.map((g) => (
								<span key={g} className="flex items-start gap-2">
									<Check
										className="mt-px size-3.5 shrink-0 text-ok-text"
										strokeWidth={2}
										aria-hidden
									/>
									{g}
								</span>
							))}
							{e.missing.map((m) => (
								<span
									key={m}
									className="flex items-start gap-2 text-muted-foreground"
								>
									<Minus
										className="mt-px size-3.5 shrink-0"
										strokeWidth={2}
										aria-hidden
									/>
									<span>
										<span className="sr-only">Caveat: </span>
										{m}
									</span>
								</span>
							))}
						</span>
					</RadioGroupPrimitive.Item>
				);
			})}
		</RadioGroupPrimitive.Root>
	);
}

const MODES = [
	{ value: "none" as const, label: "Off" },
	{ value: "generated" as const, label: "Generated" },
	{ value: "custom" as const, label: "Custom" },
];

function DomainChooser<V extends StorageValues>({
	w,
	which,
	title,
	off,
	generated,
	modes = MODES,
}: {
	w: WizardApi<V>;
	which: "s3" | "console";
	title: string;
	off: string;
	generated: string;
	modes?: typeof MODES;
}) {
	const mode = w.values[`${which}Domain`] as DomainMode;
	const hostKey = `${which}Hostname` as const;
	return (
		<section
			aria-labelledby={`wz-${which}-title`}
			className="grid gap-3 rounded-lg bg-card p-4 ring-1 ring-border"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 id={`wz-${which}-title`} className="text-sm font-medium">
					{title}
				</h3>
				<Segmented
					label={`${title} domain`}
					value={mode}
					onChange={(m) => {
						w.set(`${which}Domain` as keyof V, m as V[keyof V]);
						// One generated hostname per service: the console gives way to the S3 endpoint.
						if (
							which === "s3" &&
							m === "generated" &&
							w.values.consoleDomain === "generated"
						)
							w.set("consoleDomain", "none" as V["consoleDomain"]);
					}}
					options={modes}
				/>
			</div>
			{mode === "custom" ? (
				<Field
					id={`wz-${hostKey}`}
					label="Hostname"
					error={w.error(hostKey)}
					hint="Point a CNAME or A record at this server. HTTPS is issued by Let's Encrypt."
				>
					<Input
						{...w.bind(hostKey)}
						placeholder={
							which === "s3" ? "s3.example.com" : "console.example.com"
						}
						autoCapitalize="none"
						spellCheck={false}
						className="font-mono"
						autoFocus
					/>
				</Field>
			) : (
				<p className="text-sm text-muted-foreground">
					{mode === "none" ? (
						off
					) : (
						<>
							Served over HTTPS at{" "}
							<span className="font-mono text-xs text-foreground">
								{generated}
							</span>
						</>
					)}
				</p>
			)}
		</section>
	);
}

const domainInput = (
	mode: DomainMode,
	host: string,
	port: number,
): DomainInput | null =>
	mode === "none"
		? null
		: mode === "custom"
			? {
					kind: "custom",
					hostname: host.trim().toLowerCase(),
					port,
					https: true,
				}
			: { kind: "generated", port };

/** The S3 domain first, then the console; what `CreateServiceInput` takes. */
export function storageDomains(v: StorageValues) {
	const e = STORAGE_ENGINES[v.storageEngine];
	const s3 = domainInput(v.s3Domain, v.s3Hostname, e.s3Port);
	const console =
		e.consolePort && hasConsole(v)
			? domainInput(v.consoleDomain, v.consoleHostname, e.consolePort)
			: null;
	return { domain: s3, extraDomains: console ? [console] : [] };
}

/**
 * The steps after "Choose a source" when it is object storage. `generated(v)` names the
 * hostname the server would generate, so it reads the same as the app domain step.
 */
export function storageSteps<V extends StorageValues>({
	envName,
	slug,
	nameField,
	generated,
}: {
	envName: string;
	slug: (v: V) => string;
	nameField: (w: WizardApi<V>) => React.ReactNode;
	generated: (v: V) => string;
}): WizardStep<V>[] {
	const isStorage = (v: V) => v.kind === "storage";
	return [
		{
			id: "engine",
			title: "Choose an engine",
			description:
				"Every engine speaks S3. LogiStack creates the root credentials and keeps them encrypted.",
			when: isStorage,
			schema: z.object({
				name: z
					.string()
					.trim()
					.regex(
						/^$|^[a-zA-Z0-9][a-zA-Z0-9 -]{0,39}$/,
						"Letters, numbers, spaces and dashes; up to 40.",
					),
			}),
			render: (w) => (
				<div className="grid gap-5">
					<EnginePicker
						value={w.values.storageEngine}
						onChange={(e) => {
							w.set("storageEngine", e as V["storageEngine"]);
							if (STORAGE_ENGINES[e].consolePort === null)
								w.set("consoleDomain", "none" as V["consoleDomain"]);
						}}
					/>
					{nameField(w)}
				</div>
			),
		},
		{
			id: "storage-access",
			title: "Public access",
			description:
				"Buckets start private either way. Apps in this environment always reach the internal endpoint.",
			when: isStorage,
			schema: (v) =>
				z.object({
					s3Hostname: v.s3Domain === "custom" ? hostname : z.string(),
					consoleHostname:
						v.consoleDomain === "custom" && hasConsole(v)
							? hostname.refine(
									(h) => h !== v.s3Hostname.trim().toLowerCase(),
									"Use a different hostname than the S3 endpoint.",
								)
							: z.string(),
				}),
			render: (w) => {
				const e = STORAGE_ENGINES[w.values.storageEngine];
				return (
					<div className="grid gap-3">
						<DomainChooser
							w={w}
							which="s3"
							title="S3 endpoint"
							off={`Only apps in ${envName} can reach it, at http://${slug(w.values)}:${e.s3Port}. Share links go through LogiStack.`}
							generated={generated(w.values)}
						/>
						{e.consolePort ? (
							<DomainChooser
								w={w}
								which="console"
								title="Web console"
								off={`The ${e.label} console stays off the internet.`}
								generated={generated(w.values)}
								modes={
									w.values.s3Domain === "generated"
										? MODES.filter((m) => m.value !== "generated")
										: MODES
								}
							/>
						) : (
							<p className="px-1 text-sm text-muted-foreground">
								{e.label} has no web console. Browse buckets from the Storage
								tab of the service.
							</p>
						)}
					</div>
				);
			},
		},
	];
}

/** Review rows for the object storage branch. */
export function storageSummary<V extends StorageValues>(
	v: V,
	generated: (v: V) => string,
): SummarySection {
	const e = STORAGE_ENGINES[v.storageEngine];
	const host = (mode: DomainMode, custom: string) =>
		mode === "none" ? (
			"Off"
		) : (
			<span className="font-mono text-xs">
				https://{mode === "custom" ? custom.trim().toLowerCase() : generated(v)}
			</span>
		);
	return {
		stepId: "storage-access",
		title: "Public access",
		rows: [
			{
				label: "S3 endpoint",
				value: host(v.s3Domain, v.s3Hostname),
			},
			{
				label: "Console",
				value: e.consolePort
					? host(v.consoleDomain, v.consoleHostname)
					: `Not available in ${e.label}`,
			},
		],
	};
}

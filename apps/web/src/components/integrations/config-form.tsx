import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChoiceGroup } from "@/components/wizard/parts";
import { fieldLabel } from "@/lib/integrations";
import { cn } from "@/lib/utils";

/** The subset of JSON Schema `z.toJSONSchema` emits for provider and channel configs. */
type Prop = {
	type?: "string" | "integer" | "number" | "boolean" | "array";
	const?: string;
	default?: unknown;
	secret?: boolean;
	format?: string;
	items?: { type?: string; format?: string };
};
type ObjectSchema = {
	type?: "object";
	properties: Record<string, Prop>;
	required?: string[];
};
export type ConfigSchema = ObjectSchema | { oneOf: ObjectSchema[] };

/** Form state: every control holds a string, converted once on submit. */
export type ConfigValues = Record<string, string>;

const isUnion = (s: ConfigSchema): s is { oneOf: ObjectSchema[] } =>
	"oneOf" in s;

/** The property every variant pins with `const` (email's `transport`). */
function discriminator(s: ConfigSchema): string | undefined {
	if (!isUnion(s)) return undefined;
	const first = s.oneOf[0];
	return Object.keys(first?.properties ?? {}).find((k) =>
		s.oneOf.every((o) => typeof o.properties[k]?.const === "string"),
	);
}

function active(s: ConfigSchema, values: ConfigValues): ObjectSchema {
	if (!isUnion(s)) return s;
	const key = discriminator(s);
	return (
		s.oneOf.find((o) => key && o.properties[key]?.const === values[key]) ??
		(s.oneOf[0] as ObjectSchema)
	);
}

/** Starting values: the first variant and every default. */
export function initialValues(s: ConfigSchema): ConfigValues {
	const obj = active(s, {});
	return Object.fromEntries(
		Object.entries(obj.properties).flatMap(([k, p]) =>
			p.const !== undefined
				? [[k, p.const]]
				: p.default !== undefined
					? [[k, String(p.default)]]
					: [],
		),
	);
}

/** Converts form strings to the types the schema wants; empty optional fields are left out. */
export function toConfig(
	s: ConfigSchema,
	values: ConfigValues,
): Record<string, unknown> {
	const obj = active(s, values);
	const out: Record<string, unknown> = {};
	for (const [k, p] of Object.entries(obj.properties)) {
		if (p.const !== undefined) {
			out[k] = p.const;
			continue;
		}
		const raw = (values[k] ?? "").trim();
		if (p.type === "boolean") out[k] = raw === "true";
		else if (raw === "") continue;
		else if (p.type === "integer" || p.type === "number") out[k] = Number(raw);
		else if (p.type === "array") out[k] = raw.split(/[\s,;]+/).filter(Boolean);
		else out[k] = raw;
	}
	return out;
}

/** Required fields left empty; the server's zod schema does the rest. */
export function missingFields(s: ConfigSchema, values: ConfigValues) {
	const obj = active(s, values);
	return Object.fromEntries(
		(obj.required ?? [])
			.filter((k) => obj.properties[k]?.type !== "boolean")
			.filter((k) => !(values[k] ?? "").trim())
			.map((k) => [k, `Enter the ${fieldLabel(k).toLowerCase()}.`]),
	);
}

function SecretInput({
	id,
	value,
	onChange,
	invalid,
}: {
	id: string;
	value: string;
	onChange: (v: string) => void;
	invalid: boolean;
}) {
	const [shown, setShown] = useState(false);
	return (
		<div className="relative">
			<LockKeyhole
				className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
				aria-hidden
			/>
			<Input
				id={id}
				type={shown ? "text" : "password"}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				autoComplete="off"
				spellCheck={false}
				aria-invalid={invalid || undefined}
				aria-describedby={`${id}-msg`}
				className="pr-9 pl-8 font-mono"
			/>
			<button
				type="button"
				onClick={() => setShown((s) => !s)}
				aria-label={shown ? "Hide value" : "Show value"}
				aria-pressed={shown}
				className="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors duration-(--duration-quick) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				{shown ? (
					<EyeOff className="size-4" aria-hidden />
				) : (
					<Eye className="size-4" aria-hidden />
				)}
			</button>
		</div>
	);
}

/**
 * Renders a provider's or channel's credential fields straight from its JSON Schema:
 * fields marked `secret` are masked, never stored in the wizard's session answers, and
 * show a lock; a `oneOf` becomes a choice of variant (email: SMTP or Resend).
 */
export function ConfigFields({
	schema,
	values,
	onChange,
	errors = {},
	idPrefix,
	hints = {},
}: {
	schema: ConfigSchema;
	values: ConfigValues;
	onChange: (values: ConfigValues) => void;
	errors?: Record<string, string>;
	idPrefix: string;
	hints?: Record<string, string>;
}) {
	const disc = discriminator(schema);
	const obj = active(schema, values);
	const set = (k: string, v: string) => onChange({ ...values, [k]: v });
	return (
		<div className="grid gap-5">
			{disc && isUnion(schema) && (
				<ChoiceGroup
					label={fieldLabel(disc)}
					value={values[disc] ?? obj.properties[disc]?.const}
					onChange={(v) => {
						const next = schema.oneOf.find(
							(o) => o.properties[disc]?.const === v,
						);
						onChange(
							next
								? {
										...initialValues({ ...next }),
										...keepShared(values, next),
										[disc]: v,
									}
								: values,
						);
					}}
					choices={schema.oneOf.map((o) => {
						const v = o.properties[disc]?.const as string;
						return {
							value: v,
							title: v === "smtp" ? "SMTP server" : fieldLabel(v),
							description:
								v === "smtp"
									? "Your mail server, with STARTTLS or implicit TLS."
									: v === "resend"
										? "Resend's HTTP API with an API key."
										: "",
						};
					})}
				/>
			)}
			<div className="grid gap-4 sm:grid-cols-2">
				{Object.entries(obj.properties)
					.filter(([, p]) => p.const === undefined)
					.map(([k, p]) => {
						const id = `${idPrefix}-${k}`;
						const required = obj.required?.includes(k) ?? false;
						const wide =
							p.secret ||
							p.format === "uri" ||
							p.type === "array" ||
							k === "host";
						if (p.type === "boolean")
							return (
								<label
									key={k}
									htmlFor={id}
									className="flex cursor-pointer items-center justify-between gap-4 rounded-lg bg-card px-3.5 py-3 ring-1 ring-border sm:col-span-2"
								>
									<span className="text-sm">
										<span className="font-medium">{fieldLabel(k)}</span>
										{hints[k] && (
											<span className="block text-xs text-muted-foreground">
												{hints[k]}
											</span>
										)}
									</span>
									<Switch
										id={id}
										checked={values[k] === "true"}
										onCheckedChange={(c) => set(k, String(c))}
									/>
								</label>
							);
						return (
							<Field
								key={k}
								id={id}
								label={fieldLabel(k)}
								optional={!required && p.default === undefined}
								error={errors[k]}
								hint={
									hints[k] ??
									(p.type === "array"
										? "Separate several with commas."
										: p.secret
											? "Stored encrypted. Never shown again after saving."
											: undefined)
								}
								className={cn(wide && "sm:col-span-2")}
							>
								{p.secret ? (
									<SecretInput
										id={id}
										value={values[k] ?? ""}
										onChange={(v) => set(k, v)}
										invalid={Boolean(errors[k])}
									/>
								) : (
									<Input
										id={id}
										value={values[k] ?? ""}
										onChange={(e) => set(k, e.target.value)}
										inputMode={p.type === "integer" ? "numeric" : undefined}
										placeholder={
											p.default !== undefined
												? String(p.default)
												: p.format === "uri"
													? "https://"
													: undefined
										}
										autoCapitalize="none"
										spellCheck={false}
										aria-invalid={errors[k] ? true : undefined}
										aria-describedby={`${id}-msg`}
										className={cn(
											(p.format === "uri" ||
												k.endsWith("Id") ||
												k === "host") &&
												"font-mono",
										)}
									/>
								)}
							</Field>
						);
					})}
			</div>
		</div>
	);
}

/** Switching variant keeps what both share (from, to). */
function keepShared(values: ConfigValues, next: ObjectSchema): ConfigValues {
	return Object.fromEntries(
		Object.entries(values).filter(
			([k]) => k in next.properties && next.properties[k]?.const === undefined,
		),
	);
}

import type { Template, TemplateInput } from "@logistack/contracts";
import { ChevronDown, KeyRound } from "lucide-react";
import { useRef, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import type { WizardApi } from "@/components/wizard/wizard";
import { inputGroup, isSecretInput, publicRoutes } from "@/lib/templates";
import { generatedExample } from "./overview";

export type TemplateValues = Record<string, string>;
type W = WizardApi<TemplateValues>;

/** The settings step: addresses, required text, generated credentials, then optional text. */
export function TemplateInputs({
	w,
	template: t,
	base,
}: {
	w: W;
	template: Template;
	base: string;
}) {
	const by = (g: ReturnType<typeof inputGroup>) =>
		t.inputs.filter((i) => inputGroup(i) === g);
	const routes = publicRoutes(t);
	const domains = routes.map((r) => r.input);
	const required = by("required");
	const generated = by("generated");
	const optional = by("optional");
	return (
		<div className="grid grid-cols-1 gap-8">
			{domains.length > 0 && (
				<Group title="Address">
					{domains.map((i) => {
						const route = routes.find((r) => r.input.key === i.key);
						const example = generatedExample(route?.service ?? t.id, base);
						return (
							<Field
								key={i.key}
								id={`wz-${i.key}`}
								label={i.role === "primary" ? "Public URL" : i.label}
								optional
								error={w.error(i.key)}
								hint={
									<>
										Empty uses a generated address like{" "}
										<span className="font-mono text-foreground break-all">
											{example}
										</span>
										. For your own domain, point its DNS at this server first.
									</>
								}
							>
								<Input
									{...w.bind(i.key)}
									inputMode="url"
									autoComplete="off"
									spellCheck={false}
									placeholder={`${route?.service ?? "app"}.example.com`}
									className="font-mono"
								/>
							</Field>
						);
					})}
				</Group>
			)}

			{required.length > 0 && (
				<Group title="Required">
					{required.map((i) => (
						<Field
							key={i.key}
							id={`wz-${i.key}`}
							label={i.label}
							error={w.error(i.key)}
							hint={i.description}
						>
							<Input {...w.bind(i.key)} autoComplete="off" />
						</Field>
					))}
				</Group>
			)}

			{generated.length > 0 && (
				<Group
					title="Credentials"
					description="Generated when you deploy and stored as secrets. Set your own only if you need a known value."
				>
					<ul className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
						{generated.map((i) => (
							<GeneratedRow key={i.key} w={w} input={i} />
						))}
					</ul>
				</Group>
			)}

			{optional.length > 0 && (
				<Collapsible>
					<CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 rounded-lg py-1 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
						<span>
							Optional settings{" "}
							<span className="font-normal text-muted-foreground tabular">
								{optional.length}
							</span>
						</span>
						<ChevronDown
							className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:-scale-y-100"
							aria-hidden
						/>
					</CollapsibleTrigger>
					<CollapsibleContent className="grid grid-cols-1 gap-5 pt-4 sm:grid-cols-2">
						{optional.map((i) => (
							<Field
								key={i.key}
								id={`wz-${i.key}`}
								label={i.label}
								optional
								error={w.error(i.key)}
								hint={i.description}
							>
								<Input
									{...w.bind(i.key)}
									autoComplete="off"
									placeholder={
										i.type === "text" && i.default ? i.default : "Not set"
									}
								/>
							</Field>
						))}
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

function Group({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="grid grid-cols-1 gap-4">
			<div>
				<h3 className="text-sm font-semibold [font-stretch:100%]">{title}</h3>
				{description && (
					<p className="mt-0.5 max-w-[62ch] text-sm text-muted-foreground">
						{description}
					</p>
				)}
			</div>
			{children}
		</section>
	);
}

/** "Auto-generated" until the person chooses to type a value; clearing it hands it back to the server. */
function GeneratedRow({ w, input }: { w: W; input: TemplateInput }) {
	const value = w.values[input.key] ?? "";
	const [editing, setEditing] = useState(value !== "");
	const field = useRef<HTMLInputElement>(null);
	const id = `wz-${input.key}`;
	const fallback =
		input.type === "username" && input.default
			? `Defaults to ${input.default}`
			: "Auto-generated";
	return (
		<li className="grid grid-cols-1 gap-3 px-4 py-3">
			<div className="flex items-center gap-3">
				<KeyRound
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					<label htmlFor={editing ? id : undefined} className="block text-sm">
						{input.label}
					</label>
					{!editing && (
						<span className="block text-xs text-muted-foreground">
							{fallback}
						</span>
					)}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-expanded={editing}
					aria-controls={id}
					onClick={() => {
						if (editing) w.set(input.key, "");
						else requestAnimationFrame(() => field.current?.focus());
						setEditing(!editing);
					}}
				>
					{editing ? "Generate instead" : "Set my own"}
				</Button>
			</div>
			{editing && (
				<Input
					{...w.bind(input.key)}
					ref={field}
					type={isSecretInput(input) ? "password" : "text"}
					autoComplete={isSecretInput(input) ? "new-password" : "off"}
					placeholder={fallback}
					className="t-reveal font-mono"
				/>
			)}
		</li>
	);
}

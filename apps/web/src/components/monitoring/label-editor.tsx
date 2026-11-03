import { Check, Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PRESETS = [
	{ key: "ingress", hint: "Runs the Caddy ingress and takes public traffic" },
	{ key: "build", hint: "Runs image builds" },
	{ key: "data", hint: "Hosts databases and other stateful services" },
] as const;

/** Same rule as the API's NodeLabels key. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function labelKeyError(key: string): string | undefined {
	if (!key) return "Enter a key";
	if (key.length > 128) return "128 characters at most";
	if (!KEY.test(key)) return "Letters, digits, . _ / - and no leading symbol";
}

/**
 * Placement labels: three role chips (`ingress=true`, …) and free key=value pairs.
 * Controlled; every change hands back the whole map.
 */
export function LabelEditor({
	value,
	onChange,
}: {
	value: Record<string, string>;
	onChange: (labels: Record<string, string>) => void;
}) {
	const id = useId();
	const [key, setKey] = useState("");
	const [val, setVal] = useState("");
	const [error, setError] = useState<string>();
	const custom = Object.entries(value).filter(
		([k, v]) => !(PRESETS.some((p) => p.key === k) && v === "true"),
	);

	function toggle(k: string) {
		const next = { ...value };
		if (next[k] === "true") delete next[k];
		else next[k] = "true";
		onChange(next);
	}

	function add() {
		const k = key.trim();
		const e = labelKeyError(k);
		if (e) return setError(e);
		if (val.length > 256) return setError("Values are 256 characters at most");
		onChange({ ...value, [k]: val.trim() });
		setKey("");
		setVal("");
		setError(undefined);
	}

	return (
		<div className="grid gap-4">
			<fieldset className="flex flex-wrap gap-2">
				<legend className="sr-only">Roles</legend>
				{PRESETS.map((p) => {
					const on = value[p.key] === "true";
					return (
						<button
							key={p.key}
							type="button"
							aria-pressed={on}
							title={p.hint}
							onClick={() => toggle(p.key)}
							className={cn(
								"inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm ring-1 outline-none t-press transition-[background-color,color,box-shadow] duration-(--duration-quick) focus-visible:ring-2 focus-visible:ring-ring",
								on
									? "bg-foreground text-background ring-foreground"
									: "bg-card text-muted-foreground ring-border hover:text-foreground hover:ring-foreground/25",
							)}
						>
							{on ? (
								<Check className="size-3.5" strokeWidth={2.25} aria-hidden />
							) : (
								<Plus className="size-3.5" aria-hidden />
							)}
							{p.key}
						</button>
					);
				})}
			</fieldset>

			{custom.length > 0 && (
				<ul className="grid gap-1.5" aria-label="Custom labels">
					{custom.map(([k, v]) => (
						<li
							key={k}
							className="flex items-center gap-2 rounded-md bg-muted/60 py-1 pr-1 pl-2.5 text-sm dark:bg-muted/40"
						>
							<span className="min-w-0 flex-1 truncate font-mono text-xs">
								{k}
								<span className="text-muted-foreground">=</span>
								{v}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={`Remove label ${k}`}
								onClick={() => {
									const next = { ...value };
									delete next[k];
									onChange(next);
								}}
							>
								<X />
							</Button>
						</li>
					))}
				</ul>
			)}

			<div className="grid gap-1.5">
				<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
					<Input
						aria-label="Label key"
						placeholder="Key"
						value={key}
						onChange={(e) => {
							setKey(e.target.value);
							setError(undefined);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								add();
							}
						}}
						aria-invalid={error ? true : undefined}
						aria-describedby={`${id}-msg`}
						className="font-mono text-xs"
					/>
					<Input
						aria-label="Label value"
						placeholder="Value"
						value={val}
						onChange={(e) => setVal(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								add();
							}
						}}
						className="font-mono text-xs"
					/>
					<Button
						type="button"
						variant="outline"
						onClick={add}
						disabled={!key.trim()}
					>
						Add
					</Button>
				</div>
				<p
					id={`${id}-msg`}
					aria-live="polite"
					className={cn(
						"text-xs",
						error ? "text-bad-text" : "text-muted-foreground",
					)}
				>
					{error ??
						"Services pin to nodes by these labels. Press Enter to add."}
				</p>
			</div>
		</div>
	);
}

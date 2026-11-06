import type { ApplicationSpec, ReleaseCommand } from "@logistack/contracts";
import { useState } from "react";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type ReleaseSettings = Pick<ApplicationSpec, "preDeploy" | "postDeploy">;
type Phase = keyof ReleaseSettings;

const DEFAULT_TIMEOUT = 600;

const argv = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

const PHASES: Record<
	Phase,
	{ label: string; hint: string; placeholder: string }
> = {
	preDeploy: {
		label: "Pre-deploy command",
		hint: "Runs once on the new image, with the service's variables and networks, before any replica is replaced. If it fails, the deployment fails and the current version keeps running.",
		placeholder: "bun\nrun\ndb:migrate",
	},
	postDeploy: {
		label: "Post-deploy command",
		hint: "Runs once after the new replicas are healthy. If it fails, the deployment is marked with a warning and stays live.",
		placeholder: "bun\nrun\ncache:warm",
	},
};

function PhaseFields({
	phase,
	value,
	onChange,
	idPrefix,
}: {
	phase: Phase;
	value: ReleaseCommand | undefined;
	onChange: (v: ReleaseCommand | undefined) => void;
	idPrefix: string;
}) {
	const meta = PHASES[phase];
	const id = `${idPrefix}${phase}`;
	// The text keeps blank lines while typing; it follows the value when that changes elsewhere (Discard).
	const [text, setText] = useState(() => value?.command.join("\n") ?? "");
	const command = value?.command ?? [];
	const key = JSON.stringify(command);
	const [synced, setSynced] = useState(key);
	if (synced !== key) {
		setSynced(key);
		if (JSON.stringify(argv(text)) !== key) setText(command.join("\n"));
	}
	const timeout = value?.timeoutSeconds ?? DEFAULT_TIMEOUT;
	return (
		<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
			<Field id={id} label={meta.label} hint={meta.hint} optional>
				<Textarea
					id={id}
					rows={3}
					spellCheck={false}
					className="font-mono text-[13px]"
					placeholder={meta.placeholder}
					aria-describedby={`${id}-msg`}
					value={text}
					onChange={(e) => {
						setText(e.target.value);
						const next = argv(e.target.value);
						onChange(
							next.length
								? { command: next, timeoutSeconds: timeout }
								: undefined,
						);
					}}
				/>
			</Field>
			<Field id={`${id}-timeout`} label="Timeout" hint="Seconds, 10 to 7200.">
				<Input
					id={`${id}-timeout`}
					type="number"
					min={10}
					max={7200}
					inputMode="numeric"
					className="tabular"
					disabled={!value}
					value={timeout}
					onChange={(e) =>
						value &&
						onChange({ ...value, timeoutSeconds: Number(e.target.value) })
					}
				/>
			</Field>
		</div>
	);
}

/** Pre- and post-deploy commands: argv, one argument per line, never wrapped in a shell. */
export function ReleaseCommandFields({
	value,
	onChange,
	idPrefix,
}: {
	value: ReleaseSettings;
	onChange: (patch: Partial<ReleaseSettings>) => void;
	idPrefix: string;
}) {
	return (
		<div className="grid gap-5">
			{(["preDeploy", "postDeploy"] as const).map((phase) => (
				<PhaseFields
					key={phase}
					phase={phase}
					value={value[phase]}
					onChange={(v) => onChange({ [phase]: v })}
					idPrefix={idPrefix}
				/>
			))}
		</div>
	);
}

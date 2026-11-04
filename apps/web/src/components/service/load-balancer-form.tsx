import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/field";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Service } from "@/lib/api/types";
import {
	healthPathIssue,
	type LbAlgorithm,
	type LbSettings,
	targetIssue,
} from "@/lib/webservers";

/** `slug:port` for each application in the environment that routes a port, except `self`. */
export function targetSuggestions(
	services: Pick<Service, "id" | "slug" | "spec">[],
	self?: string,
) {
	return services.flatMap((s) =>
		s.id !== self && s.spec.kind === "application" && s.spec.ports[0]
			? [`${s.slug}:${s.spec.ports[0].target}`]
			: [],
	);
}

/** Upstream targets, algorithm and health check; the config is generated from these. */
export function LoadBalancerForm({
	value,
	onChange,
	suggestions,
	idPrefix,
	error,
}: {
	value: LbSettings;
	onChange: (v: LbSettings) => void;
	suggestions: string[];
	idPrefix: string;
	/** A form-level problem to show once the user tried to continue. */
	error?: string;
}) {
	const set = (p: Partial<LbSettings>) => onChange({ ...value, ...p });
	// Rows are checked once left, so typing "web" on the way to "web:3000" is not an error.
	const [left, setLeft] = useState<Set<number>>(new Set());
	const rows = value.targets.length ? value.targets : [""];
	const setRow = (i: number, t: string) =>
		set({ targets: rows.map((r, j) => (j === i ? t : r)) });
	const listId = `${idPrefix}targets-list`;
	return (
		<div className="grid gap-6">
			<fieldset className="grid gap-2">
				<legend className="mb-2 text-sm font-medium">Targets</legend>
				<p className="-mt-1 text-xs text-muted-foreground">
					Services in this environment by name, or any host the server can
					reach, each as host:port.
				</p>
				<datalist id={listId}>
					{suggestions.map((s) => (
						<option key={s} value={s} />
					))}
				</datalist>
				<ul className="grid gap-2">
					{rows.map((t, i) => {
						const issue =
							t.trim() && (left.has(i) || error) ? targetIssue(t) : undefined;
						const id = `${idPrefix}target-${i}`;
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and edited in place
							<li key={i} className="grid gap-1">
								<div className="flex items-center gap-2">
									<Input
										id={id}
										value={t}
										onChange={(e) => setRow(i, e.target.value)}
										onBlur={() => setLeft((l) => new Set(l).add(i))}
										list={listId}
										placeholder={suggestions[i] ?? "web:3000"}
										aria-label={`Target ${i + 1}`}
										aria-invalid={issue ? true : undefined}
										aria-describedby={issue ? `${id}-msg` : undefined}
										autoCapitalize="none"
										spellCheck={false}
										className="font-mono"
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										aria-label={`Remove target ${i + 1}`}
										disabled={rows.length === 1 && !t}
										onClick={() =>
											set({ targets: rows.filter((_, j) => j !== i) })
										}
									>
										<X />
									</Button>
								</div>
								{issue && (
									<p id={`${id}-msg`} className="text-xs text-bad-text">
										{issue}
									</p>
								)}
							</li>
						);
					})}
				</ul>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="w-fit"
					onClick={() => set({ targets: [...rows, ""] })}
				>
					<Plus data-icon="inline-start" />
					Add target
				</Button>
				{error && !rows.some((r) => r.trim()) && (
					<p className="text-xs text-bad-text" role="alert">
						{error}
					</p>
				)}
			</fieldset>
			<div className="grid gap-2">
				<span className="text-sm font-medium">Balancing</span>
				<div className="justify-self-start">
					<Segmented<LbAlgorithm>
						label="Balancing algorithm"
						value={value.algorithm}
						onChange={(algorithm) => set({ algorithm })}
						options={[
							{ value: "roundrobin", label: "Round robin" },
							{ value: "leastconn", label: "Fewest connections" },
						]}
					/>
				</div>
				<p className="text-xs text-muted-foreground">
					{value.algorithm === "roundrobin"
						? "Each request goes to the next target in turn."
						: "Each request goes to the target with the fewest open connections; better for long requests."}
				</p>
			</div>
			<Field
				id={`${idPrefix}health`}
				label="Health check path"
				optional
				error={healthPathIssue(value.healthPath)}
				hint="Requested on every target; a target that does not answer 2xx or 3xx stops getting traffic. Empty checks the port only."
			>
				<Input
					id={`${idPrefix}health`}
					value={value.healthPath}
					onChange={(e) => set({ healthPath: e.target.value.trim() })}
					placeholder="/healthz"
					autoCapitalize="none"
					spellCheck={false}
					className="font-mono"
				/>
			</Field>
		</div>
	);
}

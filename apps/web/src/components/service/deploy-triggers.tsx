import { GitTrigger } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/field";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { integrations, type GitTrigger as Rules } from "@/lib/api/integrations";
import { serviceKey, useServiceMutation } from "@/lib/api/service-ops";
import type { ServiceId } from "@/lib/api/types";

const pathList = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/** Which git events deploy the service: loads, edits and saves its own two endpoints. */
export function DeployTriggers({
	serviceId,
	branch,
}: {
	serviceId: ServiceId;
	branch: string;
}) {
	const { data } = useQuery({
		queryKey: [...serviceKey(serviceId), "deploy-triggers"],
		queryFn: async () => {
			const [rules, watch] = await Promise.all([
				integrations.gitTrigger.get(serviceId),
				integrations.watchPaths.get(serviceId),
			]);
			return { rules, paths: watch.paths.join("\n") };
		},
	});
	return (
		<Panel
			title="Deploy triggers"
			id="triggers"
			bodyClassName="grid gap-5 p-4 sm:p-5"
		>
			<p className="-mb-1 max-w-[70ch] text-sm text-muted-foreground">
				Which git events deploy this service. A commit whose message contains{" "}
				<code className="font-mono text-xs">[skip ci]</code>,{" "}
				<code className="font-mono text-xs">[ci skip]</code> or{" "}
				<code className="font-mono text-xs">[skip deploy]</code> never deploys;
				held-back events appear in Deployments as skipped, with the reason.
			</p>
			{data ? (
				<TriggerFields
					key={JSON.stringify(data)}
					serviceId={serviceId}
					branch={branch}
					initial={data}
				/>
			) : (
				<div className="h-24 animate-pulse rounded-lg bg-muted/50" />
			)}
		</Panel>
	);
}

function TriggerFields({
	serviceId,
	branch,
	initial,
}: {
	serviceId: ServiceId;
	branch: string;
	initial: { rules: Rules; paths: string };
}) {
	const [rules, setRules] = useState(initial.rules);
	const [paths, setPaths] = useState(initial.paths);
	const set = (patch: Partial<Rules>) => setRules((r) => ({ ...r, ...patch }));
	const parsed = GitTrigger.safeParse(rules);
	const issueAt = (field: keyof Rules) =>
		parsed.error?.issues.find((i) => i.path[0] === field)?.message;
	const dirty =
		paths !== initial.paths ||
		JSON.stringify(rules) !== JSON.stringify(initial.rules);
	const save = useServiceMutation(serviceId, () =>
		Promise.all([
			integrations.gitTrigger.put(serviceId, rules),
			integrations.watchPaths.put(serviceId, pathList(paths)),
		]),
	);

	return (
		<>
			<div className="grid gap-4 sm:grid-cols-[16rem_minmax(0,1fr)]">
				<Field id="trigger-on" label="Deploy on">
					<Select
						value={rules.on}
						onValueChange={(on) => set({ on: on as Rules["on"] })}
					>
						<SelectTrigger id="trigger-on" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="branch">Pushes to {branch}</SelectItem>
							<SelectItem value="tag">Tags matching a pattern</SelectItem>
							<SelectItem value="release">Published releases</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				{rules.on === "branch" ? (
					<Field
						id="watch-paths"
						label="Watch paths"
						hint="One per line, a glob or a directory. Empty deploys on every push."
						optional
					>
						<Textarea
							id="watch-paths"
							rows={3}
							className="font-mono text-[13px]"
							placeholder={"apps/web\npackages/**/*.ts"}
							value={paths}
							onChange={(e) => setPaths(e.target.value)}
						/>
					</Field>
				) : (
					<Field
						id="tag-pattern"
						label="Tag pattern"
						hint={
							rules.on === "release" ? (
								"A glob over the release's tag. Bitbucket has no releases."
							) : (
								<>
									A glob such as <code className="font-mono">v*.*.*</code>;{" "}
									<code className="font-mono">*</code> matches any tag.
								</>
							)
						}
						error={issueAt("tagPattern")}
					>
						<Input
							id="tag-pattern"
							className="max-w-64 font-mono"
							value={rules.tagPattern}
							onChange={(e) => set({ tagPattern: e.target.value })}
						/>
					</Field>
				)}
			</div>
			<div className="grid gap-4">
				<div className="flex items-center gap-3 text-sm">
					<Switch
						id="wait-checks"
						checked={rules.waitForChecks}
						onCheckedChange={(waitForChecks) => set({ waitForChecks })}
					/>
					<label htmlFor="wait-checks">Wait for CI checks to pass</label>
				</div>
				{rules.waitForChecks && (
					<Field
						id="checks-timeout"
						label="Give up after"
						hint="Minutes. A failed or unfinished check skips the deployment."
						error={issueAt("checksTimeoutMinutes")}
					>
						<Input
							id="checks-timeout"
							type="number"
							min={1}
							max={720}
							className="max-w-32"
							value={rules.checksTimeoutMinutes || ""}
							onChange={(e) =>
								set({ checksTimeoutMinutes: Number(e.target.value) })
							}
						/>
					</Field>
				)}
			</div>
			<div className="flex justify-end">
				<Button
					disabled={!dirty || !parsed.success || save.isPending}
					onClick={() =>
						save.mutate(undefined, {
							onSuccess: () => toast.success("Deploy triggers saved"),
							onError: (e) =>
								toast.error("Couldn't save", { description: e.message }),
						})
					}
				>
					Save triggers
				</Button>
			</div>
		</>
	);
}

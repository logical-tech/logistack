import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { Channel, EventType, RuleInput } from "@/lib/api/networking";
import type { ProjectSummary } from "@/lib/api/types";
import { CHANNEL_KINDS, EVENT_GROUPS } from "@/lib/integrations";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/**
 * Events × scope × channel. Events are toggles grouped by subsystem; the scope narrows to a
 * project, then optionally one of its services. Saving is the caller's.
 */
export function RuleEditor({
	initial,
	channels,
	projects,
	onSave,
	onCancel,
	title,
}: {
	initial: RuleInput;
	channels: Channel[];
	projects: ProjectSummary[];
	onSave: (rule: RuleInput) => Promise<void>;
	onCancel: () => void;
	title: string;
}) {
	const [rule, setRule] = useState<RuleInput>(initial);
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	const project = projects.find((p) => p.id === rule.scope.projectId);
	const toggle = (t: EventType) =>
		setRule((r) => ({
			...r,
			events: r.events.includes(t)
				? r.events.filter((e) => e !== t)
				: [...r.events, t],
		}));
	const invalid = rule.events.length === 0 || !rule.channelId;

	return (
		<form
			className="t-reveal grid gap-6 rounded-xl bg-card p-4 shadow-card ring-1 ring-border sm:p-5"
			onSubmit={async (e) => {
				e.preventDefault();
				setTried(true);
				if (invalid) return;
				setBusy(true);
				try {
					await onSave(rule);
				} finally {
					setBusy(false);
				}
			}}
			aria-label={title}
		>
			<h3 className="text-sm font-semibold">{title}</h3>
			<fieldset className="grid gap-4">
				<legend className="mb-3 text-sm font-medium">
					When
					{tried && rule.events.length === 0 && (
						<span className="ml-2 font-normal text-bad-text" role="alert">
							Pick at least one event.
						</span>
					)}
				</legend>
				<div className="grid gap-4 md:grid-cols-2">
					{EVENT_GROUPS.map((g) => (
						<div key={g.label} className="grid content-start gap-2">
							<p className="text-xs text-muted-foreground">{g.label}</p>
							<div className="flex flex-wrap gap-1.5">
								{g.events.map((e) => {
									const on = rule.events.includes(e.type);
									return (
										<button
											key={e.type}
											type="button"
											aria-pressed={on}
											onClick={() => toggle(e.type)}
											className={cn(
												"inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ring-1 ring-border t-press transition-colors duration-(--duration-quick)",
												"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
												on
													? "bg-foreground text-background ring-foreground"
													: "bg-background text-foreground hover:bg-muted",
											)}
										>
											<Check
												className={cn(
													"size-3 transition-[width,opacity] duration-(--duration-fast)",
													on ? "w-3 opacity-100" : "w-0 opacity-0",
												)}
												strokeWidth={3}
												aria-hidden
											/>
											{e.label}
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</fieldset>

			<div className="grid gap-4 sm:grid-cols-3">
				<Field id="rule-project" label="In">
					<Select
						value={rule.scope.projectId ?? ALL}
						onValueChange={(v) =>
							setRule((r) => ({
								...r,
								scope: v === ALL ? {} : { projectId: v },
							}))
						}
					>
						<SelectTrigger id="rule-project" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All projects</SelectItem>
							{projects.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field id="rule-service" label="Service">
					<Select
						value={rule.scope.serviceId ?? ALL}
						disabled={!project}
						onValueChange={(v) =>
							setRule((r) => ({
								...r,
								scope: {
									projectId: r.scope.projectId,
									...(v === ALL ? {} : { serviceId: v }),
								},
							}))
						}
					>
						<SelectTrigger id="rule-service" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>
								{project ? "Every service" : "Pick a project first"}
							</SelectItem>
							{project?.services.map((s) => (
								<SelectItem key={s.id} value={s.id}>
									{s.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field
					id="rule-channel"
					label="Send to"
					error={tried && !rule.channelId ? "Pick a channel." : undefined}
				>
					<Select
						value={rule.channelId || undefined}
						onValueChange={(v) => setRule((r) => ({ ...r, channelId: v }))}
					>
						<SelectTrigger id="rule-channel" className="w-full">
							<SelectValue placeholder="Pick a channel" />
						</SelectTrigger>
						<SelectContent>
							{channels.map((c) => (
								<SelectItem key={c.id} value={c.id}>
									{c.name} · {CHANNEL_KINDS[c.kind].label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			</div>

			<div className="flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={onCancel}
					disabled={busy}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={busy}>
					{busy && <Loader2 className="animate-spin" />}
					Save rule
				</Button>
			</div>
		</form>
	);
}

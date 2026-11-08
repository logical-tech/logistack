import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { projectsQuery } from "@/lib/api/projects";

export type DrainScope = { projectIds: string[]; serviceIds: string[] };

const toggle = (list: string[], id: string, on: boolean) =>
	on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

/** "2 projects · 1 service", for lists and the wizard summary. */
export function scopeSummary(s: DrainScope): string {
	const parts = [
		s.projectIds.length &&
			`${s.projectIds.length} project${s.projectIds.length === 1 ? "" : "s"}`,
		s.serviceIds.length &&
			`${s.serviceIds.length} service${s.serviceIds.length === 1 ? "" : "s"}`,
	].filter(Boolean);
	return parts.length ? parts.join(" · ") : "Nothing yet";
}

/** A whole project (every service, present and future) or single services in it. */
export function DrainScopePicker({
	value,
	onChange,
	invalid,
}: {
	value: DrainScope;
	onChange: (v: DrainScope) => void;
	invalid?: boolean;
}) {
	const { data: projects, isPending } = useQuery(projectsQuery);
	if (isPending)
		return <p className="text-sm text-muted-foreground">Loading projects…</p>;
	if (!projects?.length)
		return (
			<p className="text-sm text-muted-foreground">
				No projects yet. Save the drain now and enable it on a project later.
			</p>
		);
	return (
		<ul
			className="max-w-xl divide-y rounded-lg bg-card ring-1 ring-border aria-invalid:ring-destructive"
			aria-invalid={invalid || undefined}
		>
			{projects.map((p) => {
				const whole = value.projectIds.includes(p.id);
				const pid = `scope-${p.id}`;
				return (
					<li key={p.id} className="px-4 py-3">
						<label htmlFor={pid} className="flex items-center gap-3 text-sm">
							<Checkbox
								id={pid}
								checked={whole}
								onCheckedChange={(on) =>
									onChange({
										projectIds: toggle(value.projectIds, p.id, on === true),
										// The whole project covers its services; drop the single picks.
										serviceIds: on
											? value.serviceIds.filter(
													(id) => !p.services.some((s) => s.id === id),
												)
											: value.serviceIds,
									})
								}
							/>
							<span className="font-medium">{p.name}</span>
							<span className="text-muted-foreground">
								{whole
									? "All services, including new ones"
									: `${p.services.length} service${p.services.length === 1 ? "" : "s"}`}
							</span>
						</label>
						{!whole && p.services.length > 0 && (
							<ul className="mt-2.5 grid gap-2 pl-7 sm:grid-cols-2">
								{p.services.map((s) => {
									const sid = `scope-${s.id}`;
									return (
										<li key={s.id}>
											<label
												htmlFor={sid}
												className="flex items-center gap-2.5 text-sm text-muted-foreground has-[[data-state=checked]]:text-foreground"
											>
												<Checkbox
													id={sid}
													checked={value.serviceIds.includes(s.id)}
													onCheckedChange={(on) =>
														onChange({
															...value,
															serviceIds: toggle(
																value.serviceIds,
																s.id,
																on === true,
															),
														})
													}
												/>
												<span className="truncate">
													{s.name}
													{p.environments.length > 1 && (
														<span className="text-muted-foreground">
															{" · "}
															{p.environments.find(
																(e) => e.id === s.environmentId,
															)?.name ?? ""}
														</span>
													)}
												</span>
											</label>
										</li>
									);
								})}
							</ul>
						)}
					</li>
				);
			})}
		</ul>
	);
}

import { StatusDot } from "@/components/status";
import { Checkbox } from "@/components/ui/checkbox";
import type { Monitor } from "@/lib/api/uptime";
import { MONITOR_STATUS } from "./parts";

/** A checkbox per monitor; the whole row is the hit area. */
export function MonitorPicker({
	monitors,
	value,
	onChange,
	idPrefix,
}: {
	monitors: Monitor[];
	value: string[];
	onChange: (ids: string[]) => void;
	idPrefix: string;
}) {
	if (monitors.length === 0)
		return <p className="text-sm text-muted-foreground">No monitors yet.</p>;
	return (
		<ul className="max-h-60 divide-y overflow-y-auto rounded-lg ring-1 ring-border">
			{monitors.map((m) => {
				const id = `${idPrefix}-${m.id}`;
				const on = value.includes(m.id);
				return (
					<li key={m.id}>
						<label
							htmlFor={id}
							className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors duration-(--duration-quick) hover:bg-muted/40"
						>
							<Checkbox
								id={id}
								checked={on}
								onCheckedChange={(c) =>
									onChange(
										c ? [...value, m.id] : value.filter((x) => x !== m.id),
									)
								}
							/>
							<StatusDot meta={MONITOR_STATUS[m.status]} />
							<span className="truncate">{m.name}</span>
						</label>
					</li>
				);
			})}
		</ul>
	);
}

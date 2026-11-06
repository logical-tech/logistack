import type { ResourceProfile, Resources } from "@logistack/contracts";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useResourceProfiles } from "@/lib/api/access";

export const UNLIMITED = "__unlimited";
const CUSTOM = "__custom";

const memory = (mb: number) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);

/** "0.5 CPU · 512 MB", or "Unlimited" when neither is set. */
export function limitsLabel({ cpu, memoryMb }: Resources) {
	const parts = [
		...(cpu ? [`${cpu} CPU`] : []),
		...(memoryMb ? [memory(memoryMb)] : []),
	];
	return parts.length ? parts.join(" · ") : "Unlimited";
}

export const limitsOf = ({ cpu, memoryMb }: Resources): Resources => ({
	...(cpu ? { cpu } : {}),
	...(memoryMb ? { memoryMb } : {}),
});

/** The profile whose limits these are, if any; a service stores values, not a profile reference. */
export const matchingProfile = (r: Resources, profiles: ResourceProfile[]) =>
	profiles.find(
		(p) =>
			(p.cpu ?? null) === (r.cpu ?? null) &&
			(p.memoryMb ?? null) === (r.memoryMb ?? null),
	);

/**
 * Picks an organization profile and hands back its limits. `value` is a profile name or
 * UNLIMITED; values that match no profile show as Custom.
 */
export function ResourceProfileSelect({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (name: string, resources: Resources) => void;
}) {
	const { data } = useResourceProfiles();
	const profiles = data?.profiles ?? [];
	const known = value === UNLIMITED || profiles.some((p) => p.name === value);
	return (
		<Select
			value={known ? value : CUSTOM}
			onValueChange={(v) => {
				if (v === UNLIMITED) onChange(v, {});
				const p = profiles.find((p) => p.name === v);
				if (p) onChange(v, limitsOf(p));
			}}
		>
			<SelectTrigger id={id} className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{profiles.map((p) => (
					<SelectItem key={p.name} value={p.name}>
						{p.name}{" "}
						<span className="text-muted-foreground tabular-nums">
							{limitsLabel(p)}
						</span>
					</SelectItem>
				))}
				<SelectItem value={UNLIMITED}>Unlimited</SelectItem>
				{!known && (
					<SelectItem value={CUSTOM} disabled>
						Custom
					</SelectItem>
				)}
			</SelectContent>
		</Select>
	);
}

import {
	defaultServiceIcon,
	type ServiceIcon,
	type ServiceSpec,
	serviceIcons,
} from "@logistack/contracts";
import {
	Box,
	ChevronsUpDown,
	Database,
	HardDrive,
	Layers,
	type LucideIcon,
	RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BrandIcon, brandTitle } from "@/components/brand-icon";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useServiceMutation } from "@/lib/api/service-ops";
import type { ServiceId } from "@/lib/api/types";
import { cn } from "@/lib/utils";

type Iconed = {
	kind: ServiceSpec["kind"];
	spec: ServiceSpec;
	icon: ServiceIcon | null;
};

const KIND_ICON: Record<ServiceSpec["kind"], LucideIcon> = {
	application: Box,
	database: Database,
	compose: Layers,
	storage: HardDrive,
};

/** The picked icon, else the engine's or image's, else none (the kind's glyph). */
export const serviceIconOf = (s: Iconed) =>
	s.icon ?? defaultServiceIcon(s.spec);

/** A service's mark: its brand when it has one, the kind's glyph otherwise. */
export function ServiceGlyph({
	service,
	className,
}: {
	service: Iconed;
	className?: string;
}) {
	const slug = serviceIconOf(service);
	const Kind = KIND_ICON[service.kind];
	return (
		<span
			className={cn(
				"grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground/80",
				className,
			)}
		>
			{slug ? (
				<BrandIcon slug={slug} />
			) : (
				<Kind className="size-4" strokeWidth={1.75} aria-hidden />
			)}
		</span>
	);
}

/** Searchable grid of the allowed icons; a pick saves at once. */
export function ServiceIconPicker({
	service,
}: {
	service: Iconed & { id: ServiceId };
}) {
	const [open, setOpen] = useState(false);
	const fallback = defaultServiceIcon(service.spec);
	const current = serviceIconOf(service);
	const save = useServiceMutation(service.id, (icon: ServiceIcon | null) =>
		api.serviceOps.update(service.id, { icon }),
	);
	const pick = (icon: ServiceIcon | null) => {
		setOpen(false);
		if (icon === service.icon) return;
		save.mutate(icon, {
			onError: (e) =>
				toast.error("Couldn't change the icon", {
					description: e instanceof Error ? e.message : undefined,
				}),
		});
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id="service-icon"
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					disabled={save.isPending}
					className="h-11 w-full max-w-sm justify-start gap-3 pr-2.5 pl-1.5 font-normal"
				>
					<ServiceGlyph service={service} className="size-8 rounded-md" />
					<span className="min-w-0 flex-1 truncate text-left">
						{current ? brandTitle(current) : "No brand"}
					</span>
					<span className="text-xs text-muted-foreground">
						{service.icon ? "Custom" : "Default"}
					</span>
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[22rem] p-0" align="start">
				<Command
					filter={(value, search) =>
						value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
					}
				>
					<CommandInput placeholder="Search icons" />
					<CommandList className="max-h-80">
						<CommandEmpty>No icon matches.</CommandEmpty>
						{service.icon && (
							<CommandGroup>
								<CommandItem value="reset default" onSelect={() => pick(null)}>
									<RotateCcw className="text-muted-foreground" />
									Reset to default
									<span className="text-muted-foreground">
										{fallback ? brandTitle(fallback) : "kind icon"}
									</span>
								</CommandItem>
							</CommandGroup>
						)}
						<CommandGroup className="**:[[cmdk-group-items]]:grid **:[[cmdk-group-items]]:grid-cols-7 **:[[cmdk-group-items]]:gap-1">
							{serviceIcons.map((slug) => {
								const title = brandTitle(slug);
								return (
									<CommandItem
										key={slug}
										value={`${title} ${slug}`}
										title={title}
										aria-label={title}
										data-checked={current === slug}
										onSelect={() => pick(slug)}
										className="aspect-square justify-center rounded-md p-0 text-muted-foreground data-selected:text-foreground data-[checked=true]:text-foreground data-[checked=true]:ring-1 data-[checked=true]:ring-foreground/50 data-[checked=true]:ring-inset [&>svg:last-child]:hidden"
									>
										<BrandIcon slug={slug} className="size-[18px]" />
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

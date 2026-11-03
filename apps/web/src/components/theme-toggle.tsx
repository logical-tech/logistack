import { Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const iconSwap =
	"absolute transition-[opacity,scale,filter] duration-(--duration-fast) ease-[cubic-bezier(0.2,0,0,1)]";

/** Sun and moon share one slot and cross-fade with scale and blur. */
export function ThemeIcon({ dark }: { dark: boolean }) {
	return (
		<span className="relative grid size-4 place-items-center" aria-hidden>
			<Sun
				className={cn(
					iconSwap,
					dark
						? "scale-25 opacity-0 blur-[4px]"
						: "scale-100 opacity-100 blur-0",
				)}
			/>
			<Moon
				className={cn(
					iconSwap,
					dark
						? "scale-100 opacity-100 blur-0"
						: "scale-25 opacity-0 blur-[4px]",
				)}
			/>
		</span>
	);
}

export function ThemeToggle() {
	const { preference, resolved, setTheme } = useTheme();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" aria-label="Theme">
					<ThemeIcon dark={resolved === "dark"} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-40">
				<DropdownMenuLabel>Theme</DropdownMenuLabel>
				<ThemeRadio value={preference} onChange={setTheme} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function ThemeRadio({
	value,
	onChange,
}: {
	value: ThemePreference;
	onChange: (v: ThemePreference) => void;
}) {
	return (
		<DropdownMenuRadioGroup
			value={value}
			onValueChange={(v) => onChange(v as ThemePreference)}
		>
			<DropdownMenuRadioItem value="light">
				<Sun /> Light
			</DropdownMenuRadioItem>
			<DropdownMenuRadioItem value="dark">
				<Moon /> Dark
			</DropdownMenuRadioItem>
			<DropdownMenuRadioItem value="system">
				<Laptop /> System
			</DropdownMenuRadioItem>
		</DropdownMenuRadioGroup>
	);
}

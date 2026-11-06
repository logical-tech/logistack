import { type GameKind, gameIcon } from "@logistack/contracts";
import { Box, type LucideIcon, Pickaxe } from "lucide-react";
import { brandMark } from "@/components/brand-icon";

/** The brand mark where simple-icons has one; Minecraft gets drawn tools instead of Mojang's logo. */
export function gameMark(game: GameKind): LucideIcon {
	const slug = gameIcon[game];
	if (slug) return brandMark(slug);
	return game === "minecraft-java" ? Pickaxe : Box;
}

/** CSS custom properties without the leading `--`, e.g. `{ background: "#fff" }`. */
export type Tokens = Record<string, string>;

export type ThemeSource = {
	id: string;
	label: string;
	group: string;
	/** `--radius`, shared by both variants. */
	radius?: string;
	light: Tokens;
	dark: Tokens;
};

export type Mode = "light" | "dark";
export const DEFAULT_THEME = "default";

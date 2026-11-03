import {
	File,
	FileArchive,
	FileCode,
	FileImage,
	FileJson,
	FileSpreadsheet,
	FileText,
	FileVideo,
	type LucideIcon,
} from "lucide-react";

export const baseName = (key: string) =>
	key.replace(/\/$/, "").split("/").pop() ?? key;

const ext = (key: string) =>
	key.includes(".") ? (key.split(".").pop()?.toLowerCase() ?? "") : "";

const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif", "svg", "avif"]);
const TEXT = new Set([
	"txt",
	"log",
	"md",
	"csv",
	"json",
	"jsonl",
	"yml",
	"yaml",
	"xml",
	"css",
	"html",
	"js",
	"ts",
	"toml",
	"ini",
	"sql",
]);

/** Images, text and JSON open in the pane; everything else downloads. */
export function previewKind(
	key: string,
	contentType: string | null,
): "image" | "text" | null {
	const t = contentType ?? "";
	if (t.startsWith("image/") || IMAGE.has(ext(key))) return "image";
	if (t.startsWith("text/") || t.includes("json") || TEXT.has(ext(key)))
		return "text";
	return null;
}

const KINDS: [Set<string>, LucideIcon, string][] = [
	[IMAGE, FileImage, "Image"],
	[new Set(["json", "jsonl"]), FileJson, "JSON"],
	[new Set(["csv", "tsv", "xlsx", "parquet"]), FileSpreadsheet, "Table"],
	[new Set(["mp4", "mov", "webm", "mkv"]), FileVideo, "Video"],
	[new Set(["gz", "zip", "tar", "zst", "7z", "bz2"]), FileArchive, "Archive"],
	[
		new Set(["js", "ts", "css", "html", "yml", "yaml", "toml", "sql", "woff2"]),
		FileCode,
		"Code",
	],
	[new Set(["txt", "log", "md"]), FileText, "Text"],
	[new Set(["pdf"]), FileText, "PDF"],
];

/** An icon and a short type word from the extension, for the file list. */
export function fileKind(key: string): { icon: LucideIcon; label: string } {
	const e = ext(baseName(key));
	for (const [set, icon, label] of KINDS)
		if (set.has(e)) return { icon, label };
	return { icon: File, label: e ? e.toUpperCase() : "File" };
}

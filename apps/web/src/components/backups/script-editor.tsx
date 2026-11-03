import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import {
	bracketMatching,
	HighlightStyle,
	indentOnInput,
	StreamLanguage,
	syntaxHighlighting,
} from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { EditorState, type Extension } from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	placeholder,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Colours come from the app's tokens, so light and dark follow the theme without a second style. */
export const editorHighlight = HighlightStyle.define([
	{ tag: t.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
	{ tag: [t.keyword, t.controlKeyword, t.typeName], color: "var(--info-text)" },
	{ tag: [t.string, t.special(t.string)], color: "var(--ok-text)" },
	{
		tag: [t.variableName, t.definition(t.variableName)],
		color: "var(--warn-text)",
	},
	{ tag: [t.number, t.atom, t.bool], color: "var(--bad-text)" },
	{ tag: [t.operator, t.punctuation], color: "var(--muted-foreground)" },
	{ tag: t.meta, color: "var(--muted-foreground)" },
]);

export const editorTheme = EditorView.theme({
	"&": {
		backgroundColor: "var(--card)",
		color: "var(--foreground)",
		fontSize: "13px",
		fontFamily: "var(--font-mono)",
		fontSizeAdjust: "0.47",
		// Mobile font boosting would size the gutter and the text differently.
		textSizeAdjust: "100%",
		WebkitTextSizeAdjust: "100%",
		height: "100%",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		fontFamily: "inherit",
		lineHeight: "1.6",
		padding: "10px 0",
	},
	".cm-content": { padding: "0", caretColor: "var(--brand)" },
	".cm-line": { padding: "0 14px 0 10px" },
	".cm-gutters": {
		backgroundColor: "var(--card)",
		color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
		border: "none",
		borderRight: "1px solid var(--border)",
	},
	".cm-lineNumbers .cm-gutterElement": {
		padding: "0 10px 0 14px",
		minWidth: "2.5ch",
		fontVariantNumeric: "tabular-nums",
	},
	".cm-activeLine": {
		backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
	},
	".cm-activeLineGutter": {
		backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
		color: "var(--foreground)",
	},
	"&.cm-focused .cm-cursor": { borderLeftColor: "var(--brand)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
		{
			backgroundColor:
				"color-mix(in oklch, var(--brand) 24%, transparent) !important",
		},
	".cm-matchingBracket": {
		backgroundColor: "color-mix(in oklch, var(--brand) 16%, transparent)",
		outline: "none",
	},
	".cm-placeholder": { color: "var(--muted-foreground)" },
});

const bash = StreamLanguage.define(shell);

/** Bash (or `language`) with line numbers and history. Tab indents; Escape then Tab leaves the editor. */
export function ScriptEditor({
	id,
	value,
	onChange,
	invalid,
	describedBy,
	className,
	label = "Script",
	language = bash,
	hint = "#!/bin/sh\nset -eu\n",
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	invalid?: boolean;
	describedBy?: string;
	className?: string;
	label?: string;
	language?: Extension;
	hint?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const change = useRef(onChange);
	change.current = onChange;

	// biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; `value` syncs below.
	useEffect(() => {
		if (!host.current) return;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					history(),
					drawSelection(),
					indentOnInput(),
					bracketMatching(),
					highlightActiveLine(),
					language,
					syntaxHighlighting(editorHighlight),
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					placeholder(hint),
					editorTheme,
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						id,
						"aria-label": label,
						"aria-multiline": "true",
						spellcheck: "false",
						autocapitalize: "off",
						autocorrect: "off",
					}),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) change.current(u.state.doc.toString());
					}),
				],
			}),
		});
		view.current = v;
		return () => {
			v.destroy();
			view.current = null;
		};
	}, []);

	useEffect(() => {
		const v = view.current;
		if (!v) return;
		const current = v.state.doc.toString();
		if (current !== value)
			v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
	}, [value]);

	useEffect(() => {
		const el = view.current?.contentDOM;
		if (!el) return;
		if (invalid) el.setAttribute("aria-invalid", "true");
		else el.removeAttribute("aria-invalid");
		if (describedBy) el.setAttribute("aria-describedby", describedBy);
	}, [invalid, describedBy]);

	return (
		<div
			ref={host}
			className={cn(
				"overflow-hidden rounded-lg ring-1 ring-input transition-shadow duration-(--duration-quick) focus-within:ring-2 focus-within:ring-ring",
				invalid && "ring-destructive",
				className,
			)}
		/>
	);
}

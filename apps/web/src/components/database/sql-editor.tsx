import { autocompletion } from "@codemirror/autocomplete";
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import {
	MariaSQL,
	MySQL,
	PostgreSQL,
	type SQLNamespace,
	sql,
} from "@codemirror/lang-sql";
import {
	bracketMatching,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
import {
	Compartment,
	EditorState,
	Prec,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	placeholder,
} from "@codemirror/view";
import type { DatabaseSchema } from "@logistack/contracts";
import { type SqlDialect, splitSql } from "@logistack/core";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import {
	editorHighlight,
	editorTheme,
} from "@/components/backups/script-editor";
import { cn } from "@/lib/utils";

/** The text a run sends, and where it starts in the editor. */
export type RunTarget = { text: string; offset: number };

export type SqlEditorHandle = {
	/** The selection, else the statement at the cursor; with `all`, the whole script. */
	target(all: boolean): RunTarget | null;
	/** Underlines the token at `pos` (an offset in the document); null clears it. */
	markError(pos: number | null): void;
	focus(): void;
};

const setError = StateEffect.define<number | null>();
const errorMark = Decoration.mark({ class: "cm-sql-error" });

const errorField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(marks, tr) {
		// Any edit makes the old position meaningless.
		let next = tr.docChanged ? Decoration.none : marks;
		for (const e of tr.effects) {
			if (!e.is(setError)) continue;
			if (e.value === null) next = Decoration.none;
			else {
				const doc = tr.state.doc.toString();
				const from = Math.min(e.value, Math.max(0, doc.length - 1));
				const token = /^[\w$"'.]+/.exec(doc.slice(from))?.[0].length ?? 1;
				next = Decoration.set([errorMark.range(from, from + token)]);
			}
		}
		return next;
	},
	provide: (f) => EditorView.decorations.from(f),
});

const sqlTheme = EditorView.theme({
	".cm-sql-error": {
		textDecoration: "underline wavy var(--bad)",
		textDecorationSkipInk: "none",
		textUnderlineOffset: "3px",
		backgroundColor: "color-mix(in oklch, var(--bad) 10%, transparent)",
		borderRadius: "2px",
	},
	".cm-tooltip": {
		backgroundColor: "var(--popover)",
		color: "var(--popover-foreground)",
		border: "none",
		borderRadius: "8px",
		boxShadow: "var(--shadow-float)",
		outline: "1px solid var(--border)",
		overflow: "hidden",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul": {
		fontFamily: "var(--font-mono)",
		fontSize: "12.5px",
		maxHeight: "16rem",
		padding: "4px",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
		borderRadius: "5px",
		padding: "3px 8px",
		lineHeight: "1.5",
	},
	".cm-tooltip-autocomplete ul li[aria-selected]": {
		backgroundColor: "color-mix(in oklch, var(--brand) 16%, transparent)",
		color: "var(--foreground)",
	},
	".cm-completionDetail": {
		color: "var(--muted-foreground)",
		fontStyle: "normal",
		marginLeft: "1em",
	},
	".cm-completionMatchedText": {
		textDecoration: "none",
		fontWeight: "600",
	},
});

/** Tables complete in `public` unqualified, everywhere as `schema.table`; columns show their type. */
export function namespaceOf(schema: DatabaseSchema): SQLNamespace {
	return Object.fromEntries(
		schema.schemas.map((s) => [
			s.name,
			Object.fromEntries(
				s.tables.map((t) => [
					t.name,
					{
						self: {
							label: t.name,
							type: t.kind === "table" ? "class" : "interface",
							detail: t.kind.replace("_", " "),
						},
						children: t.columns.map((c) => ({
							label: c.name,
							type: "property",
							detail: c.type,
						})),
					},
				]),
			),
		]),
	);
}

/** Where unqualified names resolve: `public` in Postgres, the connected database in MySQL. */
export const defaultSchema = (s: DatabaseSchema) =>
	s.engine === "postgres" ? "public" : s.database;

/** The statement the cursor is in, or the last one before it. */
function statementAt(
	doc: string,
	pos: number,
	dialect: SqlDialect,
): RunTarget | null {
	const all = splitSql(doc, dialect);
	const hit =
		all.find((s) => s.from <= pos && pos <= s.to) ??
		all.filter((s) => s.to <= pos).at(-1) ??
		all[0];
	return hit ? { text: hit.text, offset: hit.from } : null;
}

/** SQL in the engine's dialect, with schema completion. Mod+Enter runs at the cursor, Shift+Mod+Enter runs all. */
export function SqlEditor({
	ref,
	value,
	onChange,
	schema,
	onRun,
	writes,
	className,
}: {
	ref: Ref<SqlEditorHandle>;
	value: string;
	onChange: (value: string) => void;
	schema: DatabaseSchema;
	onRun: (all: boolean) => void;
	/** Writes are on: the frame says so. */
	writes: boolean;
	className?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const lang = useRef(new Compartment());
	const handlers = useRef({ onChange, onRun });
	handlers.current = { onChange, onRun };

	const language = (s: DatabaseSchema) =>
		sql({
			dialect:
				s.engine === "mysql"
					? MySQL
					: s.engine === "mariadb"
						? MariaSQL
						: PostgreSQL,
			schema: namespaceOf(s),
			defaultSchema: defaultSchema(s),
		});

	// biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; value and schema sync below.
	useEffect(() => {
		if (!host.current) return;
		const run = (all: boolean) => () => {
			handlers.current.onRun(all);
			return true;
		};
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					Prec.highest(
						keymap.of([
							{ key: "Mod-Enter", run: run(false) },
							{ key: "Shift-Mod-Enter", run: run(true) },
						]),
					),
					lineNumbers(),
					highlightActiveLineGutter(),
					history(),
					drawSelection(),
					indentOnInput(),
					bracketMatching(),
					highlightActiveLine(),
					lang.current.of(language(schema)),
					autocompletion({ icons: false }),
					syntaxHighlighting(editorHighlight),
					keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
					placeholder("select * from orders limit 100"),
					errorField,
					editorTheme,
					sqlTheme,
					EditorView.lineWrapping,
					EditorView.contentAttributes.of({
						"aria-label": "SQL",
						"aria-multiline": "true",
						spellcheck: "false",
						autocapitalize: "off",
						autocorrect: "off",
					}),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: `language` only reads `schema`.
	useEffect(() => {
		view.current?.dispatch({
			effects: lang.current.reconfigure(language(schema)),
		});
	}, [schema]);

	useImperativeHandle(
		ref,
		() => ({
			target(all) {
				const v = view.current;
				if (!v) return null;
				const doc = v.state.doc.toString();
				if (all) {
					const text = doc.trim();
					return text ? { text, offset: doc.indexOf(text) } : null;
				}
				const sel = v.state.selection.main;
				if (!sel.empty) {
					const raw = doc.slice(sel.from, sel.to);
					const text = raw.trim();
					return text ? { text, offset: sel.from + raw.indexOf(text) } : null;
				}
				return statementAt(
					doc,
					sel.head,
					schema.engine === "postgres" ? "postgres" : "mysql",
				);
			},
			markError(pos) {
				const v = view.current;
				if (!v) return;
				v.dispatch({
					effects: [
						setError.of(pos),
						...(pos === null
							? []
							: [EditorView.scrollIntoView(pos, { y: "center" })]),
					],
				});
			},
			focus: () => view.current?.focus(),
		}),
		[schema.engine],
	);

	return (
		<div
			ref={host}
			className={cn(
				"min-h-0 overflow-hidden outline-transparent transition-[outline-color] duration-(--duration-quick) [&_.cm-editor]:h-full",
				writes && "outline-1 -outline-offset-1 outline-warn/70",
				className,
			)}
		/>
	);
}

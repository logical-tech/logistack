import type { Cell, DbColumn } from "@logistack/contracts";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { cellText, fromText, isNumeric } from "./cells";

/**
 * Edits one cell in place. Enter or leaving the cell keeps the value, Tab keeps it and moves
 * right, Escape drops it. Nullable columns offer Null, since an empty text is a value.
 */
export function CellEditor({
	column,
	value,
	onCommit,
	onCancel,
}: {
	column: DbColumn;
	value: Cell;
	onCommit: (value: Cell, next?: boolean) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState(cellText(value));
	const result = () =>
		value === null && text === "" ? null : fromText(text, column, value);
	// Enter and Escape unmount the editor, which blurs it; only the first ending counts.
	const settled = useRef(false);
	const settle = (fn: () => void) => {
		if (settled.current) return;
		settled.current = true;
		fn();
	};

	return (
		<div className="absolute inset-0 z-10 flex bg-card ring-2 ring-ring ring-inset">
			<input
				// biome-ignore lint/a11y/noAutofocus: the editor opens because the person asked to type
				autoFocus
				onFocus={(e) => e.currentTarget.select()}
				aria-label={`Edit ${column.name}`}
				value={text}
				placeholder={value === null ? "null" : undefined}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						settle(() => onCommit(result()));
					} else if (e.key === "Tab") {
						e.preventDefault();
						settle(() => onCommit(result(), true));
					} else if (e.key === "Escape") {
						e.preventDefault();
						settle(onCancel);
					}
				}}
				onBlur={() => settle(() => onCommit(result()))}
				className={cn(
					"min-w-0 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground/70 placeholder:italic",
					isNumeric(column.type) && "text-right tabular",
				)}
			/>
			{column.nullable && (
				<button
					type="button"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => settle(() => onCommit(null))}
					className="m-1 shrink-0 rounded px-1.5 text-xs text-muted-foreground italic outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					Set null
				</button>
			)}
		</div>
	);
}

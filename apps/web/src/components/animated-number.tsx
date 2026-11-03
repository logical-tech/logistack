import { type CSSProperties, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Number pop-in: when the value changes, only the digits that differ from the
 * previous value re-enter. The first render is still.
 */
export function AnimatedNumber({
	value,
	className,
}: {
	value: number;
	className?: string;
}) {
	const text = value.toLocaleString("en");
	const state = useRef({ text, version: 0, same: text.length });
	if (state.current.text !== text) {
		const before = state.current.text;
		let same = 0;
		while (
			same < before.length &&
			same < text.length &&
			before[same] === text[same]
		)
			same++;
		state.current = { text, version: state.current.version + 1, same };
	}
	const { version, same } = state.current;

	return (
		<span className={cn("tabular inline-flex", className)}>
			<span className="sr-only">{text}</span>
			{[...text].map((ch, i) => {
				const changed = version > 0 && i >= same;
				return (
					<span
						// Changed digits get a fresh key so the pop-in replays.
						key={changed ? `${i}-${version}` : `${i}`}
						aria-hidden
						className="t-digit"
						data-changed={changed || undefined}
						style={changed ? ({ "--i": i - same } as CSSProperties) : undefined}
					>
						{ch}
					</span>
				);
			})}
		</span>
	);
}

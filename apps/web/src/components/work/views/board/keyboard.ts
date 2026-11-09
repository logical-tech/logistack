import type { KeyboardCoordinateGetter } from "@dnd-kit/core";

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * Arrow keys for a board of several sortable lists: ←/→ jump to the neighbouring
 * column's cell in the same lane, ↑/↓ step over the next card (or into the next lane).
 * Cells have plain ids; cards have `cell|task` ids.
 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (
	event,
	{ context: { active, collisionRect, droppableRects, droppableContainers } },
) => {
	if (!KEYS.includes(event.code)) return undefined;
	event.preventDefault();
	if (!active || !collisionRect) return undefined;
	const cx = collisionRect.left + collisionRect.width / 2;
	const cy = collisionRect.top + collisionRect.height / 2;
	const all = droppableContainers
		.getEnabled()
		.filter((c) => c.id !== active.id)
		.flatMap((c) => {
			const rect = droppableRects.get(c.id);
			return rect ? [{ id: String(c.id), rect }] : [];
		});
	const cells = all.filter((c) => !c.id.includes("|"));
	const cards = all.filter((c) => c.id.includes("|"));
	const centerX = (r: { left: number; width: number }) => r.left + r.width / 2;
	const here = cells.find(
		(c) =>
			cx >= c.rect.left &&
			cx <= c.rect.left + c.rect.width &&
			cy >= c.rect.top &&
			cy <= c.rect.top + c.rect.height,
	);

	if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
		const dir = event.code === "ArrowRight" ? 1 : -1;
		const target = cells
			.filter((c) => (centerX(c.rect) - cx) * dir > 20)
			.sort(
				(a, b) =>
					Math.abs(centerX(a.rect) - cx) - Math.abs(centerX(b.rect) - cx) ||
					Math.abs(a.rect.top - (here?.rect.top ?? cy)) -
						Math.abs(b.rect.top - (here?.rect.top ?? cy)),
			)[0];
		return target
			? { x: target.rect.left + 8, y: target.rect.top + 8 }
			: undefined;
	}
	const dir = event.code === "ArrowDown" ? 1 : -1;
	const sameColumn = (r: { left: number; width: number }) =>
		Math.abs(centerX(r) - cx) < r.width / 2;
	const card = cards
		.filter(
			(c) =>
				sameColumn(c.rect) && (c.rect.top + c.rect.height / 2 - cy) * dir > 4,
		)
		.sort((a, b) => Math.abs(a.rect.top - cy) - Math.abs(b.rect.top - cy))[0];
	if (card) return { x: card.rect.left, y: card.rect.top };
	// Past the last card: the next lane's cell in this column.
	const lane = cells
		.filter(
			(c) =>
				sameColumn(c.rect) &&
				c !== here &&
				(c.rect.top - (here?.rect.top ?? cy)) * dir > 0,
		)
		.sort((a, b) => Math.abs(a.rect.top - cy) - Math.abs(b.rect.top - cy))[0];
	return lane ? { x: lane.rect.left + 8, y: lane.rect.top + 8 } : undefined;
};

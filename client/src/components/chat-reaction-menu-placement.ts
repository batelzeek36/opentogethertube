/** A rectangle in the browser window's coordinates, as getBoundingClientRect gives it. */
export interface MenuBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** How big the menu's buttons want to be. Mouse buttons are smaller than finger buttons. */
export interface MenuSizing {
	maxSlot: number;
	/** Narrower than this, the row breaks in two rather than shrink further. */
	minSlot: number;
	rowHeight: number;
}

export const TOUCH_SIZING: MenuSizing = { maxSlot: 44, minSlot: 32, rowHeight: 32 };
export const MOUSE_SIZING: MenuSizing = { maxSlot: 30, minSlot: 26, rowHeight: 28 };

/** The menu's border and padding, both sides together. */
const MENU_CHROME_PX = 4;
/** How far the menu reaches down onto the message it sits on. */
const SIT_OVERLAP_PX = 8;
const EDGE_GAP_PX = 2;

export interface MenuPlacement {
	left: number;
	top: number;
	/** Width of one button. */
	slot: number;
	rowHeight: number;
	columns: number;
}

function intersect(a: MenuBox, b: MenuBox): MenuBox {
	return {
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.min(a.right, b.right),
		bottom: Math.min(a.bottom, b.bottom),
	};
}

/** Moves a span into [low, high]. A span too big to fit starts at low. */
function fit(start: number, size: number, low: number, high: number): number {
	if (size >= high - low) {
		return low;
	}
	return Math.min(Math.max(start, low), high - size);
}

/**
 * Where a menu of `count` buttons goes so that it sits on the message and stays whole.
 *
 * It keeps inside the visible part of the message list whenever it fits there, so the movie frame,
 * the input and the other controls stay clear. Only a list too small to hold it lets it reach out
 * over the rest of the chat, and it never leaves the viewport.
 */
export function placeReactionMenu(
	count: number,
	sizing: MenuSizing,
	boxes: { message: MenuBox; list: MenuBox; chat: MenuBox; viewport: MenuBox },
): MenuPlacement {
	const list = intersect(boxes.list, boxes.viewport);
	const chat = intersect(boxes.chat, boxes.viewport);
	const roomForButtons = list.right - list.left - EDGE_GAP_PX * 2 - MENU_CHROME_PX;

	const slotFor = (columns: number) => Math.floor(roomForButtons / columns);
	const fitsOneRow = slotFor(count) >= sizing.minSlot;
	const columns = fitsOneRow ? count : Math.ceil(count / 2);
	const slot = Math.max(sizing.minSlot, Math.min(sizing.maxSlot, slotFor(columns)));
	const rows = Math.ceil(count / columns);
	const width = slot * columns + MENU_CHROME_PX;
	const height = sizing.rowHeight * rows + MENU_CHROME_PX;

	const above = boxes.message.top + SIT_OVERLAP_PX - height;
	const below = boxes.message.bottom - SIT_OVERLAP_PX;
	const wanted = above >= list.top || below + height > list.bottom ? above : below;
	const inList = fit(wanted, height, list.top, list.bottom);
	const inChat = fit(inList, height, chat.top, chat.bottom);

	return {
		left: fit(
			fit(boxes.message.left, width, list.left + EDGE_GAP_PX, list.right - EDGE_GAP_PX),
			width,
			boxes.viewport.left + EDGE_GAP_PX,
			boxes.viewport.right - EDGE_GAP_PX,
		),
		top: fit(inChat, height, boxes.viewport.top, boxes.viewport.bottom),
		slot,
		rowHeight: sizing.rowHeight,
		columns,
	};
}

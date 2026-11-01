import { describe, expect, it } from "vitest";
import {
	type MenuBox,
	MOUSE_SIZING,
	placeReactionMenu,
	TOUCH_SIZING,
} from "@/components/chat-reaction-menu-placement";

const box = (left: number, top: number, width: number, height: number): MenuBox => ({
	left,
	top,
	right: left + width,
	bottom: top + height,
});

/** The phone's typing view, upright: 390 wide, a 58px list right under the input. */
const phone = {
	list: box(3, 300, 384, 58),
	chat: box(0, 257, 390, 112),
	viewport: box(0, 0, 390, 400),
};

function sizeOf(placement: ReturnType<typeof placeReactionMenu>, count = 8) {
	const rows = Math.ceil(count / placement.columns);
	return {
		width: placement.slot * placement.columns + 4,
		height: placement.rowHeight * rows + 4,
	};
}

function inside(placement: ReturnType<typeof placeReactionMenu>, outer: MenuBox): boolean {
	const { width, height } = sizeOf(placement);
	return (
		placement.left >= outer.left &&
		placement.top >= outer.top &&
		placement.left + width <= outer.right &&
		placement.top + height <= outer.bottom
	);
}

describe("placeReactionMenu", () => {
	it("gives a finger eight 44px buttons in the 58px list at 390 wide", () => {
		const placement = placeReactionMenu(8, TOUCH_SIZING, {
			...phone,
			message: box(5, 302, 200, 46),
		});
		expect(placement).toMatchObject({ slot: 44, columns: 8 });
		expect(inside(placement, phone.list)).toBe(true);
	});

	it("stays in the short list for the first message and the last", () => {
		for (const top of [270, 302, 340]) {
			const placement = placeReactionMenu(8, TOUCH_SIZING, {
				...phone,
				message: box(5, top, 200, 46),
			});
			expect(inside(placement, phone.list)).toBe(true);
		}
	});

	it("narrows the buttons before breaking the row in a sideways phone's column", () => {
		const list = box(490, 40, 348, 300);
		const placement = placeReactionMenu(8, TOUCH_SIZING, {
			message: box(492, 200, 180, 30),
			list,
			chat: box(487, 0, 354, 390),
			viewport: box(0, 0, 844, 390),
		});
		expect(placement).toMatchObject({ slot: 42, columns: 8 });
		expect(inside(placement, list)).toBe(true);
	});

	it("breaks into two rows of four when the column cannot hold one usable row", () => {
		const list = box(330, 40, 232, 200);
		const placement = placeReactionMenu(8, TOUCH_SIZING, {
			message: box(332, 100, 150, 30),
			list,
			chat: box(326, 0, 240, 320),
			viewport: box(0, 0, 568, 320),
		});
		expect(placement).toMatchObject({ slot: 44, columns: 4 });
		expect(inside(placement, list)).toBe(true);
	});

	it("sits on the top edge of a message with room above it", () => {
		const message = box(20, 400, 200, 32);
		const placement = placeReactionMenu(8, MOUSE_SIZING, {
			message,
			list: box(10, 100, 380, 500),
			chat: box(0, 60, 400, 600),
			viewport: box(0, 0, 1280, 800),
		});
		const { height } = sizeOf(placement);
		expect(placement.top).toBeLessThan(message.top);
		expect(placement.top + height).toBeGreaterThan(message.top);
		expect(placement.left).toBe(message.left);
	});

	it("sits on the bottom edge of the top message, so it hides less of it", () => {
		const message = box(20, 100, 200, 32);
		const placement = placeReactionMenu(8, MOUSE_SIZING, {
			message,
			list: box(10, 100, 380, 500),
			chat: box(0, 60, 400, 600),
			viewport: box(0, 0, 1280, 800),
		});
		expect(placement.top).toBeLessThan(message.bottom);
		expect(placement.top).toBeGreaterThan(message.top);
	});

	it("stays inside the right edge however far along the message starts", () => {
		const list = box(10, 100, 380, 500);
		const placement = placeReactionMenu(8, MOUSE_SIZING, {
			message: box(350, 300, 40, 32),
			list,
			chat: box(0, 60, 400, 600),
			viewport: box(0, 0, 1280, 800),
		});
		expect(inside(placement, list)).toBe(true);
	});

	it("reaches over the rest of the chat only when the list cannot hold it", () => {
		const chat = box(0, 257, 390, 112);
		const placement = placeReactionMenu(8, TOUCH_SIZING, {
			message: box(5, 340, 200, 20),
			list: box(3, 340, 384, 20),
			chat,
			viewport: box(0, 0, 390, 400),
		});
		expect(inside(placement, chat)).toBe(true);
	});

	it("never leaves the viewport, even when the chat runs past it", () => {
		const viewport = box(0, 0, 390, 330);
		const placement = placeReactionMenu(8, TOUCH_SIZING, {
			message: box(5, 320, 200, 46),
			list: box(3, 300, 384, 58),
			chat: box(0, 257, 390, 112),
			viewport,
		});
		expect(inside(placement, viewport)).toBe(true);
	});
});

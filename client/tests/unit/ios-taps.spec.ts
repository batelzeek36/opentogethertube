import { afterEach, describe, expect, it, vi } from "vitest";
import { iosTapFilter, staysOnScreen } from "@/components/composables/ios-taps";

function addTo(parent: HTMLElement, attribute?: string) {
	const el = document.createElement("div");
	if (attribute) {
		el.setAttribute(attribute, "");
	}
	parent.append(el);
	return el;
}

/** Runs the filter the way useMouse does: from inside a listener, on the event being dispatched. */
function touchReachesTheWatcher(target: HTMLElement) {
	const invoke = vi.fn();
	const listener = () => iosTapFilter(invoke, { fn: invoke, args: [], thisArg: undefined });
	window.addEventListener("touchstart", listener);
	target.dispatchEvent(new Event("touchstart", { bubbles: true }));
	window.removeEventListener("touchstart", listener);
	return invoke.mock.calls.length > 0;
}

describe("ios taps", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it.each(["data-stays-on-screen", "data-movie-only-keep", "data-reka-popper-content-wrapper"])(
		"counts what is inside [%s] as still on screen",
		attribute => {
			const button = addTo(addTo(document.body, attribute));
			expect(staysOnScreen(button)).toBe(true);
		},
	);

	it("counts an open dialog as still on screen", () => {
		const dialog = addTo(document.body);
		dialog.setAttribute("role", "dialog");
		expect(staysOnScreen(addTo(dialog))).toBe(true);
	});

	it("counts the video and the rest of the player as hidden with the controls", () => {
		expect(staysOnScreen(addTo(document.body))).toBe(false);
	});

	it("copes with events that have no element behind them", () => {
		expect(staysOnScreen(document)).toBe(false);
		expect(staysOnScreen(null)).toBe(false);
		expect(staysOnScreen(undefined)).toBe(false);
	});

	it("lets the controls hear a touch on the player", () => {
		expect(touchReachesTheWatcher(addTo(document.body))).toBe(true);
	});

	// Showing them would make iOS drop the tap, so the chat button would need two.
	it("keeps a touch on the chat from the controls", () => {
		const chat = addTo(document.body, "data-stays-on-screen");
		expect(touchReachesTheWatcher(addTo(chat))).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import { PlaybackToggleGate, SAME_PRESS_MS } from "@/util/playback-toggle";

function gateAt(times: number[]) {
	let i = 0;
	return new PlaybackToggleGate(() => times[i++]);
}

describe("PlaybackToggleGate", () => {
	it("lets the first press through", () => {
		expect(gateAt([1000]).admit()).toBe(true);
	});

	it("treats a second report of the same press as the same press", () => {
		// Space on the keyboard shortcut (keydown) and the focused play button's own activation
		// (keyup) arrive tens of milliseconds apart: 2026-11-26 the room got play then pause.
		const gate = gateAt([1000, 1080]);
		expect(gate.admit()).toBe(true);
		expect(gate.admit()).toBe(false);
	});

	it("still drops a report just inside the window", () => {
		const gate = gateAt([1000, 1000 + SAME_PRESS_MS - 1]);
		gate.admit();
		expect(gate.admit()).toBe(false);
	});

	it("lets a real second press through once the window has passed", () => {
		const gate = gateAt([1000, 1000 + SAME_PRESS_MS]);
		expect(gate.admit()).toBe(true);
		expect(gate.admit()).toBe(true);
	});

	it("measures the window from the last press that went through, not from dropped ones", () => {
		const gate = gateAt([1000, 1300, 1000 + SAME_PRESS_MS + 10]);
		expect(gate.admit()).toBe(true);
		expect(gate.admit()).toBe(false);
		expect(gate.admit()).toBe(true);
	});
});

describe("mediaSessionAction", () => {
	it("maps the system play key to play only when the room is paused", async () => {
		const { mediaSessionAction } = await import("@/util/playback-toggle");
		expect(mediaSessionAction("play", false)).toBe("play");
		expect(mediaSessionAction("play", true)).toBe(null);
	});

	it("maps the system pause key to pause only when the room is playing", async () => {
		const { mediaSessionAction } = await import("@/util/playback-toggle");
		expect(mediaSessionAction("pause", true)).toBe("pause");
		expect(mediaSessionAction("pause", false)).toBe(null);
	});
});

describe("releaseFocusedButton", () => {
	it("drops focus from a focused button so its Space keyup cannot press it again", async () => {
		const { releaseFocusedButton } = await import("@/util/playback-toggle");
		const button = document.createElement("button");
		document.body.appendChild(button);
		button.focus();
		expect(document.activeElement).toBe(button);
		releaseFocusedButton();
		expect(document.activeElement).not.toBe(button);
		button.remove();
	});

	it("drops focus from an icon inside a button too", async () => {
		const { releaseFocusedButton } = await import("@/util/playback-toggle");
		const button = document.createElement("div");
		button.setAttribute("role", "button");
		button.tabIndex = 0;
		document.body.appendChild(button);
		button.focus();
		releaseFocusedButton();
		expect(document.activeElement).not.toBe(button);
		button.remove();
	});

	it("leaves a focused text field alone", async () => {
		const { releaseFocusedButton } = await import("@/util/playback-toggle");
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		releaseFocusedButton();
		expect(document.activeElement).toBe(input);
		input.remove();
	});
});

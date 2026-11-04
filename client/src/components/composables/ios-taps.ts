import type { EventFilter } from "@vueuse/core";

/**
 * Whatever a viewer can still see and tap while the room's controls are hidden: the chat, toasts,
 * the play button when the browser blocks playback, an open menu or dialog, and Movie only's layers.
 */
const STAYS_ON_SCREEN = [
	"[data-stays-on-screen]",
	"[data-movie-only-keep]",
	"[data-reka-popper-content-wrapper]",
	'[role="dialog"]',
].join();

export function staysOnScreen(target: EventTarget | null | undefined): boolean {
	return target instanceof Element && target.closest(STAYS_ON_SCREEN) !== null;
}

/**
 * iOS drops a tap's click when the touch makes something tappable appear: it reads that as a hover
 * menu opening, there to be looked at first. The room brings its controls back on any touch, so a
 * tap on something already on screen, like the chat button, would only bring them back and have to
 * be made again. So those touches, and the mouse events iOS makes from them, go unnoticed.
 *
 * A tap on a control that is hidden keeps that behavior on purpose: it shows the controls, and
 * pressing one takes a second tap.
 */
export const iosTapFilter: EventFilter = invoke => {
	if (!staysOnScreen(window.event?.target)) {
		return invoke();
	}
};

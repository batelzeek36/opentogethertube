/**
 * One press of play/pause must flip the room once.
 *
 * Several input paths can report the same press: the Space/K shortcut fires on keydown, a play
 * button that still has focus from an earlier click activates itself on the Space keyup, and the
 * operating system's media keys (or a TV remote over AirPlay) arrive through the Media Session API.
 * Each path used to toggle on its own, so a single press sent play and then pause a moment later
 * (seen live 2026-11-26: the owner's client sent play/pause pairs under a second apart, twice).
 * Every toggle now asks one shared gate first; a report inside the window is the same press.
 */

/** Reports of one press arrive well inside this; two real presses by a person are further apart. */
export const SAME_PRESS_MS = 400;

export class PlaybackToggleGate {
	private lastAdmitted = Number.NEGATIVE_INFINITY;

	constructor(private readonly now: () => number = () => performance.now()) {}

	/** True when this request is a new press and should change playback. */
	admit(): boolean {
		const t = this.now();
		if (t - this.lastAdmitted < SAME_PRESS_MS) {
			return false;
		}
		this.lastAdmitted = t;
		return true;
	}
}

/** Shared by every control in the page (keyboard shortcuts, the play button, media keys). */
export const playbackToggleGate = new PlaybackToggleGate();

/**
 * The Media Session API says which key was pressed; honour it instead of toggling, so a "play"
 * from the system never pauses a room that is already playing.
 */
export function mediaSessionAction(
	key: "play" | "pause",
	roomIsPlaying: boolean,
): "play" | "pause" | null {
	if (key === "play") {
		return roomIsPlaying ? null : "play";
	}
	return roomIsPlaying ? "pause" : null;
}

/**
 * Space on a focused button activates that button on keyup. When the Space shortcut has already
 * handled the press on keydown, drop focus so the keyup cannot press the button a second time.
 */
export function releaseFocusedButton(doc: Document = document): void {
	const active = doc.activeElement;
	if (active instanceof HTMLElement && active.closest("button, [role='button']")) {
		active.blur();
	}
}

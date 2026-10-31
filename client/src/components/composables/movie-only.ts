import { onMounted, onUnmounted, ref } from "vue";

/** How long the Show controls button stays up after a tap. */
export const SHOW_CONTROLS_MS = 4000;
/** A press this soon after the button appears is the second half of a double tap, not a choice. */
export const SHOW_CONTROLS_ARM_MS = 300;
/** Long enough to learn whether the page went to the background along with leaving fullscreen. */
export const FULLSCREEN_LEAVE_GRACE_MS = 300;
const RECENTLY_HIDDEN_MS = 1500;
/** The page regrows over a few frames after fullscreen, so its old scroll position is set again. */
const SCROLL_RESTORE_DELAYS_MS = [0, 100, 300];

/** True while this device shows the movie and nothing else. Never sent to anyone. */
export const movieOnlyActive = ref(false);

export interface MovieOnlyOptions {
	/** True where the room itself enters fullscreen sideways and leaves it upright. */
	followsRotation: () => boolean;
}

function isLandscape() {
	return window.matchMedia?.("(orientation: landscape)").matches ?? false;
}

/**
 * Movie only: for someone mirroring their phone to a TV. The room keeps playing and syncing
 * underneath; this owns everything about the mode except how it looks, which is the
 * `html.movie-only` style in Room.vue. It holds up without fullscreen or a wake lock, because some
 * browsers offer neither.
 */
export function useMovieOnly(options: MovieOnlyOptions) {
	const revealed = ref(false);
	/** The button was brought up from a keyboard, so it should take focus. */
	const revealedByKey = ref(false);

	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let leaveTimer: ReturnType<typeof setTimeout> | null = null;
	let revealedAt = 0;
	let lastHiddenAt = Number.NEGATIVE_INFINITY;
	let scrollX = 0;
	let scrollY = 0;
	let wasFullscreen = false;
	let holdingFullscreen = false;
	let lostFullscreen = false;
	let wakeLock: WakeLockSentinel | null = null;
	let acquiringWakeLock = false;
	let themeColor: HTMLMetaElement | null = null;

	async function acquireWakeLock() {
		if (!navigator.wakeLock || wakeLock || acquiringWakeLock) {
			return;
		}
		acquiringWakeLock = true;
		try {
			const sentinel = await navigator.wakeLock.request("screen");
			if (!movieOnlyActive.value) {
				await sentinel.release();
				return;
			}
			wakeLock = sentinel;
			sentinel.addEventListener("release", () => {
				if (wakeLock === sentinel) {
					wakeLock = null;
				}
			});
		} catch {
			// Refused or unsupported: the movie plays on, the phone may just sleep on its own timer.
		} finally {
			acquiringWakeLock = false;
		}
	}

	function releaseWakeLock() {
		const sentinel = wakeLock;
		wakeLock = null;
		sentinel?.release().catch(() => {
			// Already released by the browser.
		});
	}

	function requestFullscreen() {
		const root = document.documentElement;
		if (!document.fullscreenEnabled || typeof root.requestFullscreen !== "function") {
			return;
		}
		root.requestFullscreen({ navigationUI: "hide" }).catch(() => {
			// Refused: the mode still fills the page.
		});
	}

	/** Colors what remains of the browser's own bar when fullscreen is not on offer. */
	function setBlackBrowserBar(on: boolean) {
		if (on) {
			themeColor = document.createElement("meta");
			themeColor.name = "theme-color";
			themeColor.content = "#000000";
			document.head.appendChild(themeColor);
		} else {
			themeColor?.remove();
			themeColor = null;
		}
	}

	function clearTimers() {
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		if (leaveTimer) {
			clearTimeout(leaveTimer);
			leaveTimer = null;
		}
	}

	function enter() {
		if (movieOnlyActive.value) {
			return;
		}
		scrollX = window.scrollX;
		scrollY = window.scrollY;
		wasFullscreen = !!document.fullscreenElement;
		holdingFullscreen = wasFullscreen;
		lostFullscreen = false;
		movieOnlyActive.value = true;
		document.documentElement.classList.add("movie-only");
		setBlackBrowserBar(true);
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
		if (!wasFullscreen) {
			requestFullscreen();
		}
		acquireWakeLock();
	}

	function restoreScroll() {
		if (!movieOnlyActive.value) {
			window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
		}
	}

	async function exit() {
		if (!movieOnlyActive.value) {
			return;
		}
		clearTimers();
		movieOnlyActive.value = false;
		revealed.value = false;
		revealedByKey.value = false;
		document.documentElement.classList.remove("movie-only");
		setBlackBrowserBar(false);
		releaseWakeLock();

		const keepFullscreen = options.followsRotation() ? isLandscape() : wasFullscreen;
		if (document.fullscreenElement && !keepFullscreen) {
			try {
				await document.exitFullscreen();
			} catch {
				// Already on its way out.
			}
		}
		restoreScroll();
		for (const delay of SCROLL_RESTORE_DELAYS_MS) {
			setTimeout(restoreScroll, delay);
		}
	}

	function reveal(byKey = false) {
		if (!revealed.value) {
			revealedAt = Date.now();
		}
		revealed.value = true;
		revealedByKey.value = byKey;
		if (hideTimer) {
			clearTimeout(hideTimer);
		}
		hideTimer = setTimeout(() => {
			hideTimer = null;
			revealed.value = false;
			revealedByKey.value = false;
		}, SHOW_CONTROLS_MS);
	}

	function onTap() {
		if (lostFullscreen) {
			lostFullscreen = false;
			requestFullscreen();
		}
		reveal();
	}

	function onShowControlsPressed() {
		if (Date.now() - revealedAt >= SHOW_CONTROLS_ARM_MS) {
			exit();
		}
	}

	function onFullscreenChange() {
		if (!movieOnlyActive.value) {
			return;
		}
		if (document.fullscreenElement) {
			holdingFullscreen = true;
			lostFullscreen = false;
			return;
		}
		if (!holdingFullscreen) {
			return;
		}
		holdingFullscreen = false;
		// Back and Esc leave fullscreen with the page still on screen, and they mean "get me out".
		// Android also leaves fullscreen when the phone goes to another app, and that means nothing.
		leaveTimer = setTimeout(() => {
			leaveTimer = null;
			const wentAway =
				document.visibilityState !== "visible" ||
				Date.now() - lastHiddenAt < RECENTLY_HIDDEN_MS;
			if (wentAway) {
				lostFullscreen = true;
			} else {
				exit();
			}
		}, FULLSCREEN_LEAVE_GRACE_MS);
	}

	function onVisibilityChange() {
		if (document.visibilityState !== "visible") {
			lastHiddenAt = Date.now();
		} else if (movieOnlyActive.value) {
			// The browser drops the lock whenever the page is hidden.
			acquireWakeLock();
		}
	}

	/** Keeps the room's shortcuts (chat, play, fullscreen) from acting on a page that isn't showing. */
	function onKeyDownCapture(e: KeyboardEvent) {
		if (!movieOnlyActive.value || e.ctrlKey || e.metaKey || e.altKey) {
			return;
		}
		e.stopImmediatePropagation();
		if (e.key === "Escape") {
			e.preventDefault();
			exit();
			return;
		}
		// Once the button holds focus, the key is left alone so that Enter or Space can press it.
		if (!(revealed.value && revealedByKey.value)) {
			e.preventDefault();
		}
		reveal(true);
	}

	onMounted(() => {
		window.addEventListener("keydown", onKeyDownCapture, { capture: true });
		document.addEventListener("fullscreenchange", onFullscreenChange);
		document.addEventListener("visibilitychange", onVisibilityChange);
	});

	onUnmounted(() => {
		window.removeEventListener("keydown", onKeyDownCapture, { capture: true });
		document.removeEventListener("fullscreenchange", onFullscreenChange);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		exit();
	});

	return {
		active: movieOnlyActive,
		revealed,
		revealedByKey,
		enter,
		exit,
		onTap,
		onShowControlsPressed,
	};
}

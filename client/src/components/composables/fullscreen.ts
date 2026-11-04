import { ref } from "vue";
import { useStore } from "@/store";

/** On `<html>` while the room fills the page in place of the browser's own fullscreen. */
export const PAGE_FULLSCREEN_CLASS = "page-fullscreen";
/** The page regrows over a few frames after leaving, so its old scroll position is set again. */
const SCROLL_RESTORE_DELAYS_MS = [0, 100, 300];

/**
 * True while the room fills the page by itself, because the browser has no fullscreen for a page or
 * refused it. An iPhone is the case in point: there only a lone video can go fullscreen, in Apple's
 * own player, which would hide the chat and the reactions. Never sent to anyone.
 */
export const pageFullscreenActive = ref(false);

/** The part of the store this needs, so that tests can hand in a stand-in. */
export interface FullscreenStore {
	commit(type: "SET_FULLSCREEN", payload: boolean): void;
}

/** Whether the browser can put the whole page in fullscreen. False on an iPhone. */
export function elementFullscreenAvailable(): boolean {
	return (
		!!document.fullscreenEnabled &&
		typeof document.documentElement.requestFullscreen === "function"
	);
}

/** Either kind of fullscreen: the browser's own, or the room filling the page. */
export function isFullscreen(): boolean {
	return !!document.fullscreenElement || pageFullscreenActive.value;
}

let owner: FullscreenStore | null = null;
let themeColor: HTMLMetaElement | null = null;
let scrollX = 0;
let scrollY = 0;

/** Chat and its menus take Esc first to close themselves; only an Esc left alone gets out. */
function onKeyDown(e: KeyboardEvent) {
	if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) {
		return;
	}
	exitPageFullscreen();
}

function restoreScroll() {
	if (!pageFullscreenActive.value) {
		window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
	}
}

export function enterPageFullscreen(store: FullscreenStore) {
	if (pageFullscreenActive.value) {
		return;
	}
	scrollX = window.scrollX;
	scrollY = window.scrollY;
	owner = store;
	pageFullscreenActive.value = true;
	document.documentElement.classList.add(PAGE_FULLSCREEN_CLASS);
	// Colors what remains of the browser's own bars to match the black around the movie.
	themeColor = document.createElement("meta");
	themeColor.name = "theme-color";
	themeColor.content = "#000000";
	document.head.appendChild(themeColor);
	window.addEventListener("keydown", onKeyDown);
	store.commit("SET_FULLSCREEN", true);
}

export function exitPageFullscreen() {
	if (!pageFullscreenActive.value) {
		return;
	}
	pageFullscreenActive.value = false;
	document.documentElement.classList.remove(PAGE_FULLSCREEN_CLASS);
	themeColor?.remove();
	themeColor = null;
	window.removeEventListener("keydown", onKeyDown);
	owner?.commit("SET_FULLSCREEN", isFullscreen());
	owner = null;
	restoreScroll();
	for (const delay of SCROLL_RESTORE_DELAYS_MS) {
		setTimeout(restoreScroll, delay);
	}
}

/**
 * The room's fullscreen. Where the browser can put the page in fullscreen (computers, Android, iPad)
 * it does exactly that. Where it can't (iPhone, some in-app browsers) or refuses, the room fills the
 * visible screen itself with the same fullscreen layout, so the chat and the reactions stay on it.
 */
export function useFullscreen(store: FullscreenStore = useStore()) {
	/** Returns which kind of fullscreen it went for. */
	function enter(): "element" | "page" {
		if (!elementFullscreenAvailable()) {
			enterPageFullscreen(store);
			return "page";
		}
		document.documentElement.requestFullscreen().catch(() => {
			// Refused, as inside a frame that doesn't allow it: the room fills the page instead.
			if (!document.fullscreenElement) {
				enterPageFullscreen(store);
			}
		});
		return "element";
	}

	function exit() {
		exitPageFullscreen();
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(() => {
				// Already on its way out.
			});
		}
	}

	function toggle(): "element" | "page" | "off" {
		if (isFullscreen()) {
			exit();
			return "off";
		}
		return enter();
	}

	return {
		enter,
		enterPage: () => enterPageFullscreen(store),
		exit,
		toggle,
	};
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PAGE_FULLSCREEN_CLASS,
	exitPageFullscreen,
	isFullscreen,
	pageFullscreenActive,
	useFullscreen,
} from "@/components/composables/fullscreen";
import LayoutSwitcher from "@/components/controls/LayoutSwitcher.vue";
import { buildNewStore } from "@/store";
import { mountComponent } from "./component-test-utils";

const root = document.documentElement;
let fullscreenElement: Element | null;
let fullscreenEnabled: boolean | undefined;
let requestFullscreen: ReturnType<typeof vi.fn> | undefined;
let exitFullscreen: ReturnType<typeof vi.fn> | undefined;
let orientationLock: ReturnType<typeof vi.fn>;
let narrowScreen: boolean;

/** An iPhone: no fullscreen for a page at all, only for a lone video. */
function likeAnIphone() {
	fullscreenEnabled = undefined;
	requestFullscreen = undefined;
	exitFullscreen = undefined;
	defineApis();
}

function defineApis() {
	Object.defineProperty(document, "fullscreenEnabled", {
		configurable: true,
		get: () => fullscreenEnabled,
	});
	Object.defineProperty(document, "exitFullscreen", {
		configurable: true,
		value: exitFullscreen,
	});
	Object.defineProperty(root, "requestFullscreen", {
		configurable: true,
		value: requestFullscreen,
	});
}

function themeColor() {
	return document.head.querySelector('meta[name="theme-color"]');
}

function press(key: string, init: KeyboardEventInit = {}, prevented = false) {
	const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
	if (prevented) {
		event.preventDefault();
	}
	document.body.dispatchEvent(event);
}

beforeEach(() => {
	vi.useFakeTimers();
	fullscreenElement = null;
	fullscreenEnabled = true;
	narrowScreen = false;
	requestFullscreen = vi.fn(() => {
		fullscreenElement = root;
		document.dispatchEvent(new Event("fullscreenchange"));
		return Promise.resolve();
	});
	exitFullscreen = vi.fn(() => {
		fullscreenElement = null;
		document.dispatchEvent(new Event("fullscreenchange"));
		return Promise.resolve();
	});
	Object.defineProperty(document, "fullscreenElement", {
		configurable: true,
		get: () => fullscreenElement,
	});
	defineApis();
	orientationLock = vi.fn(() => Promise.resolve());
	Object.defineProperty(screen, "orientation", {
		configurable: true,
		value: { lock: orientationLock, unlock: vi.fn() },
	});
	vi.stubGlobal("matchMedia", () => ({ matches: narrowScreen }));
	window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
	exitPageFullscreen();
	vi.runAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("fullscreen where the browser offers none (iPhone)", () => {
	it("fills the page with the room's fullscreen layout", () => {
		likeAnIphone();
		const store = buildNewStore();
		const fullscreen = useFullscreen(store);
		expect(fullscreen.toggle()).toBe("page");
		expect(pageFullscreenActive.value).toBe(true);
		expect(store.state.fullscreen).toBe(true);
		expect(root.classList.contains(PAGE_FULLSCREEN_CLASS)).toBe(true);
		expect(themeColor()?.getAttribute("content")).toBe("#000000");
		expect(isFullscreen()).toBe(true);
	});

	it("leaves with the same button and puts the page back where it was", () => {
		likeAnIphone();
		Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
		const store = buildNewStore();
		const fullscreen = useFullscreen(store);
		fullscreen.toggle();
		Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
		expect(fullscreen.toggle()).toBe("off");
		vi.runAllTimers();
		expect(pageFullscreenActive.value).toBe(false);
		expect(store.state.fullscreen).toBe(false);
		expect(root.classList.contains(PAGE_FULLSCREEN_CLASS)).toBe(false);
		expect(themeColor()).toBeNull();
		expect(window.scrollTo).toHaveBeenLastCalledWith({
			left: 0,
			top: 300,
			behavior: "instant",
		});
	});

	it("leaves with Esc", () => {
		likeAnIphone();
		const store = buildNewStore();
		useFullscreen(store).enter();
		press("Escape");
		expect(pageFullscreenActive.value).toBe(false);
		expect(store.state.fullscreen).toBe(false);
	});

	it("lets the chat take Esc first to close itself", () => {
		likeAnIphone();
		const store = buildNewStore();
		useFullscreen(store).enter();
		press("Escape", {}, true);
		press("Escape", { ctrlKey: true });
		press("f");
		expect(pageFullscreenActive.value).toBe(true);
		expect(store.state.fullscreen).toBe(true);
	});

	it("stops listening for Esc once it is off", () => {
		likeAnIphone();
		const store = buildNewStore();
		const fullscreen = useFullscreen(store);
		fullscreen.enter();
		fullscreen.exit();
		const commit = vi.spyOn(store, "commit");
		press("Escape");
		expect(commit).not.toHaveBeenCalled();
	});

	it("does the same where fullscreen exists but is switched off", () => {
		fullscreenEnabled = false;
		const store = buildNewStore();
		expect(useFullscreen(store).enter()).toBe("page");
		expect(requestFullscreen).not.toHaveBeenCalled();
		expect(store.state.fullscreen).toBe(true);
	});
});

describe("fullscreen where the browser offers it (computer, Android, iPad)", () => {
	it("asks the browser and does not fill the page itself", async () => {
		const store = buildNewStore();
		const fullscreen = useFullscreen(store);
		expect(fullscreen.toggle()).toBe("element");
		await Promise.resolve();
		expect(requestFullscreen).toHaveBeenCalledOnce();
		expect(pageFullscreenActive.value).toBe(false);
		expect(root.classList.contains(PAGE_FULLSCREEN_CLASS)).toBe(false);
	});

	it("leaves the browser's fullscreen with the same button", () => {
		fullscreenElement = root;
		const fullscreen = useFullscreen(buildNewStore());
		expect(fullscreen.toggle()).toBe("off");
		expect(exitFullscreen).toHaveBeenCalledOnce();
	});

	it("fills the page instead when the browser refuses", async () => {
		requestFullscreen?.mockImplementation(() => Promise.reject(new TypeError("refused")));
		const store = buildNewStore();
		useFullscreen(store).enter();
		await vi.advanceTimersByTimeAsync(0);
		expect(pageFullscreenActive.value).toBe(true);
		expect(store.state.fullscreen).toBe(true);
	});

	it("keeps the room's fullscreen layout while either kind is on", () => {
		likeAnIphone();
		const store = buildNewStore();
		useFullscreen(store).enter();
		fullscreenElement = root;
		exitPageFullscreen();
		expect(store.state.fullscreen).toBe(true);
	});
});

describe("LayoutSwitcher's fullscreen button", () => {
	function button(wrapper: ReturnType<typeof mountComponent>["wrapper"]) {
		return wrapper
			.findAll("button")
			.find(b => b.attributes("aria-label") === "Toggle fullscreen");
	}

	it("turns the room's fullscreen on and off on an iPhone", async () => {
		likeAnIphone();
		narrowScreen = true;
		const { wrapper, store } = mountComponent(LayoutSwitcher);
		const toggle = button(wrapper);
		expect(toggle).toBeDefined();
		await toggle?.trigger("click");
		expect(store.state.fullscreen).toBe(true);
		expect(pageFullscreenActive.value).toBe(true);
		// Turning an iPhone by script isn't possible, and a refusal would only make noise.
		expect(orientationLock).not.toHaveBeenCalled();
		await toggle?.trigger("click");
		expect(store.state.fullscreen).toBe(false);
		expect(pageFullscreenActive.value).toBe(false);
	});

	it("still asks an Android phone to turn sideways", async () => {
		narrowScreen = true;
		const { wrapper } = mountComponent(LayoutSwitcher);
		await button(wrapper)?.trigger("click");
		expect(requestFullscreen).toHaveBeenCalledOnce();
		expect(orientationLock).toHaveBeenCalledWith("landscape");
	});
});

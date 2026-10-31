import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import {
	FULLSCREEN_LEAVE_GRACE_MS,
	SHOW_CONTROLS_ARM_MS,
	SHOW_CONTROLS_MS,
	movieOnlyActive,
	useMovieOnly,
} from "@/components/composables/movie-only";
import MovieOnlyButton from "@/components/MovieOnlyButton.vue";
import MovieOnlyLayer from "@/components/MovieOnlyLayer.vue";
import Chat from "@/components/Chat.vue";
import { PlayerStatus, Role } from "ott-common/models/types";
import { OttSfx } from "@/plugins/sfx";
import { mountComponent } from "./component-test-utils";

interface FakeSentinel {
	release: ReturnType<typeof vi.fn>;
	addEventListener: ReturnType<typeof vi.fn>;
}

const root = document.documentElement;
let fullscreenElement: Element | null;
let fullscreenEnabled: boolean;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;
let wakeLockRequest: ReturnType<typeof vi.fn>;
let sentinels: FakeSentinel[];
let visibility: DocumentVisibilityState;
let landscape: boolean;
let mounted: VueWrapper[];

function setVisibility(value: DocumentVisibilityState) {
	visibility = value;
	document.dispatchEvent(new Event("visibilitychange"));
}

function setFullscreen(on: boolean) {
	fullscreenElement = on ? root : null;
	document.dispatchEvent(new Event("fullscreenchange"));
}

function setup(followsRotation = false) {
	let result!: ReturnType<typeof useMovieOnly>;
	const wrapper = mount(
		defineComponent({
			setup() {
				result = useMovieOnly({ followsRotation: () => followsRotation });
				return () => h("div");
			},
		}),
	);
	mounted.push(wrapper);
	return result;
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	mounted = [];
	fullscreenElement = null;
	fullscreenEnabled = true;
	visibility = "visible";
	landscape = false;
	sentinels = [];
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
	wakeLockRequest = vi.fn(() => {
		const sentinel: FakeSentinel = {
			release: vi.fn(() => Promise.resolve()),
			addEventListener: vi.fn(),
		};
		sentinels.push(sentinel);
		return Promise.resolve(sentinel);
	});
	Object.defineProperty(document, "fullscreenElement", {
		configurable: true,
		get: () => fullscreenElement,
	});
	Object.defineProperty(document, "fullscreenEnabled", {
		configurable: true,
		get: () => fullscreenEnabled,
	});
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
	Object.defineProperty(document, "exitFullscreen", {
		configurable: true,
		value: exitFullscreen,
	});
	Object.defineProperty(root, "requestFullscreen", {
		configurable: true,
		value: requestFullscreen,
	});
	Object.defineProperty(navigator, "wakeLock", {
		configurable: true,
		value: { request: wakeLockRequest },
	});
	vi.stubGlobal("matchMedia", () => ({ matches: landscape }));
	window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
	for (const wrapper of mounted) {
		wrapper.unmount();
	}
	vi.useRealTimers();
	vi.unstubAllGlobals();
	movieOnlyActive.value = false;
});

describe("entering Movie only", () => {
	it("asks for fullscreen without browser chrome and a screen lock", async () => {
		const { enter, active } = setup();
		enter();
		await settle();
		expect(active.value).toBe(true);
		expect(root.classList.contains("movie-only")).toBe(true);
		expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
		expect(wakeLockRequest).toHaveBeenCalledWith("screen");
	});

	it("still turns on when fullscreen is refused", async () => {
		requestFullscreen.mockImplementation(() => Promise.reject(new TypeError("refused")));
		const { enter, active } = setup();
		enter();
		await settle();
		expect(active.value).toBe(true);
		expect(root.classList.contains("movie-only")).toBe(true);
	});

	it("still turns on where fullscreen and the wake lock don't exist", async () => {
		fullscreenEnabled = false;
		Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
		const { enter, active, exit } = setup();
		enter();
		await settle();
		expect(active.value).toBe(true);
		expect(requestFullscreen).not.toHaveBeenCalled();
		await exit();
		expect(active.value).toBe(false);
	});

	it("carries on silently when the wake lock is refused", async () => {
		wakeLockRequest.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
		const { enter, active } = setup();
		enter();
		await settle();
		expect(active.value).toBe(true);
	});

	it("doesn't ask for fullscreen again when already in it, as after rotating", async () => {
		fullscreenElement = root;
		const { enter } = setup();
		enter();
		await settle();
		expect(requestFullscreen).not.toHaveBeenCalled();
	});

	it("colors the browser's bar black only while on", async () => {
		const { enter, exit } = setup();
		const bar = () => document.head.querySelector('meta[name="theme-color"]');
		expect(bar()).toBeNull();
		enter();
		expect(bar()?.getAttribute("content")).toBe("#000000");
		await exit();
		expect(bar()).toBeNull();
	});
});

describe("leaving Movie only", () => {
	it("puts back the scroll position, the page and the screen lock", async () => {
		Object.defineProperty(window, "scrollY", { configurable: true, value: 240 });
		const { enter, exit, active } = setup();
		enter();
		await settle();
		Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
		await exit();
		await settle();
		vi.advanceTimersByTime(500);
		expect(active.value).toBe(false);
		expect(root.classList.contains("movie-only")).toBe(false);
		expect(exitFullscreen).toHaveBeenCalledOnce();
		expect(sentinels[0].release).toHaveBeenCalledOnce();
		expect(window.scrollTo).toHaveBeenLastCalledWith({
			left: 0,
			top: 240,
			behavior: "instant",
		});
	});

	it("stays in fullscreen on a computer if it was in fullscreen before", async () => {
		fullscreenElement = root;
		const { enter, exit } = setup();
		enter();
		await exit();
		expect(exitFullscreen).not.toHaveBeenCalled();
	});

	it("on a phone, follows how the phone is held now rather than how it was", async () => {
		const upright = setup(true);
		upright.enter();
		await settle();
		landscape = true;
		await upright.exit();
		expect(exitFullscreen).not.toHaveBeenCalled();

		const sideways = setup(true);
		sideways.enter();
		await settle();
		landscape = false;
		await sideways.exit();
		expect(exitFullscreen).toHaveBeenCalledOnce();
	});

	it("turns off when leaving the room", async () => {
		const { enter } = setup();
		enter();
		await settle();
		mounted.pop()?.unmount();
		expect(movieOnlyActive.value).toBe(false);
		expect(root.classList.contains("movie-only")).toBe(false);
	});
});

describe("Show controls", () => {
	it("appears on a tap and fades on its own without leaving the mode", async () => {
		const { enter, onTap, revealed, active } = setup();
		enter();
		expect(revealed.value).toBe(false);
		onTap();
		expect(revealed.value).toBe(true);
		vi.advanceTimersByTime(SHOW_CONTROLS_MS - 1);
		expect(revealed.value).toBe(true);
		vi.advanceTimersByTime(1);
		expect(revealed.value).toBe(false);
		expect(active.value).toBe(true);
	});

	it("waits longer after another tap", () => {
		const { enter, onTap, revealed } = setup();
		enter();
		onTap();
		vi.advanceTimersByTime(SHOW_CONTROLS_MS - 100);
		onTap();
		vi.advanceTimersByTime(SHOW_CONTROLS_MS - 100);
		expect(revealed.value).toBe(true);
	});

	it("leaves the mode when pressed", () => {
		const { enter, onTap, onShowControlsPressed, active } = setup();
		enter();
		onTap();
		vi.advanceTimersByTime(SHOW_CONTROLS_ARM_MS);
		onShowControlsPressed();
		expect(active.value).toBe(false);
	});

	it("ignores the second half of a double tap", () => {
		const { enter, onTap, onShowControlsPressed, active } = setup();
		enter();
		onTap();
		vi.advanceTimersByTime(SHOW_CONTROLS_ARM_MS - 1);
		onShowControlsPressed();
		expect(active.value).toBe(true);
	});

	it("is gone when the mode comes back later", async () => {
		const { enter, exit, onTap, revealed } = setup();
		enter();
		onTap();
		await exit();
		enter();
		expect(revealed.value).toBe(false);
	});
});

describe("the phone leaving and coming back", () => {
	it("takes the screen lock again when the page returns", async () => {
		const { enter } = setup();
		enter();
		await settle();
		const release = sentinels[0].addEventListener.mock.calls[0][1] as () => void;
		setVisibility("hidden");
		release();
		setVisibility("visible");
		await settle();
		expect(wakeLockRequest).toHaveBeenCalledTimes(2);
	});

	it("doesn't take the screen lock after the mode is off", async () => {
		const { enter, exit } = setup();
		enter();
		await settle();
		await exit();
		setVisibility("hidden");
		setVisibility("visible");
		await settle();
		expect(wakeLockRequest).toHaveBeenCalledOnce();
	});

	it("gives the lock straight back if the mode ended while it was on its way", async () => {
		let grant!: (sentinel: FakeSentinel) => void;
		wakeLockRequest.mockImplementation(() => new Promise(resolve => (grant = resolve)));
		const { enter, exit } = setup();
		enter();
		await exit();
		const late: FakeSentinel = {
			release: vi.fn(() => Promise.resolve()),
			addEventListener: vi.fn(),
		};
		grant(late);
		await settle();
		expect(late.release).toHaveBeenCalledOnce();
	});

	it("treats leaving fullscreen with the page on screen as asking to get out", async () => {
		const { enter, active } = setup();
		enter();
		await settle();
		setFullscreen(false);
		expect(active.value).toBe(true);
		vi.advanceTimersByTime(FULLSCREEN_LEAVE_GRACE_MS);
		expect(active.value).toBe(false);
	});

	it("stays on when fullscreen ended because the phone went to another app", async () => {
		const { enter, active, onTap } = setup();
		enter();
		await settle();
		expect(requestFullscreen).toHaveBeenCalledOnce();
		setVisibility("hidden");
		setFullscreen(false);
		vi.advanceTimersByTime(FULLSCREEN_LEAVE_GRACE_MS);
		expect(active.value).toBe(true);

		setVisibility("visible");
		onTap();
		expect(requestFullscreen).toHaveBeenCalledTimes(2);
	});

	it("stays on when fullscreen was never granted", async () => {
		requestFullscreen.mockImplementation(() => Promise.reject(new TypeError("refused")));
		const { enter, active } = setup();
		enter();
		await settle();
		document.dispatchEvent(new Event("fullscreenchange"));
		vi.advanceTimersByTime(FULLSCREEN_LEAVE_GRACE_MS);
		expect(active.value).toBe(true);
	});
});

describe("the keyboard in Movie only", () => {
	function press(key: string) {
		const roomShortcut = vi.fn();
		window.addEventListener("keydown", roomShortcut);
		const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
		document.body.dispatchEvent(event);
		window.removeEventListener("keydown", roomShortcut);
		return { roomShortcut, event };
	}

	it("gets out with Esc", () => {
		const { enter, active } = setup();
		enter();
		press("Escape");
		expect(active.value).toBe(false);
	});

	it("brings up the button instead of reaching the room's shortcuts", () => {
		const { enter, revealed, revealedByKey } = setup();
		enter();
		const { roomShortcut, event } = press("t");
		expect(roomShortcut).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(true);
		expect(revealed.value).toBe(true);
		expect(revealedByKey.value).toBe(true);
	});

	it("leaves a key alone once the button has focus, so Enter can press it", () => {
		const { enter } = setup();
		enter();
		press("Enter");
		expect(press("Enter").event.defaultPrevented).toBe(false);
	});

	it("does nothing while the mode is off", () => {
		const { revealed } = setup();
		const { roomShortcut } = press("t");
		expect(roomShortcut).toHaveBeenCalledOnce();
		expect(revealed.value).toBe(false);
	});
});

describe("MovieOnlyButton", () => {
	it("is labelled in words and needs no permission to press", async () => {
		const { wrapper } = mountComponent(MovieOnlyButton, { attrs: { disabled: undefined } });
		const button = wrapper.get('[data-cy="movie-only-toggle"]');
		expect(button.text()).toBe("Movie only");
		expect(button.attributes("disabled")).toBeUndefined();
		await button.trigger("click");
		expect(wrapper.emitted("click")).toHaveLength(1);
	});
});

describe("MovieOnlyLayer", () => {
	const props = { revealed: false, takeFocus: false, playbackBlocked: false };

	it("reports a tap and keeps it from going any further", async () => {
		const outer = vi.fn();
		document.body.addEventListener("click", outer);
		const { wrapper } = mountComponent(MovieOnlyLayer, {
			props,
			attachTo: document.body,
		});
		await wrapper.get('[data-cy="movie-only-tap"]').trigger("click");
		expect(wrapper.emitted("tap")).toHaveLength(1);
		expect(outer).not.toHaveBeenCalled();
		document.body.removeEventListener("click", outer);
	});

	it("draws no button until asked", () => {
		const { wrapper } = mountComponent(MovieOnlyLayer, { props });
		expect(wrapper.find('[data-cy="movie-only-show-controls"]').exists()).toBe(false);
	});

	it("offers the one large button when revealed", async () => {
		const { wrapper } = mountComponent(MovieOnlyLayer, {
			props: { ...props, revealed: true },
		});
		const button = wrapper.get('[data-cy="movie-only-show-controls"]');
		expect(button.text()).toBe("Show controls");
		await button.trigger("click");
		expect(wrapper.emitted("show-controls")).toHaveLength(1);
		expect(wrapper.emitted("tap")).toBeUndefined();
	});

	it("moves down out of the way of PLAY", () => {
		const { wrapper } = mountComponent(MovieOnlyLayer, {
			props: { ...props, revealed: true, playbackBlocked: true },
		});
		expect(wrapper.find(".movie-only-show").classes()).toContain("below-play");
	});

	it("marks everything it draws to stay visible while the page is hidden", () => {
		const { wrapper } = mountComponent(MovieOnlyLayer, {
			props: { ...props, revealed: true },
		});
		expect(wrapper.find(".movie-only-tap").attributes("data-movie-only-keep")).toBeDefined();
		expect(wrapper.find(".movie-only-show").attributes("data-movie-only-keep")).toBeDefined();
	});

	it("takes keyboard focus only when a key brought it up", async () => {
		const { wrapper } = mountComponent(MovieOnlyLayer, {
			props,
			attachTo: document.body,
		});
		await wrapper.setProps({ revealed: true, takeFocus: true });
		await nextTick();
		await nextTick();
		expect(document.activeElement).toBe(
			wrapper.get('[data-cy="movie-only-show-controls"]').element,
		);
	});
});

describe("Chat in Movie only", () => {
	const msg = {
		action: "chat" as const,
		from: {
			id: "other",
			name: "other",
			isLoggedIn: false,
			status: PlayerStatus.ready,
			role: Role.UnregisteredUser,
		},
		text: "hello",
	};

	it("keeps the message for later but makes no sound over the movie", async () => {
		const play = vi.spyOn(OttSfx.prototype, "play").mockResolvedValue(undefined);
		const { wrapper, connection } = mountComponent(Chat);

		connection.mockReceive(msg);
		await nextTick();
		expect(play).toHaveBeenCalledTimes(1);

		movieOnlyActive.value = true;
		connection.mockReceive(msg);
		await nextTick();
		expect(play).toHaveBeenCalledTimes(1);
		expect(wrapper.text().match(/hello/g)).toHaveLength(2);
		play.mockRestore();
	});
});

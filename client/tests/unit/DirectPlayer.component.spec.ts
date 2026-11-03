import { beforeEach, describe, expect, it, vi } from "vitest";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import { flush, mountComponent } from "./component-test-utils";

vi.mock("jassub", () => ({ default: class {} }));

function mountPlayer() {
	const { wrapper } = mountComponent(DirectPlayer, {
		props: { service: "direct", videoUrl: "https://example.com/a.mp4", videoMime: "video/mp4" },
	});
	const video = wrapper.get("video").element as HTMLVideoElement;
	const { exposed } = (wrapper.vm as unknown as { $: { exposed: Record<string, unknown> } }).$;
	return { player: exposed as Record<string, (arg?: number) => boolean>, video };
}

function setMedia(video: HTMLVideoElement, state: Record<string, unknown>) {
	for (const [key, value] of Object.entries(state)) {
		Object.defineProperty(video, key, { configurable: true, value });
	}
}

describe("DirectPlayer sync rate", () => {
	beforeEach(() => {
		window.AudioContext = class {
			close = async () => undefined;
			createGain() {
				return { connect: () => undefined };
			}
		} as unknown as typeof AudioContext;
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	});

	it("changes the rate with pitch kept natural, and writes only on a change", async () => {
		const { player, video } = mountPlayer();
		await flush();
		video.preservesPitch = false;
		player.setSyncRate(1.05);
		expect(video.playbackRate).toBe(1.05);
		expect(video.preservesPitch).toBe(true);

		const writes = vi.fn();
		Object.defineProperty(video, "playbackRate", {
			configurable: true,
			get: () => 1.05,
			set: writes,
		});
		player.setSyncRate(1.05);
		expect(writes).not.toHaveBeenCalled();
		player.setSyncRate(1);
		expect(writes).toHaveBeenCalledWith(1);
	});

	it.each([
		[
			"playing with data",
			{ paused: false, ended: false, seeking: false, readyState: 4 },
			true,
			true,
		],
		[
			"only just enough data",
			{ paused: false, ended: false, seeking: false, readyState: 3 },
			true,
			true,
		],
		["paused", { paused: true, ended: false, seeking: false, readyState: 4 }, true, false],
		["seeking", { paused: false, ended: false, seeking: true, readyState: 4 }, false, false],
		["buffering", { paused: false, ended: false, seeking: false, readyState: 2 }, false, false],
		["ended", { paused: false, ended: true, seeking: false, readyState: 4 }, true, false],
	])("reports when %s", async (_name, state, settled, canAdjust) => {
		const { player, video } = mountPlayer();
		await flush();
		setMedia(video, state);
		expect(player.isSettled()).toBe(settled);
		expect(player.canAdjustRate()).toBe(canAdjust);
	});
});

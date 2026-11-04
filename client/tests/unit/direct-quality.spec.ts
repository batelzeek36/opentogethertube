import { beforeEach, describe, expect, it } from "vitest";
import {
	deviceMaxQuality,
	loadQualityChoice,
	loadRecentSpeed,
	measureSpeed,
	nextLowerSource,
	pickAutoSource,
	saveQualityChoice,
	saveRecentSpeed,
	SPEED_CACHE_MS,
	sourceForHeight,
	StallWatch,
} from "@/util/direct-quality";

const LADDER = [
	{ quality: 2160, bitrate: 38_000_000 },
	{ quality: 1080, bitrate: 12_000_000 },
	{ quality: 720, bitrate: 6_000_000 },
];
const NO_LIMIT = Number.POSITIVE_INFINITY;

describe("pickAutoSource", () => {
	it("starts on the biggest file the connection can hold", () => {
		expect(pickAutoSource(LADDER, 100_000_000, NO_LIMIT)).toBe(0);
		expect(pickAutoSource(LADDER, 20_000_000, NO_LIMIT)).toBe(1);
		expect(pickAutoSource(LADDER, 8_000_000, NO_LIMIT)).toBe(2);
	});

	it("wants room to spare above the peak, not just the peak", () => {
		expect(pickAutoSource(LADDER, 38_000_000, NO_LIMIT)).toBe(1);
	});

	it("falls to the smallest file on a line too slow for any", () => {
		expect(pickAutoSource(LADDER, 1_000_000, NO_LIMIT)).toBe(2);
	});

	it("keeps a phone at 1080p however fast its connection", () => {
		expect(pickAutoSource(LADDER, 500_000_000, 1080)).toBe(1);
	});

	it("plays it safe when the speed is unknown", () => {
		expect(pickAutoSource(LADDER, null, NO_LIMIT)).toBe(1);
		expect(pickAutoSource(LADDER, null, 720)).toBe(2);
	});

	it("doesn't depend on the order the manifest lists the sizes in", () => {
		const reversed = [...LADDER].reverse();
		expect(reversed[pickAutoSource(reversed, 20_000_000, NO_LIMIT)].quality).toBe(1080);
	});

	it("estimates a peak for sources that don't state one", () => {
		const plain = [{ quality: 2160 }, { quality: 1080 }];
		expect(pickAutoSource(plain, 20_000_000, NO_LIMIT)).toBe(1);
		expect(pickAutoSource(plain, 80_000_000, NO_LIMIT)).toBe(0);
	});
});

describe("sourceForHeight", () => {
	it("finds the exact size, or the next one under it", () => {
		expect(sourceForHeight(LADDER, 1080)).toBe(1);
		expect(sourceForHeight(LADDER, 1440)).toBe(1);
	});

	it("uses the smallest when every size is above the height", () => {
		expect(sourceForHeight(LADDER, 480)).toBe(2);
	});
});

describe("nextLowerSource", () => {
	it("steps down one size at a time", () => {
		expect(nextLowerSource(LADDER, 0)).toBe(1);
		expect(nextLowerSource(LADDER, 1)).toBe(2);
	});

	it("stops at the smallest", () => {
		expect(nextLowerSource(LADDER, 2)).toBeNull();
	});

	it("handles an index that isn't there", () => {
		expect(nextLowerSource(LADDER, 9)).toBeNull();
	});
});

describe("deviceMaxQuality", () => {
	it("limits a phone but not a computer or tablet", () => {
		const phone = { screenShortSide: 440, coarsePointer: true, saveData: false };
		expect(deviceMaxQuality(phone)).toBe(1080);
		expect(deviceMaxQuality({ ...phone, coarsePointer: false })).toBe(NO_LIMIT);
		expect(deviceMaxQuality({ ...phone, screenShortSide: 820 })).toBe(NO_LIMIT);
	});

	it("respects a request to save data", () => {
		const laptop = { screenShortSide: 1000, coarsePointer: false, saveData: true };
		expect(deviceMaxQuality(laptop)).toBe(720);
	});
});

describe("StallWatch", () => {
	const LOADED_AT = 0;
	const AFTER_GRACE = 10_000;

	it("calls it on the second stall within the window, not the first", () => {
		const watch = new StallWatch();
		watch.loaded(LOADED_AT);
		expect(watch.stalled(AFTER_GRACE)).toBe(false);
		expect(watch.stalled(AFTER_GRACE + 30_000)).toBe(true);
	});

	it("forgets stalls older than the window", () => {
		const watch = new StallWatch();
		watch.loaded(LOADED_AT);
		watch.stalled(AFTER_GRACE);
		expect(watch.stalled(AFTER_GRACE + 100_000)).toBe(false);
	});

	it("ignores the wait right after a file loads", () => {
		const watch = new StallWatch();
		watch.loaded(LOADED_AT);
		expect(watch.stalled(1000)).toBe(false);
		expect(watch.stalled(2000)).toBe(false);
		expect(watch.stalled(AFTER_GRACE)).toBe(false);
	});

	it("starts over after a switch", () => {
		const watch = new StallWatch();
		watch.loaded(LOADED_AT);
		watch.stalled(AFTER_GRACE);
		watch.loaded(AFTER_GRACE + 1000);
		expect(watch.stalled(AFTER_GRACE + 20_000)).toBe(false);
	});

	it("starts over after calling it", () => {
		const watch = new StallWatch();
		watch.loaded(LOADED_AT);
		watch.stalled(AFTER_GRACE);
		expect(watch.stalled(AFTER_GRACE + 1000)).toBe(true);
		expect(watch.stalled(AFTER_GRACE + 2000)).toBe(false);
	});
});

/** A response body that hands out the chunks, moving a fake clock forward before each one. */
function fakeFetch(chunks: number[], msPerChunk: number, clock: { now: number }): typeof fetch {
	return (async () => {
		let i = 0;
		return {
			ok: true,
			body: {
				getReader: () => ({
					read: async () => {
						if (i >= chunks.length) {
							return { done: true, value: undefined };
						}
						clock.now += msPerChunk;
						return { done: false, value: new Uint8Array(chunks[i++]) };
					},
					cancel: async () => undefined,
				}),
			},
		};
	}) as unknown as typeof fetch;
}

describe("measureSpeed", () => {
	const MB = 1_000_000;

	it("reads the speed from the bytes after the first chunk", async () => {
		const clock = { now: 0 };
		const speed = await measureSpeed("https://example.com/a.mp4", {
			fetchImpl: fakeFetch([MB, MB, MB], 100, clock),
			now: () => clock.now,
			bytes: 10 * MB,
		});
		// 2 MB in 200 ms.
		expect(speed).toBeCloseTo(80_000_000, -3);
	});

	it("doesn't count the wait for the server's first byte", async () => {
		const clock = { now: 0 };
		const fetchImpl = fakeFetch([MB, MB, MB], 100, clock);
		const speed = await measureSpeed("https://example.com/a.mp4", {
			fetchImpl: (async (...args: Parameters<typeof fetch>) => {
				clock.now += 5000;
				return fetchImpl(...args);
			}) as typeof fetch,
			now: () => clock.now,
			bytes: 10 * MB,
		});
		expect(speed).toBeCloseTo(80_000_000, -3);
	});

	it("gives up without an answer when too little arrived to judge", async () => {
		const clock = { now: 0 };
		const speed = await measureSpeed("https://example.com/a.mp4", {
			fetchImpl: fakeFetch([1000, 1000], 100, clock),
			now: () => clock.now,
		});
		expect(speed).toBeNull();
	});

	it("gives up without an answer when the server refuses", async () => {
		const fetchImpl = (async () => ({ ok: false })) as unknown as typeof fetch;
		expect(await measureSpeed("https://example.com/a.mp4", { fetchImpl })).toBeNull();
	});

	it("gives up without an answer when the network fails", async () => {
		const fetchImpl = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(await measureSpeed("https://example.com/a.mp4", { fetchImpl })).toBeNull();
	});
});

describe("what a device remembers", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("keeps a hand-picked size, and Auto clears it", () => {
		expect(loadQualityChoice()).toBeNull();
		saveQualityChoice(2160);
		expect(loadQualityChoice()).toBe(2160);
		saveQualityChoice(null);
		expect(loadQualityChoice()).toBeNull();
	});

	it("reuses a recent speed but not an old one", () => {
		saveRecentSpeed(50_000_000, 1000);
		expect(loadRecentSpeed(2000)).toBe(50_000_000);
		expect(loadRecentSpeed(1000 + SPEED_CACHE_MS)).toBeNull();
	});

	it("survives junk in storage", () => {
		localStorage.setItem("ott-direct-speed", "{not json");
		localStorage.setItem("ott-direct-quality", "tall");
		expect(loadRecentSpeed(0)).toBeNull();
		expect(loadQualityChoice()).toBeNull();
	});
});

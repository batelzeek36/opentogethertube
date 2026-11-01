import { beforeEach, describe, expect, it } from "vitest";
import {
	ADJUST_FROM_SECONDS,
	ADJUST_RATE,
	ADJUST_UNTIL_SECONDS,
	DriftCorrector,
	type DriftInput,
	SEEK_MIN_INTERVAL_MS,
	SEEK_SETTLE_MS,
} from "@/util/drift-correction";

const TICK_MS = 250;

/** A player with the given starting drift, ticked like the room does. */
function simulate(options: {
	startDrift: number;
	roomSpeed?: number;
	ticks?: number;
	/** Added to each reading, for how a real player's position jitters. */
	noise?: (tick: number) => number;
}) {
	const { startDrift, roomSpeed = 1, ticks = 400, noise = () => 0 } = options;
	const corrector = new DriftCorrector();
	let trueDrift = startDrift;
	const rates: number[] = [];
	const drifts: number[] = [];
	for (let i = 0; i < ticks; i++) {
		const { rate, seek } = corrector.step({
			drift: trueDrift + noise(i),
			roomSpeed,
			roomPlaying: true,
			blocked: false,
			settled: true,
			canAdjustRate: true,
			now: i * TICK_MS,
		});
		expect(seek).toBe(false);
		rates.push(rate);
		// In one tick the room advances at its speed and the player at its rate.
		trueDrift += ((roomSpeed - rate) * TICK_MS) / 1000;
		drifts.push(trueDrift);
	}
	return { rates, drifts };
}

/** How many times the rate changed during a run. */
const rateChanges = (rates: number[]) => rates.filter((r, i) => i > 0 && r !== rates[i - 1]).length;

describe("DriftCorrector", () => {
	let corrector: DriftCorrector;
	const input = (over: Partial<DriftInput>): DriftInput => ({
		drift: 0,
		roomSpeed: 1,
		roomPlaying: true,
		blocked: false,
		settled: true,
		canAdjustRate: true,
		now: 0,
		...over,
	});

	beforeEach(() => {
		corrector = new DriftCorrector();
	});

	it("leaves a player alone when it is close", () => {
		for (const drift of [0, 0.1, -0.1, ADJUST_FROM_SECONDS - 0.01]) {
			expect(corrector.step(input({ drift }))).toEqual({ seek: false, rate: 1 });
		}
	});

	it("speeds up when behind and slows down when ahead, without a seek", () => {
		expect(corrector.step(input({ drift: 0.5 }))).toEqual({ seek: false, rate: 1.05 });
		corrector.reset();
		expect(corrector.step(input({ drift: -0.5 }))).toEqual({ seek: false, rate: 0.95 });
	});

	it("eases from either direction up to a full second off", () => {
		expect(corrector.step(input({ drift: 1 })).seek).toBe(false);
		expect(corrector.step(input({ drift: 1 })).rate).toBeGreaterThan(1);
	});

	it("seeks above a second, at the room's speed", () => {
		expect(corrector.step(input({ drift: 1.01 }))).toEqual({ seek: true, rate: 1 });
		corrector.reset();
		expect(corrector.step(input({ drift: -5 }))).toEqual({ seek: true, rate: 1 });
	});

	it.each([0.25, 0.5, 1, 1.5, 2])("scales with a room speed of %s", roomSpeed => {
		expect(corrector.step(input({ drift: 0.5, roomSpeed })).rate).toBeCloseTo(
			roomSpeed * (1 + ADJUST_RATE),
		);
		expect(corrector.step(input({ drift: 0, roomSpeed })).rate).toBe(roomSpeed);
	});

	it("follows the room's speed changing midway through", () => {
		corrector.step(input({ drift: 0.5, roomSpeed: 1 }));
		expect(corrector.step(input({ drift: 0.4, roomSpeed: 2 })).rate).toBeCloseTo(2.1);
	});

	describe("hands back the room's speed", () => {
		it.each<[string, Partial<DriftInput>]>([
			["when the room pauses", { roomPlaying: false }],
			["while buffering or seeking", { canAdjustRate: false }],
			["when playback gets blocked", { blocked: true }],
		])("%s", (_name, over) => {
			expect(corrector.step(input({ drift: 0.5 })).rate).toBe(1.05);
			expect(corrector.step(input({ drift: 0.5, ...over }))).toEqual({
				seek: false,
				rate: 1,
			});
		});

		it("when a seek takes over", () => {
			expect(corrector.step(input({ drift: 0.5 })).rate).toBe(1.05);
			expect(corrector.step(input({ drift: 2 }))).toEqual({ seek: true, rate: 1 });
		});

		it("when caught up", () => {
			expect(corrector.step(input({ drift: 0.5 })).rate).toBe(1.05);
			expect(corrector.step(input({ drift: ADJUST_UNTIL_SECONDS })).rate).toBe(1);
		});

		it("when it overshoots", () => {
			expect(corrector.step(input({ drift: 0.5 })).rate).toBe(1.05);
			expect(corrector.step(input({ drift: -0.06 })).rate).toBe(1);
		});
	});

	describe("never makes things worse", () => {
		it("does not seek while the browser is waiting for a tap", () => {
			expect(corrector.step(input({ drift: 10, blocked: true })).seek).toBe(false);
		});

		it("still seeks when the room is paused, as someone may have moved it", () => {
			expect(corrector.step(input({ drift: 10, roomPlaying: false })).seek).toBe(true);
		});

		it("gives a seek time to land instead of seeking again every tick", () => {
			expect(corrector.step(input({ drift: 3, settled: false, now: 0 })).seek).toBe(true);
			for (let now = TICK_MS; now < SEEK_SETTLE_MS; now += TICK_MS) {
				expect(corrector.step(input({ drift: 3, settled: false, now })).seek).toBe(false);
			}
			expect(
				corrector.step(input({ drift: 3, settled: false, now: SEEK_SETTLE_MS })).seek,
			).toBe(true);
		});

		it("seeks again soon if the last one landed and the player is still far off", () => {
			expect(corrector.step(input({ drift: 3, now: 0 })).seek).toBe(true);
			expect(corrector.step(input({ drift: 3, now: TICK_MS })).seek).toBe(false);
			expect(corrector.step(input({ drift: 3, now: SEEK_MIN_INTERVAL_MS })).seek).toBe(true);
		});

		it("seeks at once when a seek is the first thing it has to do while buffering", () => {
			expect(corrector.step(input({ drift: 3, settled: false, now: 0 })).seek).toBe(true);
		});

		it("starts fresh on a new video", () => {
			expect(corrector.step(input({ drift: 3, now: 0 })).seek).toBe(true);
			corrector.reset();
			expect(corrector.step(input({ drift: 3, now: TICK_MS })).seek).toBe(true);
		});
	});

	describe("over a whole run", () => {
		it.each([0.3, 0.6, 0.99, -0.3, -0.6, -0.99])(
			"converges from %s and stays there with one rate change each way",
			startDrift => {
				const { rates, drifts } = simulate({ startDrift });
				expect(Math.abs(drifts[drifts.length - 1])).toBeLessThan(ADJUST_FROM_SECONDS);
				expect(Math.abs(drifts[drifts.length - 1])).toBeLessThanOrEqual(
					ADJUST_UNTIL_SECONDS + 0.02,
				);
				expect(rateChanges(rates)).toEqual(1);
				expect(rates[rates.length - 1]).toBe(1);
			},
		);

		it.each([0.5, 1, 2])("converges at a room speed of %s", roomSpeed => {
			const { rates, drifts } = simulate({ startDrift: 0.6, roomSpeed, ticks: 800 });
			expect(Math.abs(drifts[drifts.length - 1])).toBeLessThan(ADJUST_FROM_SECONDS);
			expect(rates[rates.length - 1]).toBe(roomSpeed);
			expect(rateChanges(rates)).toEqual(1);
		});

		it("does not flick on and off from jitter in the readings", () => {
			// 60 ms of jitter either way, more than was measured on a real player.
			const noise = (tick: number) => Math.sin(tick * 2.7) * 0.06;
			const { rates, drifts } = simulate({ startDrift: 0.6, noise, ticks: 800 });
			expect(Math.abs(drifts[drifts.length - 1])).toBeLessThan(ADJUST_FROM_SECONDS);
			expect(rates[rates.length - 1]).toBe(1);
			expect(rateChanges(rates)).toBeLessThanOrEqual(2);
		});

		it("does nothing at all for a player already in step, jitter included", () => {
			const noise = (tick: number) => Math.sin(tick * 2.7) * 0.06;
			const { rates } = simulate({ startDrift: 0, noise });
			expect(new Set(rates)).toEqual(new Set([1]));
		});
	});
});

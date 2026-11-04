import { beforeEach, describe, expect, it } from "vitest";
import {
	ADJUST_FROM_SECONDS,
	ADJUST_RATE,
	ADJUST_UNTIL_SECONDS,
	DriftCorrector,
	type DriftInput,
	SEEK_BACKOFF_MAX_MS,
	SEEK_MIN_INTERVAL_MS,
	SEEK_SETTLE_MS,
} from "@/util/drift-correction";

const TICK_MS = 250;
const HOLD = { seek: false, lead: 0, struggling: false };

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
			expect(corrector.step(input({ drift }))).toEqual({ ...HOLD, rate: 1 });
		}
	});

	it("speeds up when behind and slows down when ahead, without a seek", () => {
		expect(corrector.step(input({ drift: 0.5 }))).toEqual({ ...HOLD, rate: 1.05 });
		corrector.reset();
		expect(corrector.step(input({ drift: -0.5 }))).toEqual({ ...HOLD, rate: 0.95 });
	});

	it("eases from either direction up to a full second off", () => {
		expect(corrector.step(input({ drift: 1 })).seek).toBe(false);
		expect(corrector.step(input({ drift: 1 })).rate).toBeGreaterThan(1);
	});

	it("seeks above a second, at the room's speed", () => {
		expect(corrector.step(input({ drift: 1.01 }))).toEqual({ ...HOLD, seek: true, rate: 1 });
		corrector.reset();
		expect(corrector.step(input({ drift: -5 }))).toEqual({ ...HOLD, seek: true, rate: 1 });
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
			expect(corrector.step(input({ drift: 0.5, ...over }))).toEqual({ ...HOLD, rate: 1 });
		});

		it("when a seek takes over", () => {
			expect(corrector.step(input({ drift: 0.5 })).rate).toBe(1.05);
			expect(corrector.step(input({ drift: 2 }))).toEqual({ ...HOLD, seek: true, rate: 1 });
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

		it("never holds back a move in a paused room, which is only asked for once", () => {
			const paused = { drift: 5, roomPlaying: false };
			expect(corrector.step(input({ ...paused, now: 0 })).seek).toBe(true);
			expect(corrector.step(input({ ...paused, now: 10 })).seek).toBe(true);
			expect(corrector.step(input({ ...paused, settled: false, now: 20 })).seek).toBe(true);
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
			const again = SEEK_MIN_INTERVAL_MS * 2;
			expect(corrector.step(input({ drift: 3, now: again - TICK_MS })).seek).toBe(false);
			expect(corrector.step(input({ drift: 3, now: again })).seek).toBe(true);
		});

		it("doesn't count a seek that landed in step as a miss", () => {
			expect(corrector.step(input({ drift: 3, now: 0 })).seek).toBe(true);
			corrector.step(input({ drift: 0, now: TICK_MS }));
			const next = TICK_MS + SEEK_MIN_INTERVAL_MS;
			expect(corrector.step(input({ drift: 3, now: next })).seek).toBe(true);
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

	describe("when seeks are slow to land", () => {
		/**
		 * A player that takes the given time to land every seek, in a room that keeps moving. Each
		 * seek lands that long after it was aimed, so it arrives short by that much minus any lead.
		 */
		function run(landingMs: number, ticks = 400) {
			const corrector = new DriftCorrector();
			const seeks: { lead: number; struggling: boolean }[] = [];
			let drift = 8;
			let landsAt = Number.NEGATIVE_INFINITY;
			for (let i = 0; i < ticks; i++) {
				const now = i * TICK_MS;
				const settled = now >= landsAt;
				const step = corrector.step(input({ drift, settled, canAdjustRate: settled, now }));
				if (step.seek) {
					seeks.push({ lead: step.lead, struggling: step.struggling });
					drift = landingMs / 1000 - step.lead;
					landsAt = now + landingMs;
				} else if (!settled) {
					// Nothing to show yet: it isn't playing, so its reading isn't one to act on.
				} else {
					drift += ((1 - step.rate) * TICK_MS) / 1000;
				}
			}
			return { seeks, drift };
		}

		it("is back in step after a second, better aimed seek", () => {
			const { seeks, drift } = run(3000);
			expect(seeks).toHaveLength(2);
			expect(seeks[0].lead).toBe(0);
			expect(seeks[1].lead).toBeGreaterThan(2.5);
			expect(Math.abs(drift)).toBeLessThan(ADJUST_FROM_SECONDS);
		});

		it("needs only one seek when they land at once", () => {
			const { seeks, drift } = run(0);
			expect(seeks).toHaveLength(1);
			expect(seeks[0].lead).toBe(0);
			expect(drift).toBe(0);
		});

		it("stops re-seeking a player that never lands, instead of restarting it every 5 s", () => {
			const corrector = new DriftCorrector();
			const seekTimes: number[] = [];
			for (let now = 0; now < 60_000; now += TICK_MS) {
				if (corrector.step(input({ drift: 5, settled: false, now })).seek) {
					seekTimes.push(now);
				}
			}
			expect(seekTimes.slice(0, 3)).toEqual([0, SEEK_SETTLE_MS, SEEK_SETTLE_MS * 3]);
			const gaps = seekTimes.slice(1).map((at, i) => at - seekTimes[i]);
			expect(Math.max(...gaps)).toBe(SEEK_BACKOFF_MAX_MS);
		});

		it("aims a stranded player further ahead the longer it took", () => {
			const corrector = new DriftCorrector();
			corrector.step(input({ drift: 5, settled: false, now: 0 }));
			const second = corrector.step(input({ drift: 5, settled: false, now: SEEK_SETTLE_MS }));
			expect(second.seek).toBe(true);
			expect(second.lead).toBe(SEEK_SETTLE_MS / 1000);
		});

		it("says so once seeking has failed twice in a row", () => {
			const corrector = new DriftCorrector();
			const seeks: boolean[] = [];
			for (let now = 0; now < 40_000; now += TICK_MS) {
				const step = corrector.step(input({ drift: 5, settled: false, now }));
				if (step.seek) {
					seeks.push(step.struggling);
				}
			}
			expect(seeks.slice(0, 3)).toEqual([false, false, true]);
		});

		it("leaves a paused room's seek where it was aimed", () => {
			const corrector = new DriftCorrector();
			corrector.step(input({ drift: 5, settled: false, now: 0 }));
			corrector.step(input({ drift: 5, settled: false, now: SEEK_SETTLE_MS }));
			const paused = corrector.step(
				input({ drift: 5, roomPlaying: false, now: SEEK_SETTLE_MS + TICK_MS }),
			);
			expect(paused.seek).toBe(true);
			expect(paused.lead).toBe(0);
		});

		it("forgets all of it on a new video", () => {
			const corrector = new DriftCorrector();
			corrector.step(input({ drift: 5, settled: false, now: 0 }));
			corrector.step(input({ drift: 5, settled: false, now: SEEK_SETTLE_MS }));
			corrector.reset();
			const step = corrector.step(input({ drift: 5, now: SEEK_SETTLE_MS + TICK_MS }));
			expect(step).toEqual({ ...HOLD, seek: true, rate: 1 });
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

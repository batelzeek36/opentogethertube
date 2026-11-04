/** Above this far off, jump. Below it, a jump would be more noticeable than the drift. */
export const SEEK_ABOVE_SECONDS = 1;
/** At or above this far off, start easing back. */
export const ADJUST_FROM_SECONDS = 0.25;
/**
 * Close enough to stop. Well under the start point, so that the small jitter in reading the
 * position can't flick the rate on and off around one threshold.
 */
export const ADJUST_UNTIL_SECONDS = 0.05;
/** How much faster or slower than the room to play while easing back: too little to notice. */
export const ADJUST_RATE = 0.05;
/** Give a seek this long to land before trying again, so a slow connection can catch up. */
export const SEEK_SETTLE_MS = 5000;
/** Even when a seek has landed, a player can't keep being moved faster than this. */
export const SEEK_MIN_INTERVAL_MS = 1000;
/** Each seek that fails to bring a player back doubles the wait for the next, up to this. */
export const SEEK_BACKOFF_MAX_MS = 20_000;
/** Seeks quicker than this land close enough to where they were aimed. */
export const SEEK_LEAD_FROM_SECONDS = 0.25;
export const SEEK_LEAD_MAX_SECONDS = 10;
/** This many seeks in a row without getting back in step means this file is too much for it. */
export const SEEK_MISSES_TO_STRUGGLE = 2;

export interface DriftInput {
	/** Where the room is minus where this player is. Positive means this player is behind. */
	drift: number;
	/** The room's playback speed setting. */
	roomSpeed: number;
	/** The room is playing rather than paused. */
	roomPlaying: boolean;
	/** The browser refused to start playback and is waiting for a tap. */
	blocked: boolean;
	/** The player has landed from any seek and has data to show. */
	settled: boolean;
	/** The player is actually playing right now, not paused, seeking or buffering. */
	canAdjustRate: boolean;
	/** The current time in milliseconds. */
	now: number;
}

export interface DriftStep {
	/** Jump to the room's position. */
	seek: boolean;
	/** What the player's rate should be. */
	rate: number;
	/** How far past the room's position to aim the seek: the room moves on while a seek lands. */
	lead: number;
	/** Seeking isn't bringing this player back, however it is aimed. */
	struggling: boolean;
}

/**
 * Keeps a player that can change its rate finely in step with the room: small drift is eased away
 * by playing slightly fast or slow, large drift is jumped over. It only decides, and holds what it
 * has to remember between ticks.
 *
 * A seek takes time to land: the browser has to fetch the new spot and decode from the keyframe
 * before it, on some devices for seconds. Aimed at where the room is now, it lands that far behind,
 * and if that is past the seek threshold it seeks again, for as long as the movie lasts. So this
 * measures how long seeks take here, aims that far ahead, and backs off when one still misses.
 */
export class DriftCorrector {
	/** 1 while speeding up, -1 while slowing down, 0 otherwise. */
	private direction = 0;
	private lastSeekAt = Number.NEGATIVE_INFINITY;
	/** A seek is out and hasn't landed yet. */
	private landing = false;
	/** How long seeks take on this player, in seconds. */
	private landingSeconds = 0;
	/** Seeks in a row that didn't bring the player back. */
	private misses = 0;

	reset(): void {
		this.direction = 0;
		this.lastSeekAt = Number.NEGATIVE_INFINITY;
		this.landing = false;
		this.landingSeconds = 0;
		this.misses = 0;
	}

	step(input: DriftInput): DriftStep {
		const { drift, roomSpeed } = input;
		this.noteLanding(input);
		const hold = { seek: false, rate: roomSpeed, lead: 0, struggling: false };
		if (input.blocked) {
			this.direction = 0;
			return hold;
		}
		if (Math.abs(drift) > SEEK_ABOVE_SECONDS) {
			this.direction = 0;
			if (!this.shouldSeek(input)) {
				return hold;
			}
			return {
				...hold,
				seek: true,
				lead: input.roomPlaying ? this.lead() : 0,
				struggling: this.misses >= SEEK_MISSES_TO_STRUGGLE,
			};
		}
		if (!(input.roomPlaying && input.canAdjustRate)) {
			this.direction = 0;
			return hold;
		}
		this.updateDirection(drift);
		return { ...hold, rate: roomSpeed * (1 + this.direction * ADJUST_RATE) };
	}

	private noteLanding({ settled, drift, now }: DriftInput): void {
		const inStep = Math.abs(drift) <= SEEK_ABOVE_SECONDS;
		if (settled && this.landing) {
			this.landing = false;
			this.learnLandingTime(now);
			this.misses = inStep ? 0 : this.misses + 1;
		} else if (settled && inStep) {
			this.misses = 0;
		}
	}

	private learnLandingTime(now: number): void {
		const took = (now - this.lastSeekAt) / 1000;
		this.landingSeconds = this.landingSeconds === 0 ? took : (this.landingSeconds + took) / 2;
	}

	private lead(): number {
		if (this.landingSeconds < SEEK_LEAD_FROM_SECONDS) {
			return 0;
		}
		return Math.min(this.landingSeconds, SEEK_LEAD_MAX_SECONDS);
	}

	private shouldSeek({ settled, now, roomPlaying }: DriftInput): boolean {
		// A paused room's position only changes when someone moves it, and that happens once: held
		// back here, the move would never be tried again. A playing room asks again every tick.
		const wait = Math.min(
			(settled ? SEEK_MIN_INTERVAL_MS : SEEK_SETTLE_MS) * 2 ** this.misses,
			SEEK_BACKOFF_MAX_MS,
		);
		if (roomPlaying && now - this.lastSeekAt < wait) {
			return false;
		}
		if (roomPlaying && this.landing) {
			// Abandoning a seek that never landed: it took at least this long, and got nowhere.
			this.learnLandingTime(now);
			this.misses += 1;
		}
		this.lastSeekAt = now;
		this.landing = true;
		return true;
	}

	private updateDirection(drift: number): void {
		const size = Math.abs(drift);
		if (this.direction === 0) {
			if (size >= ADJUST_FROM_SECONDS) {
				this.direction = Math.sign(drift);
			}
		} else if (size <= ADJUST_UNTIL_SECONDS || Math.sign(drift) !== this.direction) {
			this.direction = 0;
		}
	}
}

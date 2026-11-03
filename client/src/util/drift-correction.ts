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
}

/**
 * Keeps a player that can change its rate finely in step with the room: small drift is eased away
 * by playing slightly fast or slow, large drift is jumped over. It only decides, and holds what it
 * has to remember between ticks.
 */
export class DriftCorrector {
	/** 1 while speeding up, -1 while slowing down, 0 otherwise. */
	private direction = 0;
	private lastSeekAt = Number.NEGATIVE_INFINITY;

	reset(): void {
		this.direction = 0;
		this.lastSeekAt = Number.NEGATIVE_INFINITY;
	}

	step(input: DriftInput): DriftStep {
		const { drift, roomSpeed } = input;
		if (input.blocked) {
			this.direction = 0;
			return { seek: false, rate: roomSpeed };
		}
		if (Math.abs(drift) > SEEK_ABOVE_SECONDS) {
			this.direction = 0;
			return { seek: this.shouldSeek(input), rate: roomSpeed };
		}
		if (!(input.roomPlaying && input.canAdjustRate)) {
			this.direction = 0;
			return { seek: false, rate: roomSpeed };
		}
		this.updateDirection(drift);
		return { seek: false, rate: roomSpeed * (1 + this.direction * ADJUST_RATE) };
	}

	private shouldSeek({ settled, now, roomPlaying }: DriftInput): boolean {
		// A paused room's position only changes when someone moves it, and that happens once: held
		// back here, the move would never be tried again. A playing room asks again every tick.
		const wait = settled ? SEEK_MIN_INTERVAL_MS : SEEK_SETTLE_MS;
		if (roomPlaying && now - this.lastSeekAt < wait) {
			return false;
		}
		this.lastSeekAt = now;
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

/**
 * Which file a viewer plays when a movie's manifest offers several sizes of the same picture. Every
 * viewer picks for themselves: sync only compares positions, so one person on 1080p and another on
 * 4K stay on the same second, as long as the files share a timeline.
 */

/** A source as far as choosing goes: its height, and its peak rate in bits per second if known. */
export interface QualitySource {
	quality: number;
	bitrate?: number;
}

/** Auto wants this much more speed than a source's peak, so the buffer can grow instead of drain. */
export const SPEED_HEADROOM = 1.15;
/** A phone's screen can't show more than this, so Auto stops here. A manual pick can go higher. */
export const PHONE_MAX_QUALITY = 1080;
/** Used when the speed could not be measured: plays nearly anywhere and still looks good. */
export const UNKNOWN_SPEED_MAX_QUALITY = 1080;
/** A measurement is reused for this long, so a reload doesn't wait for a new one. */
export const SPEED_CACHE_MS = 30 * 60 * 1000;
export const SPEED_PROBE_BYTES = 6_000_000;
export const SPEED_PROBE_TIMEOUT_MS = 3000;
/** Past the file's header, where the bytes are as typical as any and nothing else fetches them. */
const SPEED_PROBE_OFFSET = 32_000_000;
/** Less than this says more about the connection starting up than about its speed. */
const SPEED_PROBE_MIN_BYTES = 256 * 1024;

const CHOICE_KEY = "ott-direct-quality";
const SPEED_KEY = "ott-direct-speed";

/** Peak rates for sources that don't state one. */
function peakBitsPerSecond(source: QualitySource): number {
	if (source.bitrate) {
		return source.bitrate;
	}
	if (source.quality >= 2000) {
		return 38_000_000;
	}
	return source.quality >= 1000 ? 12_000_000 : 6_000_000;
}

function indexOfLowest(sources: readonly QualitySource[]): number {
	return sources.reduce((low, s, i) => (s.quality < sources[low].quality ? i : low), 0);
}

/** The best source at or under a height, or the lowest there is when all are above it. */
export function sourceForHeight(sources: readonly QualitySource[], height: number): number {
	let best = -1;
	sources.forEach((s, i) => {
		if (s.quality <= height && (best === -1 || s.quality > sources[best].quality)) {
			best = i;
		}
	});
	return best === -1 ? indexOfLowest(sources) : best;
}

/** What Auto starts on, given the measured speed (null when unknown) and the device's limit. */
export function pickAutoSource(
	sources: readonly QualitySource[],
	speedBitsPerSecond: number | null,
	deviceMaxQuality: number,
): number {
	if (speedBitsPerSecond === null) {
		return sourceForHeight(sources, Math.min(deviceMaxQuality, UNKNOWN_SPEED_MAX_QUALITY));
	}
	let best = -1;
	sources.forEach((s, i) => {
		const fits = peakBitsPerSecond(s) * SPEED_HEADROOM <= speedBitsPerSecond;
		if (fits && s.quality <= deviceMaxQuality) {
			if (best === -1 || s.quality > sources[best].quality) {
				best = i;
			}
		}
	});
	return best === -1 ? indexOfLowest(sources) : best;
}

/** The next size down from the given source, or null when it is already the smallest. */
export function nextLowerSource(sources: readonly QualitySource[], active: number): number | null {
	const current = sources[active]?.quality;
	if (current === undefined) {
		return null;
	}
	let next: number | null = null;
	sources.forEach((s, i) => {
		if (s.quality < current && (next === null || s.quality > sources[next].quality)) {
			next = i;
		}
	});
	return next;
}

interface DeviceInfo {
	screenShortSide: number;
	coarsePointer: boolean;
	saveData: boolean;
}

/** The tallest source worth starting on for this device. */
export function deviceMaxQuality(device: DeviceInfo): number {
	if (device.saveData) {
		return 720;
	}
	const isPhone = device.coarsePointer && device.screenShortSide < 500;
	return isPhone ? PHONE_MAX_QUALITY : Number.POSITIVE_INFINITY;
}

export function currentDeviceInfo(): DeviceInfo {
	const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
	return {
		screenShortSide: Math.min(screen.width, screen.height),
		coarsePointer: window.matchMedia("(pointer: coarse)").matches,
		saveData: connection?.saveData === true,
	};
}

/**
 * Decides when a playing video has stalled often enough that its size is the problem. The first
 * moments after a file loads don't count: everything waits then.
 */
export class StallWatch {
	private stalls: number[] = [];
	private loadedAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly limit = 2,
		private readonly windowMs = 90_000,
		private readonly graceMs = 8000,
	) {}

	/** A new file started loading: what happened to the old one says nothing about this one. */
	loaded(now: number): void {
		this.loadedAt = now;
		this.stalls = [];
	}

	/** Returns true when this stall reaches the limit, then starts counting again. */
	stalled(now: number): boolean {
		if (now - this.loadedAt < this.graceMs) {
			return false;
		}
		this.stalls = this.stalls.filter(at => now - at < this.windowMs);
		this.stalls.push(now);
		if (this.stalls.length < this.limit) {
			return false;
		}
		this.stalls = [];
		return true;
	}
}

interface ProbeOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
	bytes?: number;
	timeoutMs?: number;
}

/**
 * Downloads a slice of a file and returns the speed in bits per second, or null if it can't tell.
 * The clock starts at the first byte, so the wait for the server to answer doesn't read as a slow
 * connection, and a line too slow to finish still gives an answer from what arrived in time.
 */
export async function measureSpeed(
	url: string,
	{
		fetchImpl = fetch,
		now = () => performance.now(),
		bytes = SPEED_PROBE_BYTES,
		timeoutMs = SPEED_PROBE_TIMEOUT_MS,
	}: ProbeOptions = {},
): Promise<number | null> {
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), timeoutMs);
	let received = 0;
	let firstByteAt: number | null = null;
	let lastByteAt = 0;
	try {
		const response = await fetchImpl(url, {
			headers: { Range: `bytes=${SPEED_PROBE_OFFSET}-${SPEED_PROBE_OFFSET + bytes - 1}` },
			cache: "no-store",
			signal: abort.signal,
		});
		if (!response.ok || !response.body) {
			return null;
		}
		const reader = response.body.getReader();
		while (received < bytes) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			const at = now();
			if (firstByteAt === null) {
				// This chunk's time is spent on the wait for the server, so its bytes don't count.
				firstByteAt = at;
			} else {
				received += value.length;
				lastByteAt = at;
			}
		}
		await reader.cancel();
	} catch (e) {
		// Running out of time mid-file still leaves a usable reading below.
		if (!abort.signal.aborted) {
			console.warn("Speed check failed:", e);
			return null;
		}
	} finally {
		clearTimeout(timeout);
		abort.abort();
	}
	if (firstByteAt === null || received < SPEED_PROBE_MIN_BYTES || lastByteAt <= firstByteAt) {
		return null;
	}
	return (received * 8 * 1000) / (lastByteAt - firstByteAt);
}

/** Storage can be missing or refuse writes (private windows), which only loses the memory. */
function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(key);
		} else {
			localStorage.setItem(key, value);
		}
	} catch {
		// see read()
	}
}

/** The height this device was set to by hand, or null for Auto. */
export function loadQualityChoice(): number | null {
	const value = Number(read(CHOICE_KEY));
	return Number.isFinite(value) && value > 0 ? value : null;
}

export function saveQualityChoice(height: number | null): void {
	write(CHOICE_KEY, height === null ? null : String(height));
}

export function loadRecentSpeed(now: number): number | null {
	const raw = read(SPEED_KEY);
	if (!raw) {
		return null;
	}
	try {
		const { speed, at } = JSON.parse(raw) as { speed?: unknown; at?: unknown };
		const fresh = typeof at === "number" && now - at < SPEED_CACHE_MS && now >= at;
		return fresh && typeof speed === "number" && speed > 0 ? speed : null;
	} catch {
		return null;
	}
}

export function saveRecentSpeed(speed: number, now: number): void {
	write(SPEED_KEY, JSON.stringify({ speed, at: now }));
}

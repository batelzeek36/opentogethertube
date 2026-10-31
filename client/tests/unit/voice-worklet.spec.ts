import { describe, expect, it } from "vitest";
import {
	VOICE_FRAME_BYTES,
	VOICE_FRAME_HEADER_BYTES,
	VOICE_FRAME_MAGIC,
	VOICE_FRAME_SAMPLES,
	VOICE_FRAME_VERSION,
	isValidVoiceFrame,
} from "ott-common/models/voice";
import {
	VoiceDownsampler,
	VoiceFrameBuilder,
	VoiceJitterBuffer,
} from "../../public/voice-worklet.js";

function sine(hz: number, rate: number, samples: number): Float32Array {
	const out = new Float32Array(samples);
	for (let i = 0; i < samples; i++) {
		out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
	}
	return out;
}

function rms(values: ArrayLike<number>, skip = 0): number {
	let sum = 0;
	for (let i = skip; i < values.length; i++) {
		sum += values[i] * values[i];
	}
	return Math.sqrt(sum / (values.length - skip));
}

function downsample(input: Float32Array, inRate: number): number[] {
	const out: number[] = [];
	new VoiceDownsampler(inRate, 16000).process(input, (s: number) => out.push(s));
	return out;
}

describe("VoiceDownsampler", () => {
	it.each([48000, 44100, 96000, 16000])("makes the right number of samples from %d Hz", rate => {
		expect(Math.abs(downsample(new Float32Array(rate), rate).length - 16000)).toBeLessThan(2);
	});

	it("keeps a voice frequency", () => {
		const out = downsample(sine(1000, 48000, 48000), 48000);
		expect(rms(out, 200)).toBeGreaterThan(0.65);
	});

	it("filters out what cannot be represented at 16 kHz", () => {
		const out = downsample(sine(14000, 48000, 48000), 48000);
		expect(rms(out, 200)).toBeLessThan(0.02);
	});
});

describe("VoiceFrameBuilder", () => {
	const options = {
		frameSamples: VOICE_FRAME_SAMPLES,
		headerBytes: VOICE_FRAME_HEADER_BYTES,
		magic: VOICE_FRAME_MAGIC,
		version: VOICE_FRAME_VERSION,
	};

	it("produces a valid frame once it has enough samples", () => {
		const builder = new VoiceFrameBuilder(options);
		for (let i = 0; i < VOICE_FRAME_SAMPLES - 1; i++) {
			expect(builder.push(0.5)).toBeNull();
		}
		const frame = builder.push(0.5) as ArrayBuffer;
		expect(frame.byteLength).toEqual(VOICE_FRAME_BYTES);
		expect(isValidVoiceFrame(new Uint8Array(frame))).toEqual(true);
		expect(new Int16Array(frame, VOICE_FRAME_HEADER_BYTES)[0]).toEqual(16384);
	});

	it("clamps instead of wrapping around", () => {
		const builder = new VoiceFrameBuilder(options);
		let frame: ArrayBuffer | null | undefined = null;
		builder.push(5);
		builder.push(-5);
		for (let i = 2; i < VOICE_FRAME_SAMPLES; i++) {
			frame = builder.push(0);
		}
		const samples = new Int16Array(frame as unknown as ArrayBuffer, VOICE_FRAME_HEADER_BYTES);
		expect(samples[0]).toEqual(32767);
		expect(samples[1]).toEqual(-32767);
	});

	it("starts clean after a reset", () => {
		const builder = new VoiceFrameBuilder(options);
		builder.push(1);
		builder.reset();
		expect(builder.filled).toEqual(0);
	});
});

describe("VoiceJitterBuffer", () => {
	const make = () =>
		new VoiceJitterBuffer({
			frameSamples: VOICE_FRAME_SAMPLES,
			inRate: 16000,
			outRate: 48000,
			startFrames: 3,
		});
	const tone = () => {
		const frame = new Int16Array(VOICE_FRAME_SAMPLES);
		for (let i = 0; i < frame.length; i++) {
			frame[i] = Math.sin((2 * Math.PI * 500 * i) / 16000) * 16000;
		}
		return frame;
	};
	const render = (jitter: VoiceJitterBuffer, samples = 128) => {
		const out = new Float32Array(samples);
		jitter.render(out);
		return out;
	};

	it("stays silent until it has its cushion", () => {
		const jitter = make();
		jitter.push(tone());
		jitter.push(tone());
		expect(rms(render(jitter))).toEqual(0);
		jitter.push(tone());
		expect(rms(render(jitter, 1024))).toBeGreaterThan(0.1);
	});

	it("returns to silence after running dry, without a jump", () => {
		const jitter = make();
		for (let i = 0; i < 3; i++) {
			jitter.push(tone());
		}
		// 60 ms at 48 kHz, plus plenty
		const out = new Float32Array(6000);
		jitter.render(out);
		expect(rms(out.slice(5500))).toEqual(0);
		for (let i = 1; i < out.length; i++) {
			expect(Math.abs(out[i] - out[i - 1])).toBeLessThan(0.2);
		}
	});

	it("wants a bigger cushion after running dry", () => {
		const jitter = make();
		for (let i = 0; i < 3; i++) {
			jitter.push(tone());
		}
		render(jitter, 6000);
		expect(jitter.startFrames).toEqual(4);
		jitter.reset();
		expect(jitter.startFrames).toEqual(3);
	});

	it("catches up by dropping the oldest audio when too much builds up", () => {
		const jitter = make();
		for (let i = 0; i < 16; i++) {
			jitter.push(tone());
		}
		expect(jitter.queue?.length).toEqual(3);
	});

	it("forgets what it holds on reset", () => {
		const jitter = make();
		for (let i = 0; i < 5; i++) {
			jitter.push(tone());
		}
		jitter.reset();
		expect(jitter.queue?.length).toEqual(0);
		expect(rms(render(jitter, 2048), 1024)).toEqual(0);
	});
});

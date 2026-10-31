/* global globalThis */
/*
 * Runs on the browser's audio thread. Served as a plain file because audio worklets load by URL.
 * Bump VOICE_WORKLET_URL in src/voice/audio.ts when changing this: static files are cached for a year.
 *
 * Capture: microphone at the device's rate -> 16 kHz 16-bit frames, only while told to be live.
 * Player: 16 kHz frames off the network -> a small jitter buffer -> the device's rate.
 */

/** Low-pass filters and decimates a stream of samples to a lower rate. */
export class VoiceDownsampler {
	constructor(inRate, outRate, taps = 31) {
		this.step = inRate / outRate;
		this.untilNext = 0;
		this.history = new Float32Array(taps);
		this.index = 0;
		this.coefficients = new Float32Array(taps);
		const cutoff = Math.min(0.45, (0.45 * outRate) / inRate);
		let sum = 0;
		for (let i = 0; i < taps; i++) {
			const x = i - (taps - 1) / 2;
			const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
			const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1));
			this.coefficients[i] = sinc * hann;
			sum += this.coefficients[i];
		}
		for (let i = 0; i < taps; i++) {
			this.coefficients[i] /= sum;
		}
	}

	process(input, emit) {
		const { history, coefficients } = this;
		const taps = history.length;
		for (let n = 0; n < input.length; n++) {
			history[this.index] = input[n];
			this.index = (this.index + 1) % taps;
			this.untilNext -= 1;
			while (this.untilNext <= 0) {
				let out = 0;
				for (let i = 0; i < taps; i++) {
					out += coefficients[i] * history[(this.index + i) % taps];
				}
				emit(out);
				this.untilNext += this.step;
			}
		}
	}
}

/** Collects samples into frames of 16-bit audio behind a fixed header. */
export class VoiceFrameBuilder {
	constructor({ frameSamples, headerBytes, magic, version }) {
		this.frameSamples = frameSamples;
		this.headerBytes = headerBytes;
		this.magic = magic;
		this.version = version;
		this.reset();
	}

	reset() {
		this.buffer = new ArrayBuffer(this.headerBytes + this.frameSamples * 2);
		const header = new Uint8Array(this.buffer, 0, this.headerBytes);
		header[0] = this.magic;
		header[1] = this.version;
		this.samples = new Int16Array(this.buffer, this.headerBytes);
		this.filled = 0;
	}

	/** @returns the finished frame when this sample completes one, otherwise null */
	push(sample) {
		const clamped = Math.max(-1, Math.min(1, sample));
		this.samples[this.filled++] = Math.round(clamped * 32767);
		if (this.filled < this.frameSamples) {
			return null;
		}
		const frame = this.buffer;
		this.reset();
		return frame;
	}
}

/**
 * Plays frames that arrive unevenly. Waits for a few frames before it starts, drops the oldest if
 * too much has built up, and asks for one more frame of cushion each time it runs dry during a turn.
 */
export class VoiceJitterBuffer {
	constructor({
		frameSamples,
		inRate,
		outRate,
		startFrames = 3,
		maxStartFrames = 8,
		maxFrames = 15,
	}) {
		this.frameSamples = frameSamples;
		this.step = inRate / outRate;
		this.baseStartFrames = startFrames;
		this.maxStartFrames = maxStartFrames;
		this.maxFrames = maxFrames;
		this.fadeStep = 1 / (0.005 * outRate);
		this.window = [0, 0, 0, 0];
		this.frac = 0;
		this.gain = 0;
		this.reset();
	}

	/** Forget everything queued. Called when the speaker changes. */
	reset() {
		this.queue = [];
		this.readIndex = 0;
		this.playing = false;
		this.startFrames = this.baseStartFrames;
	}

	push(frame) {
		this.queue.push(frame);
		if (this.queue.length > this.maxFrames) {
			this.queue.splice(0, this.queue.length - this.startFrames);
			this.readIndex = 0;
		}
	}

	nextSample() {
		const frame = this.queue[0];
		if (!frame) {
			if (this.playing) {
				this.playing = false;
				this.startFrames = Math.min(this.startFrames + 1, this.maxStartFrames);
			}
			return 0;
		}
		const sample = frame[this.readIndex++] / 32768;
		if (this.readIndex >= frame.length) {
			this.queue.shift();
			this.readIndex = 0;
		}
		return sample;
	}

	render(out) {
		if (!this.playing && this.queue.length >= this.startFrames) {
			this.playing = true;
		}
		const w = this.window;
		for (let i = 0; i < out.length; i++) {
			const t = this.frac;
			// Catmull-Rom interpolation between w[1] and w[2]
			const value =
				w[1] +
				0.5 *
					t *
					(w[2] -
						w[0] +
						t *
							(2 * w[0] -
								5 * w[1] +
								4 * w[2] -
								w[3] +
								t * (3 * (w[1] - w[2]) + w[3] - w[0])));
			this.gain = this.playing
				? Math.min(1, this.gain + this.fadeStep)
				: Math.max(0, this.gain - this.fadeStep);
			out[i] = value * this.gain;
			this.frac += this.step;
			while (this.frac >= 1) {
				this.frac -= 1;
				w[0] = w[1];
				w[1] = w[2];
				w[2] = w[3];
				w[3] = this.playing ? this.nextSample() : 0;
			}
		}
	}
}

if (typeof globalThis.registerProcessor === "function") {
	const { AudioWorkletProcessor, sampleRate } = globalThis;

	class VoiceCaptureProcessor extends AudioWorkletProcessor {
		constructor(options) {
			super();
			const config = options.processorOptions;
			this.live = false;
			this.downsampler = new VoiceDownsampler(sampleRate, config.sampleRate);
			this.builder = new VoiceFrameBuilder(config);
			this.emit = sample => {
				const frame = this.builder.push(sample);
				if (frame) {
					this.port.postMessage(frame, [frame]);
				}
			};
			this.port.onmessage = e => {
				this.live = e.data.live;
				if (!this.live) {
					this.builder.reset();
				}
			};
		}

		process(inputs) {
			const input = inputs[0] && inputs[0][0];
			if (this.live && input) {
				this.downsampler.process(input, this.emit);
			}
			return true;
		}
	}

	class VoicePlayerProcessor extends AudioWorkletProcessor {
		constructor(options) {
			super();
			this.jitter = new VoiceJitterBuffer({
				frameSamples: options.processorOptions.frameSamples,
				inRate: options.processorOptions.sampleRate,
				outRate: sampleRate,
			});
			this.port.onmessage = e => {
				if (e.data === "reset") {
					this.jitter.reset();
				} else {
					this.jitter.push(new Int16Array(e.data));
				}
			};
		}

		process(_inputs, outputs) {
			this.jitter.render(outputs[0][0]);
			return true;
		}
	}

	globalThis.registerProcessor("voice-capture", VoiceCaptureProcessor);
	globalThis.registerProcessor("voice-player", VoicePlayerProcessor);
}

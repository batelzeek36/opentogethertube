import {
	VOICE_FRAME_HEADER_BYTES,
	VOICE_FRAME_MAGIC,
	VOICE_FRAME_SAMPLES,
	VOICE_FRAME_VERSION,
	VOICE_SAMPLE_RATE,
} from "ott-common/models/voice";

const VOICE_WORKLET_URL = `${import.meta.env.BASE_URL}voice-worklet.js?v=1`;

/**
 * How long the mic stays open, muted, after joining or letting go of the talk button. Within this
 * window a press is instant. After it the mic is fully released, so the phone stops showing it as
 * in use and the movie's sound leaves the phone's call audio mode, and the next press reopens it.
 */
const MIC_WARM_MS = 15_000;

export type MicResult = "ready" | "denied" | "none";

export interface VoiceAudioDevice {
	open(): Promise<void>;
	close(): void;
	resume(): void;
	playFrame(pcm: ArrayBuffer): void;
	resetPlayback(): void;
	setMuted(muted: boolean): void;
	acquireMic(): Promise<MicResult>;
	setMicLive(live: boolean): void;
	releaseMicSoon(): void;
	onFrame: ((frame: ArrayBuffer) => void) | null;
}

function micResultFromError(err: unknown): MicResult {
	const name = (err as { name?: string })?.name;
	return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none";
}

/** The microphone and speaker side of voice, on Web Audio. Knows nothing about the network. */
export class VoiceAudio implements VoiceAudioDevice {
	onFrame: ((frame: ArrayBuffer) => void) | null = null;

	private context: AudioContext | null = null;
	private player: AudioWorkletNode | null = null;
	private gain: GainNode | null = null;
	private capture: AudioWorkletNode | null = null;
	private stream: MediaStream | null = null;
	private micSource: MediaStreamAudioSourceNode | null = null;
	private micRequest: Promise<MicResult> | null = null;
	private warmTimer: ReturnType<typeof setTimeout> | null = null;
	private muted = false;

	/** Must start inside a tap: browsers only let audio start from one. */
	async open(): Promise<void> {
		if (this.context) {
			this.resume();
			return;
		}
		const context = new AudioContext({ latencyHint: "interactive" });
		this.context = context;
		this.resume();
		try {
			await context.audioWorklet.addModule(VOICE_WORKLET_URL);
		} catch (err) {
			this.close();
			throw err;
		}
		if (this.context !== context) {
			return;
		}
		const options = {
			sampleRate: VOICE_SAMPLE_RATE,
			frameSamples: VOICE_FRAME_SAMPLES,
			headerBytes: VOICE_FRAME_HEADER_BYTES,
			magic: VOICE_FRAME_MAGIC,
			version: VOICE_FRAME_VERSION,
		};
		this.player = new AudioWorkletNode(context, "voice-player", {
			numberOfInputs: 0,
			outputChannelCount: [1],
			processorOptions: options,
		});
		this.gain = context.createGain();
		this.gain.gain.value = this.muted ? 0 : 1;
		this.player.connect(this.gain).connect(context.destination);

		this.capture = new AudioWorkletNode(context, "voice-capture", {
			channelCount: 1,
			channelCountMode: "explicit",
			outputChannelCount: [1],
			processorOptions: options,
		});
		this.capture.port.onmessage = e => this.onFrame?.(e.data);
		// A worklet only runs while connected to the output. This path carries silence.
		const silence = context.createGain();
		silence.gain.value = 0;
		this.capture.connect(silence).connect(context.destination);
	}

	close(): void {
		this.releaseMic();
		this.player = null;
		this.gain = null;
		this.capture = null;
		const context = this.context;
		this.context = null;
		if (context && context.state !== "closed") {
			void context.close().catch(err => console.warn("Failed to close voice audio", err));
		}
	}

	/** Phones suspend audio when interrupted, a call for example. */
	resume(): void {
		if (this.context && this.context.state !== "running") {
			void this.context
				.resume()
				.catch(err => console.warn("Failed to resume voice audio", err));
		}
	}

	playFrame(pcm: ArrayBuffer): void {
		this.player?.port.postMessage(pcm, [pcm]);
	}

	resetPlayback(): void {
		this.player?.port.postMessage("reset");
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		if (this.gain) {
			this.gain.gain.value = muted ? 0 : 1;
		}
	}

	/** Open the mic, muted, if it is not open already. */
	acquireMic(): Promise<MicResult> {
		this.cancelWarmTimer();
		if (this.stream) {
			return Promise.resolve("ready");
		}
		this.micRequest ??= this.requestMic().finally(() => {
			this.micRequest = null;
		});
		return this.micRequest;
	}

	private async requestMic(): Promise<MicResult> {
		if (!navigator.mediaDevices?.getUserMedia) {
			return "none";
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					channelCount: 1,
				},
			});
			if (!this.context || !this.capture) {
				for (const track of stream.getTracks()) {
					track.stop();
				}
				return "none";
			}
			for (const track of stream.getAudioTracks()) {
				track.enabled = false;
				// The system took the mic or it was unplugged: the next press opens it again.
				track.addEventListener("ended", () => this.releaseMic());
			}
			this.stream = stream;
			this.micSource = this.context.createMediaStreamSource(stream);
			this.micSource.connect(this.capture);
			return "ready";
		} catch (err) {
			return micResultFromError(err);
		}
	}

	setMicLive(live: boolean): void {
		if (live) {
			this.cancelWarmTimer();
		}
		for (const track of this.stream?.getAudioTracks() ?? []) {
			track.enabled = live;
		}
		this.capture?.port.postMessage({ live });
	}

	releaseMicSoon(): void {
		this.cancelWarmTimer();
		if (this.stream) {
			this.warmTimer = setTimeout(() => this.releaseMic(), MIC_WARM_MS);
		}
	}

	private cancelWarmTimer(): void {
		if (this.warmTimer) {
			clearTimeout(this.warmTimer);
			this.warmTimer = null;
		}
	}

	private releaseMic(): void {
		this.cancelWarmTimer();
		this.capture?.port.postMessage({ live: false });
		this.micSource?.disconnect();
		this.micSource = null;
		for (const track of this.stream?.getTracks() ?? []) {
			track.stop();
		}
		this.stream = null;
	}
}

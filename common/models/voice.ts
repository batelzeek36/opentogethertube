/**
 * Shared definitions for hold-to-talk voice channels.
 *
 * Audio travels as binary websocket messages holding one frame each: a short header, then 20 ms of
 * 16 kHz mono 16-bit little-endian PCM. Everything else about voice is ordinary JSON.
 */
export const VOICE_CHANNELS = ["main", "side"] as const;

export type VoiceChannelId = (typeof VOICE_CHANNELS)[number];

export function isVoiceChannel(value: unknown): value is VoiceChannelId {
	return VOICE_CHANNELS.includes(value as VoiceChannelId);
}

export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_FRAME_SAMPLES = 320;
export const VOICE_FRAME_MS = (VOICE_FRAME_SAMPLES / VOICE_SAMPLE_RATE) * 1000;
export const VOICE_FRAME_MAGIC = 0x56;
export const VOICE_FRAME_VERSION = 1;
export const VOICE_FRAME_HEADER_BYTES = 2;
export const VOICE_FRAME_BYTES = VOICE_FRAME_HEADER_BYTES + VOICE_FRAME_SAMPLES * 2;

/** Frames a client may sustain per second. Real-time is 50, the margin covers clock drift. */
export const VOICE_MAX_FRAMES_PER_SECOND = 60;
/** Frames a client may send at once after a stall on the network, half a second of audio. */
export const VOICE_FRAME_BURST = 25;

/** The size and header are the whole contract of a frame: any 16-bit samples are valid audio. */
export function isValidVoiceFrame(frame: Uint8Array): boolean {
	return (
		frame.byteLength === VOICE_FRAME_BYTES &&
		frame[0] === VOICE_FRAME_MAGIC &&
		frame[1] === VOICE_FRAME_VERSION
	);
}

export const VOICE_RULE_DEFAULTS = {
	voiceEnabled: true,
	voiceMaxTalkSeconds: 10,
	voiceSlowModeSeconds: 0,
} as const;

export const VOICE_MAX_TALK_SECONDS_MIN = 3;
export const VOICE_MAX_TALK_SECONDS_MAX = 120;
export const VOICE_SLOW_MODE_SECONDS_MIN = 0;
export const VOICE_SLOW_MODE_SECONDS_MAX = 300;

export interface VoiceRules {
	voiceEnabled: boolean;
	voiceMaxTalkSeconds: number;
	voiceSlowModeSeconds: number;
}

export type VoiceJoinRefusal = "voice-off" | "removed" | "invalid-channel" | "unsupported";
export type VoiceTalkRefusal = "voice-off" | "not-in-channel" | "busy" | "cooldown";
export type VoiceTurnEnd = "released" | "limit" | "left" | "removed" | "voice-off";

export type VoiceYouEvent =
	| { event: "talk-granted"; maxTalkMs: number }
	| { event: "talk-refused"; reason: VoiceTalkRefusal; cooldownMs: number }
	| { event: "talk-ended"; reason: VoiceTurnEnd; cooldownMs: number }
	| { event: "cooldown"; cooldownMs: number }
	| { event: "join-refused"; reason: VoiceJoinRefusal };

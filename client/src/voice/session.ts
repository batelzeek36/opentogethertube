import {
	computed,
	inject,
	type InjectionKey,
	onUnmounted,
	provide,
	ref,
	shallowRef,
	watch,
} from "vue";
import {
	RoomRequestType,
	type RoomRequest,
	type ServerMessage,
	type ServerMessageVoice,
} from "ott-common/models/messages";
import {
	VOICE_FRAME_BURST,
	VOICE_FRAME_HEADER_BYTES,
	type VoiceChannelId,
	type VoiceJoinRefusal,
	isValidVoiceFrame,
} from "ott-common/models/voice";
import type { ClientId } from "ott-common/models/types";
import { chatOpen } from "@/components/chat-state";
import { useVolumeDuck } from "@/components/composables/media-player";
import type { OttRoomConnection } from "@/plugins/connection";
import { useConnection } from "@/plugins/connection";
import { type FullOTTStoreState, useStore } from "@/store";
import type { Store } from "vuex";
import { type MicResult, VoiceAudio, type VoiceAudioDevice } from "./audio";

/** How far the movie drops while someone talks: a quarter of the person's own volume. */
const DUCK_LEVEL = 0.25;
const DUCK_RAMP_STEPS = 5;
const DUCK_RAMP_STEP_MS = 30;

export type VoiceMicState = "unknown" | MicResult;

/** The one thing to tell the person about voice right now, if anything. */
export type VoiceNotice =
	| "off"
	| "disconnected"
	| "removed"
	| "unsupported"
	| "unavailable"
	| "mic-denied"
	| "no-mic"
	| "cut-off";

export type VoiceSession = ReturnType<typeof createVoiceSession>;

/**
 * Everything voice does in one room view: membership, the talk button's state, and tying the
 * network to the audio device. The server decides who may talk. This only follows what it says.
 */
export function createVoiceSession(deps: {
	connection: OttRoomConnection;
	store: Store<FullOTTStoreState>;
	audio?: VoiceAudioDevice;
}) {
	const { connection, store } = deps;
	const audio = deps.audio ?? new VoiceAudio();
	const duck = useVolumeDuck();

	const channels = shallowRef<ServerMessageVoice["channels"]>([]);
	const removedIds = shallowRef<ClientId[]>([]);
	const micState = ref<VoiceMicState>("unknown");
	const holding = ref(false);
	const talking = ref(false);
	const micWaiting = ref(false);
	const cutOff = ref(false);
	const unsupported = ref(false);
	const joinRefusal = ref<VoiceJoinRefusal | null>(null);
	const talkEndsAt = ref(0);
	const cooldownEndsAt = ref(0);
	const now = ref(Date.now());

	let audioOpen = false;
	let rejoinChannel: VoiceChannelId | null = null;
	let floorGranted = false;
	/** Audio captured between pressing and the server's answer, so the first word is not lost. */
	let framesBeforeGrant: ArrayBuffer[] = [];

	const myId = computed(() => store.state.users.you.id);
	const myChannel = computed<VoiceChannelId | null>(
		() => channels.value.find(c => c.members.includes(myId.value))?.id ?? null,
	);
	const speakerInMyChannel = computed(
		() => channels.value.find(c => c.id === myChannel.value)?.speaker ?? null,
	);
	const otherSpeaker = computed(() =>
		speakerInMyChannel.value !== myId.value ? speakerInMyChannel.value : null,
	);
	const muted = computed(() => store.state.settings.voiceMuted);
	const enabled = computed(() => store.state.room.voiceEnabled);
	const isRemoved = computed(() => removedIds.value.includes(myId.value));
	const cooldownSeconds = computed(() =>
		Math.max(0, Math.ceil((cooldownEndsAt.value - now.value) / 1000)),
	);
	const talkSecondsLeft = computed(() =>
		Math.max(0, Math.ceil((talkEndsAt.value - now.value) / 1000)),
	);
	const canTalk = computed(
		() =>
			connection.connected.value &&
			enabled.value &&
			myChannel.value !== null &&
			otherSpeaker.value === null &&
			cooldownSeconds.value === 0 &&
			(micState.value === "ready" || micState.value === "unknown"),
	);
	const notice = computed<VoiceNotice | null>(() => {
		if (!connection.connected.value) {
			return "disconnected";
		}
		if (!enabled.value) {
			return "off";
		}
		if (isRemoved.value) {
			return "removed";
		}
		if (joinRefusal.value === "unsupported") {
			return "unavailable";
		}
		if (unsupported.value) {
			return "unsupported";
		}
		if (myChannel.value === null) {
			return null;
		}
		if (micState.value === "denied") {
			return "mic-denied";
		}
		if (micState.value === "none") {
			return "no-mic";
		}
		return cutOff.value ? "cut-off" : null;
	});

	function sendRequest(request: RoomRequest) {
		if (connection.connected.value) {
			connection.send({ action: "req", request });
		}
	}

	async function join(channel: VoiceChannelId) {
		joinRefusal.value = null;
		try {
			await audio.open();
		} catch (err) {
			console.warn("Voice is not available in this browser", err);
			unsupported.value = true;
			return;
		}
		audioOpen = true;
		audio.setMuted(muted.value);
		sendRequest({ type: RoomRequestType.VoiceJoinRequest, channel });
		await prepareMic();
		// Asked for now so the first press is ready, but not kept open: an open Bluetooth mic
		// drops the earbuds into call quality, which takes the movie's sound with it.
		if (!holding.value) {
			audio.releaseMicSoon();
		}
	}

	function leave() {
		rejoinChannel = null;
		release();
		sendRequest({ type: RoomRequestType.VoiceLeaveRequest });
		closeAudio();
	}

	/** Ask for the mic. Asking at Join means the first press does not stop for a permission prompt. */
	async function prepareMic(): Promise<MicResult> {
		const result = await audio.acquireMic();
		micState.value = result;
		if (!holding.value) {
			audio.releaseMicSoon();
		}
		return result;
	}

	function press() {
		if (holding.value || !canTalk.value) {
			return;
		}
		holding.value = true;
		cutOff.value = false;
		floorGranted = false;
		framesBeforeGrant = [];
		audio.resume();
		sendRequest({ type: RoomRequestType.VoiceTalkRequest, talking: true });
		micWaiting.value = true;
		void prepareMic().then(result => {
			micWaiting.value = false;
			if (result !== "ready") {
				release();
			} else if (holding.value) {
				audio.setMicLive(true);
			}
		});
	}

	function stopHolding() {
		holding.value = false;
		talking.value = false;
		micWaiting.value = false;
		floorGranted = false;
		framesBeforeGrant = [];
		audio.setMicLive(false);
		audio.releaseMicSoon();
	}

	/** Let go of the talk button. Safe to call any number of times, for any reason. */
	function release() {
		if (!holding.value) {
			return;
		}
		stopHolding();
		sendRequest({ type: RoomRequestType.VoiceTalkRequest, talking: false });
	}

	function closeAudio() {
		if (holding.value) {
			stopHolding();
		}
		audio.close();
		audioOpen = false;
		micState.value = "unknown";
		cutOff.value = false;
		talkEndsAt.value = 0;
	}

	function toggleMuted() {
		const next = !muted.value;
		store.commit("settings/UPDATE", { voiceMuted: next });
		audio.setMuted(next);
	}

	function removeFromVoice(clientId: ClientId) {
		sendRequest({ type: RoomRequestType.VoiceRemoveRequest, clientId });
	}

	function allowBack(clientId: ClientId) {
		sendRequest({ type: RoomRequestType.VoiceAllowRequest, clientId });
	}

	audio.onFrame = frame => {
		if (!holding.value) {
			return;
		}
		if (floorGranted) {
			connection.sendBinary(frame);
		} else {
			framesBeforeGrant.push(frame);
			if (framesBeforeGrant.length > VOICE_FRAME_BURST) {
				framesBeforeGrant.shift();
			}
		}
	};

	function onBinary(data: ArrayBuffer) {
		if (myChannel.value === null || !isValidVoiceFrame(new Uint8Array(data))) {
			return;
		}
		audio.playFrame(data.slice(VOICE_FRAME_HEADER_BYTES));
	}

	function onVoiceMessage(msg: ServerMessage) {
		if (msg.action === "voice") {
			channels.value = msg.channels;
			removedIds.value = msg.removed;
		}
	}

	function setCooldown(ms: number) {
		now.value = Date.now();
		cooldownEndsAt.value = ms > 0 ? now.value + ms : 0;
	}

	function onVoiceYou(msg: ServerMessage) {
		if (msg.action !== "voice-you") {
			return;
		}
		switch (msg.event) {
			case "talk-granted":
				if (holding.value) {
					floorGranted = true;
					talking.value = true;
					now.value = Date.now();
					talkEndsAt.value = now.value + msg.maxTalkMs;
					for (const frame of framesBeforeGrant) {
						connection.sendBinary(frame);
					}
					framesBeforeGrant = [];
				}
				break;
			case "talk-refused":
				setCooldown(msg.cooldownMs);
				if (holding.value) {
					stopHolding();
				}
				break;
			case "talk-ended":
				setCooldown(msg.cooldownMs);
				// "released" answers the person's own release, which may be older than a new press.
				if (msg.reason !== "released" && holding.value) {
					stopHolding();
					cutOff.value = msg.reason === "limit";
				}
				break;
			case "cooldown":
				setCooldown(msg.cooldownMs);
				break;
			case "join-refused":
				joinRefusal.value = msg.reason;
				rejoinChannel = null;
				if (myChannel.value === null && audioOpen) {
					closeAudio();
				}
				break;
		}
	}

	/** The server has finished letting this client back into the room after a reconnect. */
	function onYou() {
		if (rejoinChannel !== null) {
			sendRequest({ type: RoomRequestType.VoiceJoinRequest, channel: rejoinChannel });
			rejoinChannel = null;
		}
	}

	connection.addMessageHandler("voice", onVoiceMessage);
	connection.addMessageHandler("voice-you", onVoiceYou);
	connection.addMessageHandler("you", onYou);
	connection.setBinaryHandler(onBinary);

	// Taken out of voice by anything other than this client's own Leave: the mod, or voice turning off.
	watch(
		myChannel,
		(channel, previous) => {
			if (channel === null && previous !== null && connection.connected.value && audioOpen) {
				closeAudio();
			}
		},
		{ flush: "sync" },
	);
	watch(
		speakerInMyChannel,
		speaker => {
			// Not when a turn ends: what is still buffered is the end of what they said.
			if (speaker !== null && audioOpen) {
				audio.resetPlayback();
			}
		},
		{ flush: "sync" },
	);

	watch(connection.connected, connected => {
		if (!connected) {
			rejoinChannel = myChannel.value;
			if (holding.value) {
				stopHolding();
			}
			channels.value = [];
			removedIds.value = [];
		}
	});

	// The movie dips for anyone talking in this person's channel, unless they have silenced voice.
	// Only the multiplier moves: the person's volume itself is never touched, so it comes back exact.
	const shouldDuck = computed(
		() =>
			speakerInMyChannel.value !== null &&
			(speakerInMyChannel.value === myId.value || !muted.value),
	);
	let duckTimer: ReturnType<typeof setInterval> | null = null;
	function rampDuck(target: number) {
		if (duckTimer) {
			clearInterval(duckTimer);
		}
		const start = duck.value;
		let step = 0;
		duckTimer = setInterval(() => {
			step++;
			if (step >= DUCK_RAMP_STEPS) {
				duck.value = target;
				if (duckTimer) {
					clearInterval(duckTimer);
				}
				duckTimer = null;
			} else {
				duck.value = start + ((target - start) * step) / DUCK_RAMP_STEPS;
			}
		}, DUCK_RAMP_STEP_MS);
	}
	// Silent for the person talking, or their mic carries the movie and it sounds like an echo.
	const duckTarget = computed(() => {
		if (!shouldDuck.value) {
			return 1;
		}
		return speakerInMyChannel.value === myId.value ? 0 : DUCK_LEVEL;
	});
	watch(duckTarget, rampDuck);

	// Nothing may leave a finger stuck on talk: a finger sliding off is handled by the button itself,
	// the page going away by these, and opening the chat hides the button.
	const onHidden = () => {
		if (document.visibilityState === "hidden") {
			release();
		}
	};
	window.addEventListener("blur", release);
	window.addEventListener("pagehide", release);
	document.addEventListener("visibilitychange", onHidden);
	watch(chatOpen, open => {
		if (open) {
			release();
		}
	});

	const ticker = setInterval(() => {
		if (myChannel.value !== null) {
			now.value = Date.now();
		}
	}, 200);

	function dispose() {
		clearInterval(ticker);
		if (duckTimer) {
			clearInterval(duckTimer);
		}
		duck.value = 1;
		window.removeEventListener("blur", release);
		window.removeEventListener("pagehide", release);
		document.removeEventListener("visibilitychange", onHidden);
		connection.removeMessageHandler("voice", onVoiceMessage);
		connection.removeMessageHandler("voice-you", onVoiceYou);
		connection.removeMessageHandler("you", onYou);
		connection.setBinaryHandler(null);
		audio.onFrame = null;
		closeAudio();
	}

	return {
		channels,
		removedIds,
		micState,
		holding,
		talking,
		micWaiting,
		cutOff,
		enabled,
		muted,
		myId,
		myChannel,
		speakerInMyChannel,
		otherSpeaker,
		isRemoved,
		canTalk,
		cooldownSeconds,
		talkSecondsLeft,
		notice,
		join,
		leave,
		press,
		release,
		prepareMic,
		toggleMuted,
		removeFromVoice,
		allowBack,
		dispose,
	};
}

const voiceSessionKey: InjectionKey<VoiceSession> = Symbol("ott:voice");

/** Start voice for a room view. Its children reach it with useVoice(). */
export function provideVoice(): VoiceSession {
	const session = createVoiceSession({ connection: useConnection(), store: useStore() });
	provide(voiceSessionKey, session);
	onUnmounted(session.dispose);
	return session;
}

export function useVoice(): VoiceSession {
	const session = inject(voiceSessionKey);
	if (!session) {
		throw new Error("No voice session, did you forget provideVoice()?");
	}
	return session;
}

export { voiceSessionKey };

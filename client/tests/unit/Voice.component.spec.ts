import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, provide } from "vue";
import { RoomRequestType, type ServerMessage } from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import { Grants } from "ott-common/permissions";
import { VOICE_FRAME_BYTES, VOICE_FRAME_MAGIC, VOICE_FRAME_VERSION } from "ott-common/models/voice";
import VoicePanel from "@/components/VoicePanel.vue";
import VoiceTalkButton from "@/components/VoiceTalkButton.vue";
import { chatOpen } from "@/components/chat-state";
import { useVolumeDuck } from "@/components/composables/media-player";
import { type OttRoomConnectionMock, useConnection } from "@/plugins/connection";
import { useStore } from "@/store";
import type { MicResult, VoiceAudioDevice } from "@/voice/audio";
import { createVoiceSession, type VoiceSession, voiceSessionKey } from "@/voice/session";
import { flush, mountComponent } from "./component-test-utils";

function fakeAudio(micResult: MicResult = "ready") {
	const audio = {
		onFrame: null,
		micResult,
		live: false,
		muted: false,
		played: [] as ArrayBuffer[],
		resets: 0,
		closed: 0,
		releasedSoon: 0,
		open: vi.fn(async () => undefined),
		close: vi.fn(() => {
			audio.closed++;
		}),
		resume: vi.fn(),
		playFrame: (pcm: ArrayBuffer) => audio.played.push(pcm),
		resetPlayback: () => {
			audio.resets++;
		},
		setMuted: (muted: boolean) => {
			audio.muted = muted;
		},
		acquireMic: vi.fn(async () => audio.micResult),
		setMicLive: (live: boolean) => {
			audio.live = live;
		},
		releaseMicSoon: () => {
			audio.releasedSoon++;
		},
	} satisfies VoiceAudioDevice & Record<string, unknown>;
	return audio;
}

type Audio = ReturnType<typeof fakeAudio>;

function frame(): ArrayBuffer {
	const bytes = new Uint8Array(VOICE_FRAME_BYTES);
	bytes[0] = VOICE_FRAME_MAGIC;
	bytes[1] = VOICE_FRAME_VERSION;
	return bytes.buffer;
}

function voiceMsg(
	main: string[],
	side: string[] = [],
	speaker: string | null = null,
	removed: string[] = [],
) {
	return {
		action: "voice",
		channels: [
			{ id: "main", members: main, speaker },
			{ id: "side", members: side, speaker: null },
		],
		removed,
	} as ServerMessage;
}

function setup(options: { audio?: Audio; role?: Role } = {}) {
	const audio = options.audio ?? fakeAudio();
	let session = null as unknown as VoiceSession;
	const Host = defineComponent({
		setup() {
			session = createVoiceSession({ connection: useConnection(), store: useStore(), audio });
			provide(voiceSessionKey, session);
			return () => h("div", [h(VoicePanel), h(VoiceTalkButton, { floating: true })]);
		},
	});
	const { wrapper, store, connection } = mountComponent(Host);
	connection.connected.value = true;
	const user = (id: string, name: string, role = Role.UnregisteredUser) => ({
		id,
		name,
		isLoggedIn: false,
		status: PlayerStatus.ready,
		role,
	});
	store.state.users.you.id = "me";
	store.state.users.users.set("me", user("me", "Zach", options.role ?? Role.UnregisteredUser));
	store.state.users.users.set("mom", user("mom", "Mom"));
	store.state.users.users.set("sis", user("sis", "Sis"));
	store.state.room.grants = new Grants();
	store.state.room.voiceEnabled = true;
	store.state.settings.voiceMuted = false;
	connection.mockReceive(voiceMsg([]));
	return { wrapper, store, connection, audio, session: () => session };
}

function talkRequests(connection: OttRoomConnectionMock) {
	return connection.sent.flatMap(msg =>
		msg.action === "req" && msg.request.type === RoomRequestType.VoiceTalkRequest
			? [msg.request.talking]
			: [],
	);
}

describe("voice", () => {
	beforeEach(() => {
		chatOpen.value = false;
		useVolumeDuck().value = 1;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("joining", () => {
		it("starts out, with nothing heard until joining", async () => {
			const { wrapper, audio, connection } = setup();
			await flush();
			expect(wrapper.find('[data-cy="voice-talk"]').exists()).toEqual(true); // floating, disabled
			expect(wrapper.get('[data-cy="voice-join-main"]').text()).toContain("Main");
			connection.binaryHandler?.(frame());
			expect(audio.played).toEqual([]);
			expect(audio.open).not.toHaveBeenCalled();
		});

		it("opens audio, asks for the mic and joins on one tap", async () => {
			const { wrapper, audio, connection } = setup();
			await flush();
			await wrapper.get('[data-cy="voice-join-side"]').trigger("click");
			await flush();
			expect(audio.open).toHaveBeenCalled();
			expect(audio.acquireMic).toHaveBeenCalled();
			expect(connection.sent).toContainEqual({
				action: "req",
				request: { type: RoomRequestType.VoiceJoinRequest, channel: "side" },
			});
			expect(audio.live).toEqual(false);
		});

		it("shows who is in each channel and who is talking", async () => {
			const { wrapper, connection } = setup();
			connection.mockReceive(voiceMsg(["mom", "sis"], [], "mom"));
			await flush();
			const main = wrapper.get('[data-cy="voice-channel-main"]');
			expect(main.text()).toContain("Mom");
			expect(main.text()).toContain("Sis");
			expect(main.get('[data-speaking="true"]').text()).toContain("Mom");
		});

		it("plays frames only while a member", async () => {
			const { audio, connection } = setup();
			connection.mockReceive(voiceMsg(["me", "mom"]));
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(1);
			connection.mockReceive(voiceMsg(["mom"]));
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(1);
		});

		it("drops a malformed frame", () => {
			const { audio, connection } = setup();
			connection.mockReceive(voiceMsg(["me"]));
			connection.binaryHandler?.(new ArrayBuffer(10));
			expect(audio.played).toEqual([]);
		});

		it("closes audio and tells the server on Leave", async () => {
			const { wrapper, audio, connection } = setup();
			connection.mockReceive(voiceMsg(["me"]));
			await flush();
			await wrapper.get('[data-cy="voice-leave"]').trigger("click");
			expect(audio.closed).toEqual(1);
			expect(connection.sent).toContainEqual({
				action: "req",
				request: { type: RoomRequestType.VoiceLeaveRequest },
			});
		});
	});

	describe("hold to talk", () => {
		async function joined(audio?: Audio) {
			const ctx = setup({ audio });
			await ctx.session().join("main");
			ctx.connection.mockReceive(voiceMsg(["me", "mom"]));
			await flush();
			const button = ctx.wrapper.findAll('[data-cy="voice-talk"]')[0];
			return { ...ctx, button };
		}
		const down = (button: { trigger: (e: string, o?: object) => Promise<void> }) =>
			button.trigger("pointerdown", { pointerId: 1, pointerType: "touch", button: 0 });

		it("is only live while held, and answers the press before audio flows", async () => {
			const { button, audio, connection } = await joined();
			expect(audio.live).toEqual(false);
			await down(button);
			await flush();
			expect(audio.live).toEqual(true);
			expect(talkRequests(connection)).toEqual([true]);

			// captured before the answer, kept back until the server says yes
			audio.onFrame?.(frame());
			expect(connection.sentBinary).toHaveLength(0);
			connection.mockReceive({
				action: "voice-you",
				event: "talk-granted",
				maxTalkMs: 10000,
			});
			expect(connection.sentBinary).toHaveLength(1);
			audio.onFrame?.(frame());
			expect(connection.sentBinary).toHaveLength(2);

			window.dispatchEvent(new Event("pointerup"));
			expect(audio.live).toEqual(false);
			expect(talkRequests(connection)).toEqual([true, false]);
			audio.onFrame?.(frame());
			expect(connection.sentBinary).toHaveLength(2);
		});

		it.each([
			["the finger is released anywhere", () => window.dispatchEvent(new Event("pointerup"))],
			[
				"the browser only reports touchend",
				() => window.dispatchEvent(new Event("touchend")),
			],
			[
				"the browser reports touchcancel",
				() => window.dispatchEvent(new Event("touchcancel")),
			],
			[
				"the browser cancels the touch",
				() => window.dispatchEvent(new Event("pointercancel")),
			],
			["the tab loses focus", () => window.dispatchEvent(new Event("blur"))],
			["the page goes away", () => window.dispatchEvent(new Event("pagehide"))],
			[
				"the tab is hidden",
				() => {
					vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
					document.dispatchEvent(new Event("visibilitychange"));
					vi.restoreAllMocks();
				},
			],
			[
				"the chat opens",
				() => {
					chatOpen.value = true;
				},
			],
		])("lets go when %s", async (_name, trigger) => {
			const { button, audio, connection, session } = await joined();
			await down(button);
			await flush();
			trigger();
			await flush();
			expect(session().holding.value).toEqual(false);
			expect(audio.live).toEqual(false);
			expect(talkRequests(connection)).toEqual([true, false]);
		});

		it("does not keep talking if the release came before the answer", async () => {
			const { button, audio, connection, session } = await joined();
			await down(button);
			await flush();
			window.dispatchEvent(new Event("pointerup"));
			connection.mockReceive({
				action: "voice-you",
				event: "talk-granted",
				maxTalkMs: 10000,
			});
			expect(session().talking.value).toEqual(false);
			audio.onFrame?.(frame());
			expect(connection.sentBinary).toHaveLength(0);
		});

		it("works from the keyboard without triggering play/pause", async () => {
			const { button, connection } = await joined();
			const seen = vi.fn();
			window.addEventListener("keydown", seen);
			await button.trigger("keydown", { code: "Space" });
			await flush();
			await button.trigger("keyup", { code: "Space" });
			window.removeEventListener("keydown", seen);
			expect(seen).not.toHaveBeenCalled();
			expect(talkRequests(connection)).toEqual([true, false]);
		});

		it("prevents the long-press menu", async () => {
			const { button } = await joined();
			const e = new Event("contextmenu", { cancelable: true });
			button.element.dispatchEvent(e);
			expect(e.defaultPrevented).toEqual(true);
		});

		it("is disabled while someone else talks, naming them", async () => {
			const { connection, button, wrapper } = await joined();
			connection.mockReceive(voiceMsg(["me", "mom"], [], "mom"));
			await flush();
			expect((button.element as HTMLButtonElement).disabled).toEqual(true);
			expect(button.text()).toContain("Mom is talking");
			connection.mockReceive(voiceMsg(["me", "mom"]));
			await flush();
			expect((button.element as HTMLButtonElement).disabled).toEqual(false);
			expect(wrapper.text()).toContain("Hold to talk");
		});

		it("clears a refused press, showing who has the floor", async () => {
			const { button, connection, audio, session } = await joined();
			await down(button);
			await flush();
			connection.mockReceive({
				action: "voice-you",
				event: "talk-refused",
				reason: "busy",
				cooldownMs: 0,
			});
			expect(session().holding.value).toEqual(false);
			expect(audio.live).toEqual(false);
		});

		it("shows the cut off and needs a new press", async () => {
			const { button, connection, audio, wrapper, session } = await joined();
			await down(button);
			await flush();
			connection.mockReceive({
				action: "voice-you",
				event: "talk-granted",
				maxTalkMs: 10000,
			});
			connection.mockReceive({
				action: "voice-you",
				event: "talk-ended",
				reason: "limit",
				cooldownMs: 0,
			});
			await flush();
			expect(audio.live).toEqual(false);
			expect(wrapper.get('[data-cy="voice-notice"]').attributes("data-notice")).toEqual(
				"cut-off",
			);
			window.dispatchEvent(new Event("pointerup"));
			expect(session().holding.value).toEqual(false);
			expect(talkRequests(connection)).toEqual([true]);
		});

		it("counts the cooldown down and refuses to press during it", async () => {
			vi.useFakeTimers();
			const { button, connection, session } = await joined();
			connection.mockReceive({ action: "voice-you", event: "cooldown", cooldownMs: 3000 });
			await flush();
			expect(button.text()).toContain("Wait 3s");
			expect((button.element as HTMLButtonElement).disabled).toEqual(true);
			session().press();
			expect(talkRequests(connection)).toEqual([]);
			await vi.advanceTimersByTimeAsync(1200);
			expect(button.text()).toContain("Wait 2s");
			await vi.advanceTimersByTimeAsync(2000);
			expect(button.text()).toContain("Hold to talk");
			expect((button.element as HTMLButtonElement).disabled).toEqual(false);
		});

		it("drops the turn when the mic turns out to be unavailable", async () => {
			const audio = fakeAudio("ready");
			const { button, connection, wrapper } = await joined(audio);
			audio.micResult = "denied";
			await down(button);
			await flush();
			await flush();
			expect(talkRequests(connection)).toEqual([true, false]);
			expect(audio.live).toEqual(false);
			expect(wrapper.get('[data-cy="voice-notice"]').attributes("data-notice")).toEqual(
				"mic-denied",
			);
		});
	});

	describe("notices", () => {
		const notice = (wrapper: { get: (s: string) => { attributes: (a: string) => unknown } }) =>
			wrapper.get('[data-cy="voice-notice"]').attributes("data-notice");

		it("lets someone listen when the mic is denied, and offers another try", async () => {
			const audio = fakeAudio("denied");
			const { wrapper, session, connection } = setup({ audio });
			await session().join("main");
			connection.mockReceive(voiceMsg(["me"]));
			await flush();
			expect(notice(wrapper)).toEqual("mic-denied");
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(1);
			const talk = wrapper.findAll('[data-cy="voice-talk"]')[0];
			expect((talk.element as HTMLButtonElement).disabled).toEqual(true);

			audio.micResult = "ready";
			await wrapper.get('[data-cy="voice-mic-retry"]').trigger("click");
			await flush();
			expect(wrapper.find('[data-cy="voice-notice"]').exists()).toEqual(false);
			expect((talk.element as HTMLButtonElement).disabled).toEqual(false);
		});

		it("says when there is no mic", async () => {
			const { wrapper, session, connection } = setup({ audio: fakeAudio("none") });
			await session().join("main");
			connection.mockReceive(voiceMsg(["me"]));
			await flush();
			expect(notice(wrapper)).toEqual("no-mic");
		});

		it("says voice is off and offers no way in", async () => {
			const { wrapper, store } = setup();
			store.state.room.voiceEnabled = false;
			await flush();
			expect(notice(wrapper)).toEqual("off");
			expect(wrapper.find('[data-cy="voice-join-main"]').exists()).toEqual(false);
		});

		it("closes audio when the mod turns voice off", async () => {
			const { wrapper, store, connection, audio } = setup();
			await flush();
			await wrapper.get('[data-cy="voice-join-main"]').trigger("click");
			await flush();
			connection.mockReceive(voiceMsg(["me"]));
			store.state.room.voiceEnabled = false;
			connection.mockReceive(voiceMsg([]));
			await flush();
			expect(audio.closed).toEqual(1);
			expect(notice(wrapper)).toEqual("off");
		});

		it("says when removed, closes audio, and offers no way in", async () => {
			const { wrapper, connection, audio, session } = setup();
			await session().join("main");
			connection.mockReceive(voiceMsg(["me"]));
			connection.mockReceive(voiceMsg([], [], null, ["me"]));
			await flush();
			expect(audio.closed).toEqual(1);
			expect(notice(wrapper)).toEqual("removed");
			expect(wrapper.find('[data-cy="voice-join-main"]').exists()).toEqual(false);
		});

		it("says when disconnected, stops talking, and rejoins after reconnecting", async () => {
			const { wrapper, connection, audio, session, store } = setup();
			await session().join("main");
			connection.mockReceive(voiceMsg(["me"]));
			await flush();
			await wrapper
				.findAll('[data-cy="voice-talk"]')[0]
				.trigger("pointerdown", { pointerId: 1, pointerType: "touch" });
			await flush();
			connection.connected.value = false;
			await flush();
			expect(notice(wrapper)).toEqual("disconnected");
			expect(audio.live).toEqual(false);
			expect(audio.closed).toEqual(0);

			connection.mockReset();
			connection.connected.value = true;
			store.state.users.you.id = "me-again";
			connection.mockReceive({ action: "you", info: { id: "me-again" } });
			expect(connection.sent).toContainEqual({
				action: "req",
				request: { type: RoomRequestType.VoiceJoinRequest, channel: "main" },
			});
		});

		it("says when the server cannot do voice", async () => {
			const { wrapper, connection, session } = setup();
			await session().join("main");
			connection.mockReceive({
				action: "voice-you",
				event: "join-refused",
				reason: "unsupported",
			});
			await flush();
			expect(notice(wrapper)).toEqual("unavailable");
		});

		it("says when the browser cannot do voice", async () => {
			const audio = fakeAudio();
			audio.open.mockRejectedValue(new Error("no worklets"));
			const { wrapper, session } = setup({ audio });
			await session().join("main");
			await flush();
			expect(notice(wrapper)).toEqual("unsupported");
		});
	});

	describe("personal mute", () => {
		it("silences this device only, and remembers it", async () => {
			const { wrapper, connection, audio, store, session } = setup();
			await session().join("main");
			connection.mockReceive(voiceMsg(["me"]));
			await flush();
			await wrapper.get('[data-cy="voice-mute"]').trigger("click");
			expect(audio.muted).toEqual(true);
			expect(store.state.settings.voiceMuted).toEqual(true);
			const voiceRequests = connection.sent.filter(
				m => m.action === "req" && m.request.type === RoomRequestType.VoiceTalkRequest,
			);
			expect(voiceRequests).toEqual([]);
			await wrapper.get('[data-cy="voice-mute"]').trigger("click");
			expect(audio.muted).toEqual(false);
		});
	});

	describe("muting one person on this device", () => {
		afterEach(() => {
			sessionStorage.clear();
		});

		it("stops their audio here until tapped again, and leaves others alone", async () => {
			vi.useFakeTimers();
			const { wrapper, connection, audio } = setup();
			connection.mockReceive(voiceMsg(["me", "mom", "sis"], [], "mom"));
			await vi.advanceTimersByTimeAsync(0);
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(1);

			const mom = () =>
				wrapper.findAll('[data-cy="voice-person"]').find(p => p.text().includes("Mom"))!;
			await mom().trigger("click");
			expect(mom().attributes("aria-pressed")).toBe("true");
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(1);

			connection.mockReceive(voiceMsg(["me", "mom", "sis"], [], "sis"));
			await vi.advanceTimersByTimeAsync(0);
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(2);

			connection.mockReceive(voiceMsg(["me", "mom", "sis"], [], "mom"));
			await vi.advanceTimersByTimeAsync(0);
			await mom().trigger("click");
			connection.binaryHandler?.(frame());
			expect(audio.played).toHaveLength(3);

			connection.mockReceive(voiceMsg(["me", "mom", "sis"]));
			await vi.advanceTimersByTimeAsync(300);
		});
	});

	describe("movie volume", () => {
		it("dips while someone in the channel talks and returns to exactly 1", async () => {
			vi.useFakeTimers();
			const duck = useVolumeDuck();
			const { connection } = setup();
			connection.mockReceive(voiceMsg(["me", "mom"], [], "mom"));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(0.25);
			connection.mockReceive(voiceMsg(["me", "mom"]));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(1);
		});

		it("does not dip for a channel the person is not in", async () => {
			vi.useFakeTimers();
			const duck = useVolumeDuck();
			const { connection } = setup();
			connection.mockReceive(voiceMsg(["mom"], ["me"], "mom"));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(1);
		});

		it("does not dip for someone else when voice is silenced here, but does for your own turn", async () => {
			vi.useFakeTimers();
			const duck = useVolumeDuck();
			const { connection, store } = setup();
			store.state.settings.voiceMuted = true;
			connection.mockReceive(voiceMsg(["me", "mom"], [], "mom"));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(1);
			connection.mockReceive(voiceMsg(["me", "mom"], [], "me"));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(0);
		});

		it("silences the movie for the person talking, then restores it", async () => {
			vi.useFakeTimers();
			const duck = useVolumeDuck();
			const { connection } = setup();
			connection.mockReceive(voiceMsg(["me", "mom"], [], "me"));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(0);
			connection.mockReceive(voiceMsg(["me", "mom"]));
			await vi.advanceTimersByTimeAsync(300);
			expect(duck.value).toEqual(1);
		});
	});

	describe("mod controls", () => {
		it("are not offered to someone without the permission", async () => {
			const { wrapper, connection } = setup();
			connection.mockReceive(voiceMsg(["mom"]));
			await flush();
			expect(wrapper.find('[data-cy="voice-manage"]').exists()).toEqual(false);
		});

		it("remove someone and allow them back", async () => {
			const { wrapper, connection } = setup({ role: Role.Owner });
			connection.mockReceive(voiceMsg(["me", "mom"]));
			await flush();
			await wrapper.get('[data-cy="voice-manage"]').trigger("click");
			expect(wrapper.find('[data-cy="voice-remove-Zach"]').exists()).toEqual(false);
			await wrapper.get('[data-cy="voice-remove-Mom"]').trigger("click");
			expect(connection.sent).toContainEqual({
				action: "req",
				request: { type: RoomRequestType.VoiceRemoveRequest, clientId: "mom" },
			});
			connection.mockReceive(voiceMsg(["me"], [], null, ["mom"]));
			await flush();
			await wrapper.get('[data-cy="voice-allow-Mom"]').trigger("click");
			expect(connection.sent).toContainEqual({
				action: "req",
				request: { type: RoomRequestType.VoiceAllowRequest, clientId: "mom" },
			});
		});
	});

	describe("device icons", () => {
		it("shows each person's type in the roster with a label, and nothing when unknown", async () => {
			const { wrapper, store, connection } = setup();
			Object.assign(store.state.users.users.get("mom") ?? {}, { device: "phone" });
			Object.assign(store.state.users.users.get("me") ?? {}, { device: "computer" });
			connection.mockReceive(voiceMsg(["me", "mom", "sis"]));
			await flush();
			const icons = wrapper.findAll('[data-cy="device-icon"]');
			expect(icons.map(icon => icon.attributes("data-device"))).toEqual([
				"computer",
				"phone",
			]);
			expect(icons[1].attributes("aria-label")).toBe("On a phone");
			// Names are unchanged, and tapping a name still means the name.
			expect(wrapper.get('[data-cy="voice-roster"]').text()).toContain("Mom");
			expect(wrapper.findAll('[data-cy="voice-person"]')).toHaveLength(2);
		});
	});
});

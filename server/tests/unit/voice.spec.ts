import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessageVoice, ServerMessageVoiceYou } from "ott-common/models/messages.js";
import type { ClientId } from "ott-common/models/types.js";
import {
	VOICE_FRAME_BURST,
	VOICE_FRAME_BYTES,
	VOICE_FRAME_MAGIC,
	VOICE_FRAME_VERSION,
	VOICE_MAX_FRAMES_PER_SECOND,
	type VoiceChannelId,
	type VoiceRules,
} from "ott-common/models/voice.js";
import { VoiceChannels } from "../../voice.js";

function frame(): Uint8Array {
	const bytes = new Uint8Array(VOICE_FRAME_BYTES);
	bytes[0] = VOICE_FRAME_MAGIC;
	bytes[1] = VOICE_FRAME_VERSION;
	return bytes;
}

describe("VoiceChannels", () => {
	let rules: VoiceRules;
	let published: ServerMessageVoice[];
	let sent: Map<ClientId, ServerMessageVoiceYou[]>;
	let people: Map<ClientId, string>;
	let voice: VoiceChannels;

	const lastTo = (id: ClientId) => sent.get(id)?.at(-1);
	const lastState = () => published.at(-1) as ServerMessageVoice;
	const channel = (id: VoiceChannelId) =>
		lastState().channels.find(c => c.id === id) as ServerMessageVoice["channels"][number];

	beforeEach(() => {
		vi.useFakeTimers();
		rules = { voiceEnabled: true, voiceMaxTalkSeconds: 10, voiceSlowModeSeconds: 0 };
		published = [];
		sent = new Map();
		people = new Map([
			["a", "person-a"],
			["b", "person-b"],
			["c", "person-c"],
		]);
		voice = new VoiceChannels({
			rules: () => rules,
			publish: msg => published.push(msg),
			sendTo: (id, msg) => sent.set(id, [...(sent.get(id) ?? []), msg]),
			personKey: id => people.get(id),
			clientIds: () => [...people.keys()],
		});
	});

	afterEach(() => {
		voice.dispose();
		vi.useRealTimers();
	});

	describe("membership", () => {
		it("publishes who is in each channel", () => {
			voice.join("a", "main");
			voice.join("b", "side");
			expect(channel("main").members).toEqual(["a"]);
			expect(channel("side").members).toEqual(["b"]);
		});

		it("moves a client that joins another channel, ending their turn there", () => {
			voice.join("a", "main");
			voice.startTalk("a");
			voice.join("a", "side");
			expect(channel("main").members).toEqual([]);
			expect(channel("main").speaker).toBeNull();
			expect(channel("side").members).toEqual(["a"]);
			expect(lastTo("a")).toMatchObject({ event: "talk-ended", reason: "left" });
		});

		it("refuses a channel that does not exist", () => {
			voice.join("a", "attic" as VoiceChannelId);
			expect(lastTo("a")).toEqual({
				action: "voice-you",
				event: "join-refused",
				reason: "invalid-channel",
			});
			expect(published).toEqual([]);
		});

		it("refuses joining while voice is off", () => {
			rules.voiceEnabled = false;
			voice.join("a", "main");
			expect(lastTo("a")).toMatchObject({ event: "join-refused", reason: "voice-off" });
		});

		it("frees the floor when the speaker leaves the room", () => {
			voice.join("a", "main");
			voice.join("b", "main");
			voice.startTalk("a");
			voice.leave("a");
			expect(channel("main").speaker).toBeNull();
			voice.startTalk("b");
			expect(channel("main").speaker).toEqual("b");
		});
	});

	describe("floor control", () => {
		beforeEach(() => {
			voice.join("a", "main");
			voice.join("b", "main");
			voice.join("c", "side");
		});

		it("gives two presses in a row to exactly one speaker", () => {
			voice.startTalk("a");
			voice.startTalk("b");
			expect(channel("main").speaker).toEqual("a");
			expect(lastTo("a")).toMatchObject({ event: "talk-granted", maxTalkMs: 10_000 });
			expect(lastTo("b")).toMatchObject({ event: "talk-refused", reason: "busy" });
		});

		it("gives a person the floor immediately when it is free, with no await in the way", () => {
			// startTalk returns void: there is nothing to await, so no other press can get between
			// its check and its write.
			expect(voice.startTalk("a")).toBeUndefined();
			expect(lastState().channels.find(c => c.id === "main")?.speaker).toEqual("a");
		});

		it("keeps channels independent", () => {
			voice.startTalk("a");
			voice.startTalk("c");
			expect(channel("main").speaker).toEqual("a");
			expect(channel("side").speaker).toEqual("c");
		});

		it("does not start a second turn when the speaker's press repeats", () => {
			voice.startTalk("a");
			voice.startTalk("a");
			expect(sent.get("a")?.filter(m => m.event === "talk-granted")).toHaveLength(1);
		});

		it("refuses a client that is not in a channel", () => {
			voice.leave("a");
			voice.startTalk("a");
			expect(lastTo("a")).toMatchObject({ event: "talk-refused", reason: "not-in-channel" });
		});

		it("ignores a release from someone who is not talking", () => {
			voice.startTalk("a");
			voice.stopTalk("b");
			expect(channel("main").speaker).toEqual("a");
		});
	});

	describe("talk limit", () => {
		beforeEach(() => {
			voice.join("a", "main");
			voice.join("b", "main");
		});

		it("cuts the speaker off exactly at the limit", () => {
			voice.startTalk("a");
			vi.advanceTimersByTime(9_999);
			expect(channel("main").speaker).toEqual("a");
			vi.advanceTimersByTime(1);
			expect(channel("main").speaker).toBeNull();
			expect(lastTo("a")).toMatchObject({ event: "talk-ended", reason: "limit" });
			expect(voice.acceptFrame("a", frame())).toBeNull();
		});

		it("does not cut off a later turn with an earlier turn's timer", () => {
			voice.startTalk("a");
			vi.advanceTimersByTime(5_000);
			voice.stopTalk("a");
			voice.startTalk("a");
			vi.advanceTimersByTime(9_999);
			expect(channel("main").speaker).toEqual("a");
		});

		it("applies a lower limit to a turn in progress", () => {
			voice.startTalk("a");
			vi.advanceTimersByTime(4_000);
			rules.voiceMaxTalkSeconds = 5;
			voice.onRulesChanged();
			vi.advanceTimersByTime(999);
			expect(channel("main").speaker).toEqual("a");
			vi.advanceTimersByTime(1);
			expect(channel("main").speaker).toBeNull();
		});

		it("cuts off at once when a lower limit has already passed", () => {
			voice.startTalk("a");
			vi.advanceTimersByTime(8_000);
			rules.voiceMaxTalkSeconds = 5;
			voice.onRulesChanged();
			vi.advanceTimersByTime(0);
			expect(channel("main").speaker).toBeNull();
		});
	});

	describe("slow mode", () => {
		beforeEach(() => {
			rules.voiceSlowModeSeconds = 30;
			voice.join("a", "main");
			voice.join("b", "main");
		});

		it("refuses a turn during the cooldown and reports what is left", () => {
			voice.startTalk("a");
			voice.stopTalk("a");
			expect(lastTo("a")).toMatchObject({ event: "talk-ended", cooldownMs: 30_000 });
			vi.advanceTimersByTime(10_000);
			voice.startTalk("a");
			expect(lastTo("a")).toMatchObject({
				event: "talk-refused",
				reason: "cooldown",
				cooldownMs: 20_000,
			});
			expect(channel("main").speaker).toBeNull();
		});

		it("allows a turn when the cooldown is over", () => {
			voice.startTalk("a");
			voice.stopTalk("a");
			vi.advanceTimersByTime(30_000);
			voice.startTalk("a");
			expect(channel("main").speaker).toEqual("a");
		});

		it("does not hold anyone else back", () => {
			voice.startTalk("a");
			voice.stopTalk("a");
			voice.startTalk("b");
			expect(channel("main").speaker).toEqual("b");
		});

		it("also starts the cooldown after being cut off at the limit", () => {
			voice.startTalk("a");
			vi.advanceTimersByTime(10_000);
			expect(lastTo("a")).toMatchObject({ event: "talk-ended", cooldownMs: 30_000 });
		});

		it("follows the person across a reconnect", () => {
			voice.startTalk("a");
			voice.stopTalk("a");
			voice.leave("a");
			people.set("a2", "person-a");
			voice.join("a2", "main");
			voice.startTalk("a2");
			expect(lastTo("a2")).toMatchObject({ event: "talk-refused", reason: "cooldown" });
		});

		it("shortens running cooldowns when slow mode is lowered, and tells the members", () => {
			voice.startTalk("a");
			voice.stopTalk("a");
			rules.voiceSlowModeSeconds = 0;
			voice.onRulesChanged();
			expect(lastTo("a")).toEqual({ action: "voice-you", event: "cooldown", cooldownMs: 0 });
			voice.startTalk("a");
			expect(channel("main").speaker).toEqual("a");
		});
	});

	describe("member-only delivery", () => {
		beforeEach(() => {
			voice.join("a", "main");
			voice.join("b", "main");
			voice.join("c", "side");
		});

		it("sends a frame to the other members of the channel and nobody else", () => {
			voice.startTalk("a");
			expect(voice.acceptFrame("a", frame())).toEqual(["b"]);
		});

		it("never sends to someone who has left", () => {
			voice.startTalk("a");
			voice.leave("b");
			expect(voice.acceptFrame("a", frame())).toEqual([]);
		});

		it("drops frames from a member without the floor", () => {
			voice.startTalk("a");
			expect(voice.acceptFrame("b", frame())).toBeNull();
		});

		it("drops frames from someone who is not in voice", () => {
			expect(voice.acceptFrame("nobody", frame())).toBeNull();
		});

		it("drops frames sent after the turn ended", () => {
			voice.startTalk("a");
			voice.stopTalk("a");
			expect(voice.acceptFrame("a", frame())).toBeNull();
		});

		it("never puts audio in what it publishes", () => {
			voice.startTalk("a");
			const before = published.length;
			voice.acceptFrame("a", frame());
			expect(published).toHaveLength(before);
			expect(JSON.stringify(published)).not.toContain("frame");
		});
	});

	describe("frame validation and rate", () => {
		beforeEach(() => {
			voice.join("a", "main");
			voice.join("b", "main");
			voice.startTalk("a");
		});

		it.each([
			["empty", new Uint8Array(0)],
			["header only", frame().slice(0, 2)],
			["one byte short", frame().slice(0, VOICE_FRAME_BYTES - 1)],
			["one byte long", new Uint8Array(VOICE_FRAME_BYTES + 1)],
			["huge", new Uint8Array(1024 * 1024)],
		])("drops a frame that is %s", (_name, bytes) => {
			expect(voice.acceptFrame("a", bytes)).toBeNull();
		});

		it("drops a frame with the wrong magic or version", () => {
			const wrongMagic = frame();
			wrongMagic[0] = 0;
			const wrongVersion = frame();
			wrongVersion[1] = 99;
			expect(voice.acceptFrame("a", wrongMagic)).toBeNull();
			expect(voice.acceptFrame("a", wrongVersion)).toBeNull();
		});

		it("lets a burst through, then drops what exceeds it", () => {
			let relayed = 0;
			for (let i = 0; i < VOICE_FRAME_BURST * 4; i++) {
				if (voice.acceptFrame("a", frame())) {
					relayed++;
				}
			}
			expect(relayed).toEqual(VOICE_FRAME_BURST);
		});

		it("sustains real-time audio without dropping anything", () => {
			let relayed = 0;
			for (let i = 0; i < 400; i++) {
				vi.advanceTimersByTime(20);
				if (voice.acceptFrame("a", frame())) {
					relayed++;
				}
			}
			expect(relayed).toEqual(400);
		});

		it("holds a sustained flood to the frame rate limit", () => {
			let relayed = 0;
			for (let i = 0; i < 1000; i++) {
				vi.advanceTimersByTime(1);
				if (voice.acceptFrame("a", frame())) {
					relayed++;
				}
			}
			// one second at 1000 frames per second
			expect(relayed).toBeLessThanOrEqual(VOICE_FRAME_BURST + VOICE_MAX_FRAMES_PER_SECOND);
			expect(relayed).toBeGreaterThanOrEqual(VOICE_MAX_FRAMES_PER_SECOND);
		});
	});

	describe("removal", () => {
		beforeEach(() => {
			voice.join("a", "main");
			voice.join("b", "main");
		});

		it("takes the person out, ends their turn, and keeps them out", () => {
			voice.startTalk("b");
			voice.remove("b");
			expect(channel("main").members).toEqual(["a"]);
			expect(channel("main").speaker).toBeNull();
			expect(lastState().removed).toEqual(["b"]);
			expect(lastTo("b")).toMatchObject({ event: "talk-ended", reason: "removed" });
			voice.join("b", "main");
			expect(lastTo("b")).toMatchObject({ event: "join-refused", reason: "removed" });
		});

		it("keeps them out after a reconnect, and on any other device", () => {
			people.set("b2", "person-b");
			voice.join("b2", "side");
			voice.remove("b");
			expect(channel("side").members).toEqual([]);
			voice.leave("b");
			people.delete("b");
			people.set("b3", "person-b");
			voice.join("b3", "main");
			expect(lastTo("b3")).toMatchObject({ event: "join-refused", reason: "removed" });
		});

		it("lets them back when allowed", () => {
			voice.remove("b");
			voice.allow("b");
			expect(lastState().removed).toEqual([]);
			voice.join("b", "main");
			expect(channel("main").members).toContain("b");
		});
	});

	describe("voice turned off", () => {
		it("ends turns and empties the channels", () => {
			voice.join("a", "main");
			voice.join("b", "main");
			voice.startTalk("a");
			rules.voiceEnabled = false;
			voice.onRulesChanged();
			expect(channel("main").members).toEqual([]);
			expect(channel("main").speaker).toBeNull();
			expect(lastTo("a")).toMatchObject({ event: "talk-ended", reason: "voice-off" });
			voice.startTalk("a");
			expect(lastTo("a")).toMatchObject({ event: "talk-refused", reason: "voice-off" });
		});
	});

	it("stops its timers when disposed", () => {
		voice.join("a", "main");
		voice.startTalk("a");
		voice.dispose();
		const before = published.length;
		vi.advanceTimersByTime(60_000);
		expect(published).toHaveLength(before);
	});
});

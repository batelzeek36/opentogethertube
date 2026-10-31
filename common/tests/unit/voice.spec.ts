import { describe, expect, it } from "vitest";
import {
	VOICE_FRAME_BYTES,
	VOICE_FRAME_MAGIC,
	VOICE_FRAME_MS,
	VOICE_FRAME_VERSION,
	VOICE_RULE_DEFAULTS,
	isValidVoiceFrame,
	isVoiceChannel,
} from "../../models/voice.js";
import { RoomSettingsSchema, VoiceRulesSchema } from "../../models/zod-schemas.js";
import { Grants, parseIntoGrantMask } from "../../permissions.js";
import { Role } from "../../models/types.js";

describe("voice frames", () => {
	const good = () => {
		const frame = new Uint8Array(VOICE_FRAME_BYTES);
		frame[0] = VOICE_FRAME_MAGIC;
		frame[1] = VOICE_FRAME_VERSION;
		return frame;
	};

	it("is 20 ms of audio", () => {
		expect(VOICE_FRAME_MS).toEqual(20);
		expect(VOICE_FRAME_BYTES).toEqual(642);
	});

	it("accepts a well formed frame", () => {
		expect(isValidVoiceFrame(good())).toEqual(true);
	});

	it("refuses the wrong size, magic or version", () => {
		expect(isValidVoiceFrame(new Uint8Array(0))).toEqual(false);
		expect(isValidVoiceFrame(good().slice(1))).toEqual(false);
		const magic = good();
		magic[0] = 1;
		expect(isValidVoiceFrame(magic)).toEqual(false);
		const version = good();
		version[1] = 2;
		expect(isValidVoiceFrame(version)).toEqual(false);
	});
});

describe("isVoiceChannel", () => {
	it("knows the two channels", () => {
		expect(isVoiceChannel("main")).toEqual(true);
		expect(isVoiceChannel("side")).toEqual(true);
		expect(isVoiceChannel("attic")).toEqual(false);
		expect(isVoiceChannel(undefined)).toEqual(false);
	});
});

describe("voice rules schema", () => {
	it("accepts the defaults and the edges of the bounds", () => {
		expect(VoiceRulesSchema.safeParse(VOICE_RULE_DEFAULTS).success).toEqual(true);
		for (const rules of [
			{ voiceMaxTalkSeconds: 3 },
			{ voiceMaxTalkSeconds: 120 },
			{ voiceSlowModeSeconds: 0 },
			{ voiceSlowModeSeconds: 300 },
		]) {
			expect(RoomSettingsSchema.safeParse(rules).success).toEqual(true);
		}
	});

	it("refuses anything outside them", () => {
		for (const rules of [
			{ voiceMaxTalkSeconds: 2 },
			{ voiceMaxTalkSeconds: 121 },
			{ voiceMaxTalkSeconds: 5.5 },
			{ voiceSlowModeSeconds: -1 },
			{ voiceSlowModeSeconds: 301 },
			{ voiceEnabled: "on" },
		]) {
			expect(RoomSettingsSchema.safeParse(rules).success).toEqual(false);
		}
	});
});

describe("voice permissions", () => {
	const perms = ["configure-room.voice", "manage-users.voice-remove"];

	it("belong to moderators and above by default, and nobody below", () => {
		const grants = new Grants();
		for (const perm of perms) {
			expect(grants.granted(Role.UnregisteredUser, perm)).toEqual(false);
			expect(grants.granted(Role.RegisteredUser, perm)).toEqual(false);
			expect(grants.granted(Role.TrustedUser, perm)).toEqual(false);
			expect(grants.granted(Role.Moderator, perm)).toEqual(true);
			expect(grants.granted(Role.Administrator, perm)).toEqual(true);
			expect(grants.granted(Role.Owner, perm)).toEqual(true);
		}
	});

	it("cannot be given to a role below moderator", () => {
		const grants = new Grants();
		grants.setRoleGrants(Role.TrustedUser, parseIntoGrantMask(perms));
		for (const perm of perms) {
			expect(grants.granted(Role.TrustedUser, perm)).toEqual(false);
		}
	});

	it("stay with the owner in grants saved before they existed", () => {
		const saved = new Grants([
			[Role.UnregisteredUser, parseIntoGrantMask(["chat"])],
			[Role.RegisteredUser, 0],
			[Role.TrustedUser, 0],
			[Role.Moderator, 0],
		]);
		for (const perm of perms) {
			expect(saved.granted(Role.Owner, perm)).toEqual(true);
			expect(saved.granted(Role.UnregisteredUser, perm)).toEqual(false);
		}
	});
});

import { describe, expect, it } from "vitest";
import { isClientSendableRequest, parseClientRequest } from "../../client-requests.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { CHAT_MESSAGE_LENGTH_MAX } from "ott-common/constants.js";
import { Role } from "ott-common/models/types.js";

const allTypes = Object.values(RoomRequestType).filter(
	(value): value is RoomRequestType => typeof value === "number",
);
const neverFromASocket = [
	RoomRequestType.JoinRequest,
	RoomRequestType.LeaveRequest,
	RoomRequestType.AddRequest,
	RoomRequestType.RemoveRequest,
	RoomRequestType.VoteRequest,
	RoomRequestType.UpdateUser,
	RoomRequestType.UpdateQueueItemRequest,
];

describe("isClientSendableRequest", () => {
	it("refuses only the requests that say who someone is or that have a REST route", () => {
		expect(allTypes.filter(type => !isClientSendableRequest({ type }))).toEqual(
			neverFromASocket,
		);
	});

	it.each(allTypes.filter(type => !neverFromASocket.includes(type)))(
		"accepts request type %s, which open tabs send as a number",
		type => {
			expect(isClientSendableRequest({ type })).toEqual(true);
		},
	);

	it.each([
		[String(RoomRequestType.PlaybackRequest)],
		[[RoomRequestType.PlaybackRequest]],
		[{ valueOf: RoomRequestType.PlaybackRequest }],
		[true],
		[null],
		[undefined],
		[-1],
		[1.5],
		[allTypes.length],
		["constructor"],
		["__proto__"],
	])("refuses a type of %j", type => {
		expect(isClientSendableRequest({ type })).toEqual(false);
	});

	it.each([[null], [undefined], ["request"], [2], [true]])("refuses a request of %j", request => {
		expect(isClientSendableRequest(request)).toEqual(false);
	});
});

describe("parseClientRequest", () => {
	const NOT_TEXT = [null, undefined, true, {}, [], 5];
	const NOT_A_NUMBER = [null, undefined, true, {}, [], "junk", Infinity, -Infinity];
	const NOT_A_BOOLEAN = [null, undefined, {}, [], "true", 1];

	// Every request the client really sends, from client/src/util/roomapi.ts and client/src/voice/session.ts.
	it.each([
		[{ type: RoomRequestType.PlaybackRequest, state: true }],
		[{ type: RoomRequestType.PlaybackRequest, state: false }],
		[{ type: RoomRequestType.SkipRequest }],
		[{ type: RoomRequestType.SeekRequest, value: 12.5 }],
		[{ type: RoomRequestType.SeekRequest, value: 0 }],
		[{ type: RoomRequestType.SeekRequest, value: -3 }],
		[{ type: RoomRequestType.OrderRequest, fromIdx: 0, toIdx: 3 }],
		[{ type: RoomRequestType.PromoteRequest, targetClientId: "a", role: Role.Moderator }],
		[{ type: RoomRequestType.ReactionRequest, emoji: "x" }],
		[{ type: RoomRequestType.ChatReactionRequest, messageId: "1", emoji: "x", add: true }],
		[{ type: RoomRequestType.ChatRequest, text: "hello" }],
		[{ type: RoomRequestType.ChatRequest, text: "a".repeat(CHAT_MESSAGE_LENGTH_MAX) }],
		[{ type: RoomRequestType.PlayNowRequest, video: { service: "direct", id: "x" } }],
		[{ type: RoomRequestType.ShuffleRequest }],
		[{ type: RoomRequestType.PlaybackSpeedRequest, speed: 1.5 }],
		[{ type: RoomRequestType.PlaybackSpeedRequest, speed: 0.25 }],
		[{ type: RoomRequestType.PlaybackSpeedRequest, speed: 2 }],
		[{ type: RoomRequestType.RestoreQueueRequest }],
		[{ type: RoomRequestType.RestoreQueueRequest, discard: true }],
		[{ type: RoomRequestType.KickRequest, clientId: "a" }],
		[{ type: RoomRequestType.UndoRequest, eventId: "a" }],
		[{ type: RoomRequestType.VoiceJoinRequest, channel: "main" }],
		[{ type: RoomRequestType.VoiceLeaveRequest }],
		[{ type: RoomRequestType.VoiceTalkRequest, talking: true }],
		[{ type: RoomRequestType.VoiceRemoveRequest, clientId: "a" }],
		[{ type: RoomRequestType.VoiceAllowRequest, clientId: "a" }],
		[{ type: RoomRequestType.ApplySettingsRequest, settings: { voiceEnabled: true } }],
		[{ type: RoomRequestType.ApplySettingsRequest, settings: { title: "movie" } }],
	])("lets through %j", request => {
		expect(parseClientRequest(request)).toEqual(request);
	});

	it.each([
		["seek", RoomRequestType.SeekRequest, "value", NOT_A_NUMBER],
		[
			"speed",
			RoomRequestType.PlaybackSpeedRequest,
			"speed",
			[...NOT_A_NUMBER, 0, -1, 0.1, 5, 1e308],
		],
		[
			"chat",
			RoomRequestType.ChatRequest,
			"text",
			[...NOT_TEXT, "", "a".repeat(CHAT_MESSAGE_LENGTH_MAX + 1)],
		],
		["playback", RoomRequestType.PlaybackRequest, "state", NOT_A_BOOLEAN],
		["order from", RoomRequestType.OrderRequest, "fromIdx", [...NOT_A_NUMBER, "0", -1, 0.5]],
		["kick", RoomRequestType.KickRequest, "clientId", NOT_TEXT],
		["promote", RoomRequestType.PromoteRequest, "role", [...NOT_A_NUMBER, 99, "1"]],
		[
			"play now",
			RoomRequestType.PlayNowRequest,
			"video",
			[
				...NOT_TEXT,
				"junk",
				{ service: "nope", id: "x" },
				{ service: "direct" },
				{ service: "direct", id: {} },
			],
		],
		[
			"settings",
			RoomRequestType.ApplySettingsRequest,
			"settings",
			[
				null,
				"x",
				5,
				{ title: {} },
				{ title: "a\nb" },
				{ visibility: "nope" },
				{ queueMode: 99 },
				{ grants: [] },
				{ unknown: 1 },
				{ voiceMaxTalkSeconds: 1000 },
			],
		],
		["undo", RoomRequestType.UndoRequest, "eventId", NOT_TEXT],
		["talk", RoomRequestType.VoiceTalkRequest, "talking", NOT_A_BOOLEAN],
	] as const)("refuses a bad %s", (_name, type, field, values) => {
		for (const value of values) {
			const fine = { toIdx: 0, targetClientId: "a", role: Role.Moderator };
			expect(parseClientRequest({ type, ...fine, [field]: value })).toBeNull();
		}
	});

	it("drops fields that request type doesn't have", () => {
		expect(
			parseClientRequest({
				type: RoomRequestType.PlayNowRequest,
				video: { service: "direct", id: "x", title: "not what it says", length: 1 },
				extra: true,
			}),
		).toEqual({ type: RoomRequestType.PlayNowRequest, video: { service: "direct", id: "x" } });
	});

	it.each(neverFromASocket)("refuses type %s however it looks", type => {
		expect(parseClientRequest({ type, video: { service: "direct", id: "x" } })).toBeNull();
	});
});

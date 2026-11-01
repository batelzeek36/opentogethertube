import {
	describe,
	it,
	expect,
	beforeAll,
	beforeEach,
	afterAll,
	afterEach,
	vi,
	type MockInstance,
} from "vitest";
import dayjs from "dayjs";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { type AuthToken, BehaviorOption, QueueMode, Role } from "ott-common/models/types.js";
import { Room, RoomUser } from "../../room.js";
import infoextractor from "../../infoextractor.js";
import type { Video, VideoId } from "ott-common/models/video.js";
import permissions from "ott-common/permissions.js";
import _ from "lodash";
import { VideoQueue } from "../../videoqueue.js";
import { loadModels } from "../../models/index.js";
import { buildClients } from "../../redisclient.js";
import { BadApiArgumentException } from "../../exceptions.js";
import { PermissionDeniedException } from "ott-common/exceptions.js";

describe("Room", () => {
	let getSessionInfoSpy: MockInstance<[AuthToken], Promise<SessionInfo>>;
	let validateSpy: MockInstance<[AuthToken], Promise<boolean>>;
	beforeAll(async () => {
		loadModels();
		await buildClients();

		getSessionInfoSpy = vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			username: "test",
			isLoggedIn: false,
		});
		validateSpy = vi.spyOn(tokens, "validate").mockResolvedValue(true);
	});

	afterAll(() => {
		getSessionInfoSpy.mockRestore();
		validateSpy.mockRestore();
	});

	it("should control playback with play/pause", async () => {
		const room = new Room({ name: "test" });
		await room.play();
		expect(room.isPlaying).toEqual(true);
		await room.play();
		await room.pause();
		expect(room.isPlaying).toEqual(false);
		await room.pause();
	});

	it("should always return the correct playback position when syncing to clients", async () => {
		const room = new Room({ name: "test" });
		room.currentSource = { service: "youtube", id: "video1", length: 100 };
		room.isPlaying = true;
		room._playbackStart = dayjs().subtract(10, "second");
		room.playbackPosition = 20; // The playback position at the start of playback

		const expectedPlaybackPosition = room.realPlaybackPosition;
		const syncState = room.syncableState();

		expect(syncState.playbackPosition).toBeCloseTo(expectedPlaybackPosition, 1);
	});

	describe("Room Requests", () => {
		let room: Room;
		let user: RoomUser;

		beforeEach(() => {
			user = new RoomUser("user", "a");
			user.token = "asdf1234";
			room = new Room({ name: "test" });
			room.realusers = [user];
			// because we aren't testing the permission system, grant all the permissions
			room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(["*"]));
		});

		describe("PlaybackRequest", () => {
			it("should play and pause", async () => {
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlaybackRequest,
						state: true,
					},
					{ token: user.token },
				);
				expect(room.isPlaying).toEqual(true);
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlaybackRequest,
						state: false,
					},
					{ token: user.token },
				);
				expect(room.isPlaying).toEqual(false);
			});

			it("should advance playback position", async () => {
				room.isPlaying = true;
				room._playbackStart = dayjs().subtract(5, "second");
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlaybackRequest,
						state: false,
					},
					{ token: user.token },
				);
				expect(room.isPlaying).toEqual(false);
				expect(room.playbackPosition).toBeCloseTo(5, 1);
				expect(room.playbackPosition).toBeGreaterThanOrEqual(5);
			});
		});

		describe("SkipRequest", () => {
			beforeEach(() => {
				room.currentSource = {
					service: "direct",
					id: "video",
				};
			});

			it("skip with empty queue", async () => {
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.SkipRequest,
					},
					{ token: user.token },
				);
				expect(room.currentSource).toBeNull();
			});

			it("skip with non-empty queue", async () => {
				room.queue = new VideoQueue([
					{
						service: "direct",
						id: "video2",
					},
				]);
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.SkipRequest,
					},
					{ token: user.token },
				);
				expect(room.currentSource).toEqual({
					service: "direct",
					id: "video2",
				});
			});
		});

		describe("SeekRequest", () => {
			it("should seek", async () => {
				room.playbackPosition = 10;
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.SeekRequest,
						value: 15,
					},
					{ token: user.token },
				);
				expect(room.playbackPosition).toEqual(15);
			});

			it.each([undefined, null])("should not seek if value is %s", async v => {
				room.playbackPosition = 10;
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.SeekRequest,
						value: v as unknown as number,
					},
					{ token: user.token },
				);
				expect(room.playbackPosition).toEqual(10);
			});
		});

		describe("PlayNowRequest", () => {
			const videoToPlay: Video = {
				service: "direct",
				id: "video",
				title: "play me now",
				description: "test",
				thumbnail: "test",
				length: 10,
			};

			it("should place the requested video in currentSource", async () => {
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToPlay);
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlayNowRequest,
						video: videoToPlay,
					},
					{ token: user.token },
				);
				expect(room.currentSource).toEqual(videoToPlay);
			});

			it("should remove the video from the queue", async () => {
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToPlay);
				room.currentSource = {
					service: "direct",
					id: "asdf123",
				};
				room.queue = new VideoQueue([videoToPlay]);
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlayNowRequest,
						video: videoToPlay,
					},
					{ token: user.token },
				);
				for (const video of room.queue.items) {
					expect(video).not.toEqual(videoToPlay);
				}
				expect(room.currentSource).toEqual(videoToPlay);
			});

			it("should push the currently playing video into the queue", async () => {
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToPlay);
				room.currentSource = {
					service: "direct",
					id: "asdf123",
				};
				room.queue = new VideoQueue([videoToPlay]);
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlayNowRequest,
						video: videoToPlay,
					},
					{ token: user.token },
				);
				expect(_.pick(room.queue.items[0], "service", "id")).toEqual({
					service: "direct",
					id: "asdf123",
				});
				for (const video of room.queue.items) {
					expect(video).not.toEqual(videoToPlay);
				}
				expect(room.currentSource).toEqual(videoToPlay);
			});

			it("should reset playback position to 0", async () => {
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToPlay);
				room.currentSource = {
					service: "direct",
					id: "asdf123",
				};
				room.playbackPosition = 10;
				room.queue = new VideoQueue([videoToPlay]);
				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlayNowRequest,
						video: videoToPlay,
					},
					{ token: user.token },
				);
				expect(room.currentSource).toEqual(videoToPlay);
				expect(room.playbackPosition).toEqual(0);
			});

			it("should preserve subtitleUrl from PlayNowRequest", async () => {
				const subtitleUrl = "https://example.com/subtitles.vtt";
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToPlay);

				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlayNowRequest,
						video: {
							...videoToPlay,
							subtitleUrl,
						},
					},
					{ token: user.token },
				);

				expect(room.currentSource).toEqual({
					...videoToPlay,
					subtitleUrl,
				});
			});

			it("should reject unsupported subtitleUrl for PlayNowRequest", async () => {
				await expect(
					room.processUnauthorizedRequest(
						{
							type: RoomRequestType.PlayNowRequest,
							video: {
								...videoToPlay,
								subtitleUrl: "https://example.com/subtitles.srt",
							},
						},
						{ token: user.token },
					),
				).rejects.toThrow("Subtitle URL must end with .vtt, .ass, or .ssa");
			});

			it("should preserve .ass subtitleUrl from PlayNowRequest", async () => {
				const subtitleUrl = "https://example.com/subtitles.ass";
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToPlay);

				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.PlayNowRequest,
						video: {
							...videoToPlay,
							subtitleUrl,
						},
					},
					{ token: user.token },
				);

				expect(room.currentSource).toEqual({
					...videoToPlay,
					subtitleUrl,
				});
			});
		});

		describe("AddRequest", () => {
			const videoToAdd: Video = {
				service: "direct",
				id: "video",
				title: "add me",
				description: "test",
				thumbnail: "test",
				length: 10,
			};
			const subtitleUrl = "https://example.com/subtitles.vtt";

			it("should add video with subtitleUrl to queue", async () => {
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToAdd);

				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.AddRequest,
						video: {
							...videoToAdd,
							subtitleUrl,
						},
					},
					{ token: user.token },
				);

				expect(room.queue).toHaveLength(1);
				expect(room.queue.items[0]).toEqual({
					...videoToAdd,
					subtitleUrl,
				});
			});

			it("should reject unsupported subtitleUrl for AddRequest", async () => {
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToAdd);

				await expect(
					room.processUnauthorizedRequest(
						{
							type: RoomRequestType.AddRequest,
							video: {
								...videoToAdd,
								subtitleUrl: "https://example.com/subtitles.srt",
							},
						},
						{ token: user.token },
					),
				).rejects.toThrow("Subtitle URL must end with .vtt, .ass, or .ssa");
			});

			it("should add video with .ass subtitleUrl to queue", async () => {
				const assSubtitleUrl = "https://example.com/subtitles.ass";
				vi.spyOn(infoextractor, "getVideoInfo").mockResolvedValue(videoToAdd);

				await room.processUnauthorizedRequest(
					{
						type: RoomRequestType.AddRequest,
						video: {
							...videoToAdd,
							subtitleUrl: assSubtitleUrl,
						},
					},
					{ token: user.token },
				);

				expect(room.queue).toHaveLength(1);
				expect(room.queue.items[0]).toEqual({
					...videoToAdd,
					subtitleUrl: assSubtitleUrl,
				});
			});
		});

		describe("ReactionRequest", () => {
			const context = { username: "test", role: Role.UnregisteredUser, clientId: "user" };

			it("publishes a known reaction to the room", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				await room.processRequest(
					{ type: RoomRequestType.ReactionRequest, emoji: "🎃" },
					context,
				);
				expect(publish).toHaveBeenCalledWith(
					expect.objectContaining({ action: "reaction", emoji: "🎃" }),
				);
			});

			it("ignores anything outside the reaction list", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				await room.processRequest(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					{ type: RoomRequestType.ReactionRequest, emoji: "<img src=x>" as any },
					context,
				);
				expect(publish).not.toHaveBeenCalled();
			});

			it("drops a client's reactions sent too close together, but not another client's", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				const other = new RoomUser("other", "b");
				room.realusers.push(other);
				const request = { type: RoomRequestType.ReactionRequest, emoji: "🔥" } as const;
				await room.processRequest(request, context);
				await room.processRequest(request, context);
				expect(publish).toHaveBeenCalledTimes(1);
				await room.processRequest(request, { ...context, clientId: "other" });
				expect(publish).toHaveBeenCalledTimes(2);
			});

			it("refuses a role without the chat permission", async () => {
				room.grants.setRoleGrants(Role.UnregisteredUser, 0);
				await expect(
					room.processRequest(
						{ type: RoomRequestType.ReactionRequest, emoji: "🔥" },
						context,
					),
				).rejects.toThrow();
			});
		});

		describe("device type", () => {
			const update = (device: unknown) => ({
				type: RoomRequestType.UpdateUser as const,
				info: { id: "user", device } as never,
			});
			const context = { username: "test", role: Role.UnregisteredUser, clientId: "user" };

			it("tells the room a known device type", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				await room.processRequest(update("phone"), context);
				expect(room.getUserInfo("user").device).toEqual("phone");
				expect(publish).toHaveBeenCalledWith(
					expect.objectContaining({
						action: "user",
						update: {
							kind: "update",
							value: expect.objectContaining({ id: "user", device: "phone" }),
						},
					}),
				);
			});

			it("has none until one is reported", () => {
				expect(room.getUserInfo("user").device).toBeUndefined();
			});

			it.each(["smart fridge", "Mozilla/5.0 (iPhone)", 3, { $ne: 1 }])(
				"ignores anything outside the list: %s",
				async device => {
					await room.processRequest(update("computer"), context);
					await room.processRequest(update(device), context);
					expect(room.getUserInfo("user").device).toEqual("computer");
				},
			);

			it("keeps the device type when the person's name changes", async () => {
				await room.processRequest(update("tablet"), context);
				await room.processRequest(
					{
						type: RoomRequestType.UpdateUser,
						info: { id: "user", username: "new name" },
					},
					context,
				);
				expect(room.getUserInfo("user")).toMatchObject({
					name: "new name",
					device: "tablet",
				});
			});
		});

		describe("chat", () => {
			const context = { username: "test", role: Role.UnregisteredUser, clientId: "user" };

			it("keeps request numbers stable, because open tabs send them", () => {
				expect(RoomRequestType.VoiceAllowRequest).toEqual(25);
				expect(RoomRequestType.ChatReactionRequest).toEqual(26);
			});

			it("gives each chat message an id", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				await room.processRequest(
					{ type: RoomRequestType.ChatRequest, text: "hi" },
					context,
				);
				await room.processRequest(
					{ type: RoomRequestType.ChatRequest, text: "hi" },
					context,
				);
				const ids = publish.mock.calls.map(([msg]) => (msg as { id?: string }).id);
				expect(ids[0]).toEqual(expect.any(String));
				expect(ids[1]).toEqual(expect.any(String));
				expect(ids[0]).not.toEqual(ids[1]);
			});

			it("sends a reaction on a chat message to each client, not to the whole room", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				const command = vi.spyOn(room, "command").mockResolvedValue();
				await room.processRequest(
					{ type: RoomRequestType.ChatRequest, text: "hi" },
					context,
				);
				const messageId = (publish.mock.calls[0][0] as { id: string }).id;
				publish.mockClear();
				await room.processRequest(
					{
						type: RoomRequestType.ChatReactionRequest,
						messageId,
						emoji: "🔥",
						add: true,
					},
					context,
				);
				expect(publish).not.toHaveBeenCalled();
				expect(command).toHaveBeenCalledWith({
					type: "send",
					clientId: "user",
					msg: {
						action: "chat-reactions",
						messages: [
							{
								id: messageId,
								reactions: [{ emoji: "🔥", count: 1, mine: true }],
							},
						],
					},
				});
			});

			it("refuses a reaction from a role without the chat permission", async () => {
				room.grants.setRoleGrants(Role.UnregisteredUser, 0);
				await expect(
					room.processRequest(
						{
							type: RoomRequestType.ChatReactionRequest,
							messageId: "any",
							emoji: "🔥",
							add: true,
						},
						context,
					),
				).rejects.toThrow();
			});

			it("catches a joining client up on reactions", async () => {
				const command = vi.spyOn(room, "command").mockResolvedValue();
				await room.processRequest(
					{ type: RoomRequestType.JoinRequest, info: { id: "late", username: "late" } },
					{
						username: "late",
						role: Role.UnregisteredUser,
						clientId: "late",
						auth: { token: "late-token" as AuthToken, clientId: "late" },
					},
				);
				expect(command).toHaveBeenCalledWith({
					type: "send",
					clientId: "late",
					msg: { action: "chat-reactions", complete: true, messages: [] },
				});
			});
		});

		describe("voice", () => {
			const owner = { id: 1, username: "owner" } as never;
			const memberContext = {
				username: "test",
				role: Role.UnregisteredUser,
				clientId: "user",
			};

			afterEach(() => {
				room.voice.dispose();
			});

			it("uses the default rules", () => {
				expect(room.voiceEnabled).toEqual(true);
				expect(room.voiceMaxTalkSeconds).toEqual(10);
				expect(room.voiceSlowModeSeconds).toEqual(0);
			});

			it("routes join, talk and leave requests to the channels", async () => {
				const publish = vi.spyOn(room, "publish").mockResolvedValue();
				await room.processRequest(
					{ type: RoomRequestType.VoiceJoinRequest, channel: "main" },
					memberContext,
				);
				await room.processRequest(
					{ type: RoomRequestType.VoiceTalkRequest, talking: true },
					memberContext,
				);
				expect(room.voice.state().channels[0]).toEqual({
					id: "main",
					members: ["user"],
					speaker: "user",
				});
				await room.processRequest(
					{ type: RoomRequestType.VoiceTalkRequest, talking: false },
					memberContext,
				);
				expect(room.voice.state().channels[0].speaker).toBeNull();
				await room.processRequest(
					{ type: RoomRequestType.VoiceLeaveRequest },
					memberContext,
				);
				expect(room.voice.state().channels[0].members).toEqual([]);
				expect(publish).toHaveBeenCalledWith(expect.objectContaining({ action: "voice" }));
			});

			it("takes a person out of voice when they leave the room", async () => {
				vi.spyOn(room, "publish").mockResolvedValue();
				room.voice.join("user", "main");
				await room.leaveRoom({ type: RoomRequestType.LeaveRequest }, memberContext);
				expect(room.voice.state().channels[0].members).toEqual([]);
			});

			it.each([Role.UnregisteredUser, Role.RegisteredUser, Role.TrustedUser])(
				"refuses rule changes from role %s, in a room with or without an owner",
				async role => {
					for (const hasOwner of [false, true]) {
						room.owner = hasOwner ? owner : null;
						await expect(
							room.processRequest(
								{
									type: RoomRequestType.ApplySettingsRequest,
									settings: { voiceMaxTalkSeconds: 30 },
								},
								{ ...memberContext, role },
							),
						).rejects.toThrow(PermissionDeniedException);
					}
					expect(room.voiceMaxTalkSeconds).toEqual(10);
				},
			);

			it("cannot be unlocked by granting unregistered users the permission", () => {
				room.grants.setRoleGrants(Role.UnregisteredUser, ["configure-room.voice"]);
				expect(room.grants.granted(Role.UnregisteredUser, "configure-room.voice")).toEqual(
					false,
				);
				room.grants.setRoleGrants(Role.RegisteredUser, ["manage-users.voice-remove"]);
				expect(
					room.grants.granted(Role.RegisteredUser, "manage-users.voice-remove"),
				).toEqual(false);
			});

			it("takes rule changes from the owner", async () => {
				await room.processRequest(
					{
						type: RoomRequestType.ApplySettingsRequest,
						settings: {
							voiceEnabled: false,
							voiceMaxTalkSeconds: 30,
							voiceSlowModeSeconds: 60,
						},
					},
					{ ...memberContext, role: Role.Owner },
				);
				expect(room.voiceEnabled).toEqual(false);
				expect(room.voiceMaxTalkSeconds).toEqual(30);
				expect(room.voiceSlowModeSeconds).toEqual(60);
			});

			it.each([
				{ voiceMaxTalkSeconds: 0 },
				{ voiceMaxTalkSeconds: 121 },
				{ voiceMaxTalkSeconds: 2.5 },
				{ voiceMaxTalkSeconds: "10" as unknown as number },
				{ voiceSlowModeSeconds: -1 },
				{ voiceSlowModeSeconds: 301 },
				{ voiceEnabled: "yes" as unknown as boolean },
			])("refuses out of bounds rules from the owner over the socket: %j", async settings => {
				await expect(
					room.processRequest(
						{ type: RoomRequestType.ApplySettingsRequest, settings },
						{ ...memberContext, role: Role.Owner },
					),
				).rejects.toThrow(BadApiArgumentException);
				expect(room.voiceMaxTalkSeconds).toEqual(10);
				expect(room.voiceSlowModeSeconds).toEqual(0);
				expect(room.voiceEnabled).toEqual(true);
			});

			it("only lets a moderator or above remove someone from voice", async () => {
				vi.spyOn(room, "publish").mockResolvedValue();
				room.realusers.push(new RoomUser("other", "b"));
				room.voice.join("other", "main");
				await expect(
					room.processRequest(
						{ type: RoomRequestType.VoiceRemoveRequest, clientId: "other" },
						memberContext,
					),
				).rejects.toThrow(PermissionDeniedException);
				expect(room.voice.state().channels[0].members).toEqual(["other"]);

				await room.processRequest(
					{ type: RoomRequestType.VoiceRemoveRequest, clientId: "other" },
					{ ...memberContext, role: Role.Owner },
				);
				expect(room.voice.state().channels[0].members).toEqual([]);
				expect(room.voice.state().removed).toEqual(["other"]);

				await expect(
					room.processRequest(
						{ type: RoomRequestType.VoiceAllowRequest, clientId: "other" },
						memberContext,
					),
				).rejects.toThrow(PermissionDeniedException);
				await room.processRequest(
					{ type: RoomRequestType.VoiceAllowRequest, clientId: "other" },
					{ ...memberContext, role: Role.Owner },
				);
				expect(room.voice.state().removed).toEqual([]);
			});

			it("sends rules with room state, and not who is in voice", () => {
				room.voice.join("user", "main");
				expect(room.syncableState()).toMatchObject({
					voiceEnabled: true,
					voiceMaxTalkSeconds: 10,
					voiceSlowModeSeconds: 0,
				});
				expect(room.syncableState()).not.toHaveProperty("voice");
				expect(JSON.parse(room.serializeState())).toMatchObject({
					voiceMaxTalkSeconds: 10,
				});
				expect(room.serializeState()).not.toContain("members");
			});
		});

		describe("VoteRequest", () => {
			it("should only cast one vote when a video is voted for the first time", async () => {
				await room.processRequest(
					{
						type: RoomRequestType.VoteRequest,
						video: { service: "direct", id: "abc123" },
						add: true,
					},
					{ username: "test", role: Role.Owner, clientId: "1234" },
				);
				expect(Array.from(room.votes.get("directabc123")!)).toEqual(["1234"]);
			});
		});

		describe("ShuffleRequest", () => {
			let shuffleSpy;

			beforeEach(() => {
				room.queue = new VideoQueue([
					{ service: "direct", id: "video1" },
					{ service: "direct", id: "video2" },
					{ service: "direct", id: "video3" },
					{ service: "direct", id: "video4" },
					{ service: "direct", id: "video5" },
				]);
				shuffleSpy = vi.spyOn(_, "shuffle");
			});

			afterEach(() => {
				shuffleSpy.mockRestore();
			});

			it("should not leave videos in the same order", async () => {
				await room.processRequest(
					{
						type: RoomRequestType.ShuffleRequest,
					},
					{ username: "test", role: Role.Owner, clientId: "1234" },
				);
				expect(shuffleSpy).toHaveBeenCalled();
				expect(room.queue).toHaveLength(5);
			});
		});

		describe("PlaybackSpeedRequest", () => {
			it("should set the playback speed", async () => {
				await room.processRequest(
					{
						type: RoomRequestType.PlaybackSpeedRequest,
						speed: 1.5,
					},
					{ username: "test", role: Role.Owner, clientId: "1234" },
				);
				expect(room.playbackSpeed).toEqual(1.5);

				await room.processRequest(
					{
						type: RoomRequestType.PlaybackSpeedRequest,
						speed: 1,
					},
					{ username: "test", role: Role.Owner, clientId: "1234" },
				);
				expect(room.playbackSpeed).toEqual(1);
			});
		});

		describe("RestoreQueueRequest", () => {
			it("should restore the queue", async () => {
				const prevQueue: VideoId[] = [
					{ service: "direct", id: "video1" },
					{ service: "direct", id: "video2" },
					{ service: "direct", id: "video3" },
					{ service: "direct", id: "video4" },
					{ service: "direct", id: "video5" },
				];
				room.prevQueue = _.cloneDeep(prevQueue);
				await room.processRequest(
					{
						type: RoomRequestType.RestoreQueueRequest,
					},
					{ username: "test", role: Role.Owner, clientId: "1234" },
				);
				expect(room.queue.items).toEqual(prevQueue);
				expect(room.prevQueue).toBeNull();
			});

			it("should discard the queue", async () => {
				room.prevQueue = [
					{ service: "direct", id: "video1" },
					{ service: "direct", id: "video2" },
					{ service: "direct", id: "video3" },
					{ service: "direct", id: "video4" },
					{ service: "direct", id: "video5" },
				];
				await room.processRequest(
					{
						type: RoomRequestType.RestoreQueueRequest,
						discard: true,
					},
					{ username: "test", role: Role.Owner, clientId: "1234" },
				);
				expect(room.queue.items).not.toEqual(room.prevQueue);
				expect(room.queue.items).toEqual([]);
				expect(room.prevQueue).toBeNull();
			});
		});
	});

	describe("auto dequeuing next video", () => {
		let room: Room;

		beforeEach(() => {
			room = new Room({ name: "test" });
			room.currentSource = {
				service: "direct",
				id: "video",
			};
			room.queue = new VideoQueue([
				{
					service: "direct",
					id: "video2",
				},
			]);
		});

		it.each([QueueMode.Manual, QueueMode.Vote])(
			"should consume the current item when mode is %s",
			async mode => {
				room.queueMode = mode;
				await room.dequeueNext();
				expect(room.currentSource).toEqual({
					service: "direct",
					id: "video2",
				});
				expect(room.queue).toHaveLength(0);
			},
		);

		it.each([QueueMode.Loop])("should requeue the current item when mode is %s", async mode => {
			room.queueMode = mode;
			await room.dequeueNext();
			expect(room.currentSource).toEqual({
				service: "direct",
				id: "video2",
			});
			expect(room.queue).toHaveLength(1);
			expect(room.queue.items[0]).toEqual({
				service: "direct",
				id: "video",
			});
		});

		it.each([QueueMode.Dj])("should restart the current item when mode is %s", async mode => {
			room.queueMode = mode;
			room.playbackPosition = 10;
			await room.dequeueNext();
			expect(room.currentSource).toEqual({
				service: "direct",
				id: "video",
			});
			expect(room.playbackPosition).toEqual(0);
			expect(room.queue).toHaveLength(1);
			expect(room.queue.items[0]).toEqual({
				service: "direct",
				id: "video2",
			});
		});

		it.each([
			{
				mode: QueueMode.Loop,
				expectedCurrentSource: { service: "direct", id: "video2" },
				expectedQueueItem: { service: "direct", id: "video" },
				expectedPlaybackPosition: 0,
			},
			{
				mode: QueueMode.Dj,
				expectedCurrentSource: { service: "direct", id: "video" },
				expectedQueueItem: { service: "direct", id: "video2" },
				expectedPlaybackPosition: 0,
			},
		])(
			"should clear trim metadata when mode is $mode",
			async ({
				mode,
				expectedCurrentSource,
				expectedQueueItem,
				expectedPlaybackPosition,
			}) => {
				room.queueMode = mode;
				room.currentSource = {
					service: "direct",
					id: "video",
					startAt: 10,
					endAt: 20,
				};
				room.playbackPosition = 10;
				await room.dequeueNext();

				expect(room.currentSource).toEqual(expectedCurrentSource);
				expect(room.playbackPosition).toEqual(expectedPlaybackPosition);
				expect(room.queue).toHaveLength(1);
				expect(room.queue.items[0]).toEqual(expectedQueueItem);
			},
		);

		it.each([QueueMode.Loop])(
			"should requeue the current item when mode is %s, with empty queue",
			async mode => {
				room.queueMode = mode;
				room.queue = new VideoQueue();
				expect(room.queue).toHaveLength(0);
				await room.dequeueNext();
				expect(room.currentSource).toEqual({
					service: "direct",
					id: "video",
				});
				expect(room.queue).toHaveLength(0);
			},
		);
	});

	it("should be able to get role in unowned room", async () => {
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			username: "test",
			isLoggedIn: false,
		});

		const room = new Room({ name: "test" });
		expect(await room.getRoleFromToken("fake")).toEqual(Role.UnregisteredUser);

		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			user_id: -1,
			isLoggedIn: true,
		});

		expect(await room.getRoleFromToken("fake")).toEqual(Role.RegisteredUser);
	});

	describe("restore queue behavior", () => {
		it("should always restore the queue when behavior is always", async () => {
			const room = new Room({
				name: "test",
				prevQueue: [{ service: "direct", id: "foo" }],
				restoreQueueBehavior: BehaviorOption.Always,
			});

			expect(room.queue.items).toEqual([{ service: "direct", id: "foo" }]);
			expect(room.prevQueue).toBeNull();
		});

		it("should never restore the queue when behavior is never", async () => {
			const room = new Room({
				name: "test",
				prevQueue: [{ service: "direct", id: "foo" }],
				restoreQueueBehavior: BehaviorOption.Never,
			});

			expect(room.queue.items).toEqual([]);
			expect(room.prevQueue).toBeNull();
		});

		it("should never overwrite an existing queue when behavior is always", async () => {
			const room = new Room({
				name: "test",
				// @ts-expect-error testing restoring from redis
				queue: [{ service: "direct", id: "bar" }],
				prevQueue: [{ service: "direct", id: "foo" }],
				restoreQueueBehavior: BehaviorOption.Always,
			});

			expect(room.queue.items).toEqual([{ service: "direct", id: "bar" }]);
		});
	});

	describe("vote skip", () => {
		it("should add a vote when vote skip is enabled", async () => {
			const room = new Room({
				name: "test",
				enableVoteSkip: true,
			});
			room.currentSource = { service: "direct", id: "foo" };
			room.realusers = [
				new RoomUser("user", "a"),
				new RoomUser("user2", "b"),
				new RoomUser("user3", "c"),
			];

			await room.processRequest(
				{
					type: RoomRequestType.SkipRequest,
				},
				{
					username: "user",
					role: Role.UnregisteredUser,
					clientId: "user",
				},
			);

			expect(room.currentSource).toEqual({ service: "direct", id: "foo" });
			expect(room.votesToSkip.has("user")).toEqual(true);
		});

		it("should skip when enough votes are cast", async () => {
			const room = new Room({
				name: "test",
				enableVoteSkip: true,
			});
			room.currentSource = { service: "direct", id: "foo" };
			room.realusers = [
				new RoomUser("user", "a"),
				new RoomUser("user2", "b"),
				new RoomUser("user3", "c"),
			];

			await room.processRequest(
				{
					type: RoomRequestType.SkipRequest,
				},
				{
					username: "user",
					role: Role.UnregisteredUser,
					clientId: "user",
				},
			);
			await room.processRequest(
				{
					type: RoomRequestType.SkipRequest,
				},
				{
					username: "user2",
					role: Role.UnregisteredUser,
					clientId: "user2",
				},
			);

			expect(room.currentSource).toEqual(null);
			expect(room.votesToSkip.size).toEqual(0);
		});
	});
});

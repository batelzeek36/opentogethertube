import { type RoomRequest, RoomRequestType } from "ott-common/models/messages.js";
import {
	CHAT_MESSAGE_LENGTH_MAX,
	PLAYBACK_SPEED_MAX,
	PLAYBACK_SPEED_MIN,
} from "ott-common/constants.js";
import { PlayerStatus, Role } from "ott-common/models/types.js";
import { RoomSettingsSchema, VideoAddSchema } from "ott-common/models/zod-schemas.js";
import { z } from "zod";

const QueueIndex = z.number().int().nonnegative();

/**
 * Which room requests a client may send over its socket, and what each has to look like. A socket
 * has no schema in front of it the way REST does, and these values end up in the room's state and on
 * everyone else's screen, so this is the only thing between one person's junk and all of them.
 *
 * null means a client can never send it:
 * - Joining, leaving and updating a user say who someone is, so only the server builds those, from
 *   the session behind the client's auth token.
 * - Adding, removing, voting and editing queue items have REST routes, which rate limit them. The
 *   client has never sent them here.
 *
 * Fields a room checks for itself, so it can tell the sender why, stay unknown here. This is a Record
 * so a new request type does not compile until someone decides which side it is on.
 */
const CLIENT_REQUEST_SCHEMAS: Record<RoomRequestType, z.ZodObject<z.ZodRawShape> | null> = {
	[RoomRequestType.JoinRequest]: null,
	[RoomRequestType.LeaveRequest]: null,
	[RoomRequestType.UpdateUser]: null,
	[RoomRequestType.AddRequest]: null,
	[RoomRequestType.RemoveRequest]: null,
	[RoomRequestType.VoteRequest]: null,
	[RoomRequestType.UpdateQueueItemRequest]: null,
	[RoomRequestType.PlaybackRequest]: z.object({ state: z.boolean() }),
	[RoomRequestType.SkipRequest]: z.object({}),
	[RoomRequestType.SeekRequest]: z.object({ value: z.number().finite() }),
	[RoomRequestType.OrderRequest]: z.object({ fromIdx: QueueIndex, toIdx: QueueIndex }),
	[RoomRequestType.PromoteRequest]: z.object({
		targetClientId: z.string(),
		role: z.nativeEnum(Role),
	}),
	[RoomRequestType.ChatRequest]: z.object({
		text: z.string().min(1).max(CHAT_MESSAGE_LENGTH_MAX),
	}),
	[RoomRequestType.UndoRequest]: z.object({ eventId: z.string() }),
	// Grants are built from a class on the REST route, and never come as plain JSON from a client.
	[RoomRequestType.ApplySettingsRequest]: z.object({
		settings: RoomSettingsSchema.omit({ grants: true }),
	}),
	[RoomRequestType.PlayNowRequest]: z.object({ video: VideoAddSchema }),
	[RoomRequestType.ShuffleRequest]: z.object({}),
	[RoomRequestType.PlaybackSpeedRequest]: z.object({
		speed: z.number().min(PLAYBACK_SPEED_MIN).max(PLAYBACK_SPEED_MAX),
	}),
	[RoomRequestType.RestoreQueueRequest]: z.object({ discard: z.boolean().optional() }),
	[RoomRequestType.KickRequest]: z.object({ clientId: z.string() }),
	[RoomRequestType.ReactionRequest]: z.object({ emoji: z.unknown() }),
	[RoomRequestType.VoiceJoinRequest]: z.object({ channel: z.unknown() }),
	[RoomRequestType.VoiceLeaveRequest]: z.object({}),
	[RoomRequestType.VoiceTalkRequest]: z.object({ talking: z.boolean() }),
	[RoomRequestType.VoiceRemoveRequest]: z.object({ clientId: z.string() }),
	[RoomRequestType.VoiceAllowRequest]: z.object({ clientId: z.string() }),
	[RoomRequestType.ChatReactionRequest]: z.object({
		messageId: z.unknown(),
		emoji: z.unknown(),
		add: z.unknown(),
	}),
};

/**
 * Whether a client may send this kind of request. It arrives as parsed JSON, so nothing about it can
 * be assumed.
 *
 * The type has to be an actual number. Rooms look up a request's handler by property name, where
 * "10" and [10] also find handler 10, but look up its permission in a Map, where they find nothing.
 * Letting either through would run the handler with no permission check at all.
 */
export function isClientSendableRequest(request: unknown): boolean {
	if (typeof request !== "object" || request === null) {
		return false;
	}
	const { type } = request as { type?: unknown };
	return typeof type === "number" && Boolean(CLIENT_REQUEST_SCHEMAS[type as RoomRequestType]);
}

/**
 * The request to act on, holding only the fields that request type has, or null if a client may not
 * send this.
 */
export function parseClientRequest(request: unknown): RoomRequest | null {
	if (!isClientSendableRequest(request)) {
		return null;
	}
	const { type } = request as { type: RoomRequestType };
	const parsed = CLIENT_REQUEST_SCHEMAS[type]?.safeParse(request);
	return parsed?.success ? ({ ...parsed.data, type } as RoomRequest) : null;
}

const PLAYER_STATUSES: readonly unknown[] = Object.values(PlayerStatus);

/**
 * Whether a client's status message says something real. A status goes to everyone in the room, so
 * anything else would be put in front of them.
 */
export function isPlayerStatus(status: unknown): status is PlayerStatus {
	return PLAYER_STATUSES.includes(status);
}

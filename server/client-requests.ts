import { RoomRequestType } from "ott-common/models/messages.js";

/**
 * Which room requests a client may send over its socket. Joining, leaving and updating a user say
 * who someone is, so only the server builds those, from the session behind the client's auth token.
 *
 * This is a Record so a new request type does not compile until someone decides which side it is on.
 */
const SENDABLE_BY_CLIENTS: Record<RoomRequestType, boolean> = {
	[RoomRequestType.JoinRequest]: false,
	[RoomRequestType.LeaveRequest]: false,
	[RoomRequestType.UpdateUser]: false,
	[RoomRequestType.PlaybackRequest]: true,
	[RoomRequestType.SkipRequest]: true,
	[RoomRequestType.SeekRequest]: true,
	[RoomRequestType.AddRequest]: true,
	[RoomRequestType.RemoveRequest]: true,
	[RoomRequestType.OrderRequest]: true,
	[RoomRequestType.VoteRequest]: true,
	[RoomRequestType.PromoteRequest]: true,
	[RoomRequestType.ChatRequest]: true,
	[RoomRequestType.UndoRequest]: true,
	[RoomRequestType.ApplySettingsRequest]: true,
	[RoomRequestType.PlayNowRequest]: true,
	[RoomRequestType.ShuffleRequest]: true,
	[RoomRequestType.PlaybackSpeedRequest]: true,
	[RoomRequestType.RestoreQueueRequest]: true,
	[RoomRequestType.KickRequest]: true,
	[RoomRequestType.UpdateQueueItemRequest]: true,
	[RoomRequestType.ReactionRequest]: true,
	[RoomRequestType.VoiceJoinRequest]: true,
	[RoomRequestType.VoiceLeaveRequest]: true,
	[RoomRequestType.VoiceTalkRequest]: true,
	[RoomRequestType.VoiceRemoveRequest]: true,
	[RoomRequestType.VoiceAllowRequest]: true,
	[RoomRequestType.ChatReactionRequest]: true,
};

/**
 * Whether a client may send this request. It arrives as parsed JSON, so nothing about it can be
 * assumed.
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
	return typeof type === "number" && Boolean(SENDABLE_BY_CLIENTS[type as RoomRequestType]);
}

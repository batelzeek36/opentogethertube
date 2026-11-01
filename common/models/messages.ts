import type { Category, Segment } from "sponsorblock-api";
import type {
	ClientId,
	ClientInfo,
	QueueMode,
	RoomUserInfo,
	Visibility,
	PlayerStatus,
	Role,
	RoomEventContext,
	RoomSettings,
	AuthToken,
	BehaviorOption,
} from "./types.js";
import type { QueueItem, QueueItemExtras, VideoId, VideoAdd } from "./video.js";
import type { ChatMessageId, ChatReactionCount, Reaction } from "./reactions.js";
import type { DeviceType } from "./device.js";
import type { VoiceChannelId, VoiceYouEvent } from "./voice.js";

export type ServerMessage =
	| ServerMessageSync
	| ServerMessageUnload
	| ServerMessageChat
	| ServerMessageReaction
	| ServerMessageChatReactions
	| ServerMessageEvent
	| ServerMessageEventCustom
	| ServerMessageAnnouncement
	| ServerMessageUser
	| ServerMessageYou
	| ServerMessageVoice
	| ServerMessageVoiceYou;

export type ServerMessageActionType = ServerMessage["action"];

interface ServerMessageBase {
	action: string;
}

export interface ServerMessageSync extends ServerMessageBase {
	action: "sync";
	name?: string;
	title?: string;
	description?: string;
	isTemporary?: boolean;
	visibility?: Visibility;
	queueMode?: QueueMode;
	isPlaying?: boolean;
	playbackPosition?: number;
	currentSource?: QueueItem | null;
	queue?: QueueItem[];
	prevQueue?: QueueItem[] | null;
	grants?: [Role, number][];
	playbackSpeed?: number;
	voteCounts?: [string, number][];
	hasOwner?: boolean;
	enableVoteSkip?: boolean;
	votesToSkip?: string[];
	autoSkipSegmentCategories?: Category[];
	videoSegments?: Segment[];
	restoreQueueBehavior?: BehaviorOption;
	voiceEnabled?: boolean;
	voiceMaxTalkSeconds?: number;
	voiceSlowModeSeconds?: number;
}

/**
 * The server has unloaded the room, and all clients should be disconnected, and not try to reconnect.
 * This message is not actually sent through the websocket, but instead tells the client manager to disconnect all clients
 * with the appropriate status code.
 */
export interface ServerMessageUnload extends ServerMessageBase {
	action: "unload";
}

export interface ServerMessageChat extends ServerMessageBase {
	action: "chat";
	/** What reactions refer to. A server from before reactions sends none. */
	id?: ChatMessageId;
	from: RoomUserInfo;
	text: string;
}

export interface ServerMessageReaction extends ServerMessageBase {
	action: "reaction";
	from: RoomUserInfo;
	emoji: Reaction;
}

/** Reactions on chat messages, worded for the one client it is sent to. */
export interface ServerMessageChatReactions extends ServerMessageBase {
	action: "chat-reactions";
	/** The full current reactions of each message listed. */
	messages: { id: ChatMessageId; reactions: ChatReactionCount[] }[];
	/** Everything the room remembers, so a message not listed has no reactions. */
	complete?: boolean;
	/** Messages the room no longer remembers, which can no longer be reacted to. */
	closed?: ChatMessageId[];
}

export interface ServerMessageEvent extends ServerMessageBase {
	action: "event";
	request: RoomRequest;
	user: Pick<RoomUserInfo, "name" | "isLoggedIn">;
	additional: RoomEventContext;
}

export interface ServerMessageEventCustom extends ServerMessageBase {
	action: "eventcustom";
	text: string;
	duration?: number;
}

export interface ServerMessageAnnouncement extends ServerMessageBase {
	action: "announcement";
	text: string;
}

export interface ServerMessageUser extends ServerMessageBase {
	action: "user";
	update: UserUpdate;
}

export interface ServerMessageYou extends ServerMessageBase {
	action: "you";
	info: {
		id: ClientId;
	};
}

/**
 * Who is in each voice channel and who is talking, sent to the whole room whenever it changes.
 * Carries no audio: audio only ever goes to the members of a channel, as binary frames.
 */
export interface ServerMessageVoice extends ServerMessageBase {
	action: "voice";
	channels: { id: VoiceChannelId; members: ClientId[]; speaker: ClientId | null }[];
	/** Connected clients the mod has removed from voice. */
	removed: ClientId[];
}

/** Something about voice that only concerns the client it is sent to. */
export type ServerMessageVoiceYou = ServerMessageBase & { action: "voice-you" } & VoiceYouEvent;

export type UserUpdate =
	| {
			kind: "init";
			value: RoomUserInfo[];
	  }
	| {
			// can be used to update an existing user, or add a new user
			kind: "update";
			value: PartialUserInfo;
	  }
	| {
			kind: "remove";
			value: ClientId;
	  };

export type PartialUserInfo = Required<Pick<RoomUserInfo, "id">> &
	Partial<Omit<RoomUserInfo, "id">>;

/** @deprecated: should no longer be used */
export interface UserInfo extends RoomUserInfo {
	grants: number;
}

export type ClientMessage =
	| ClientMessageKickMe
	| ClientMessagePlayerStatus
	| ClientMessageDevice
	| ClientMessageAuthenticate
	| ClientMessageNotify
	| ClientMessageRoomRequest;

interface ClientMessageBase {
	action: string;
}

export interface ClientMessageKickMe extends ClientMessageBase {
	action: "kickme";
	reason?: number;
}

/**
 * Inform the server of the client's video player status.
 */
export interface ClientMessagePlayerStatus extends ClientMessageBase {
	action: "status";
	status: PlayerStatus;
}

/** Inform the server what kind of device this is, so people can tell someone's devices apart. */
export interface ClientMessageDevice extends ClientMessageBase {
	action: "device";
	device: DeviceType;
}

export interface ClientMessageAuthenticate extends ClientMessageBase {
	action: "auth";
	token: AuthToken;
}

/**
 * Used to notify the monolith of events that occur on the client that imply a change in state that needs to be propagated to other clients.
 *
 * Currently only used to notify the monolith of a username change.
 */
export interface ClientMessageNotify extends ClientMessageBase {
	action: "notify";
	message: "usernameChanged";
}

export interface ClientMessageRoomRequest extends ClientMessageBase {
	action: "req";
	request: RoomRequest;
}

/**
 * Provides a user's authorization for a room request. This is NOT safe to send to the client.
 */
export interface RoomRequestAuthorization {
	token: AuthToken;
	clientId?: ClientId;
}

/**
 * When a room request is authorized, this information can be safely derived from the token. This information is safe to send to the client.
 */
export interface RoomRequestContext {
	username: string;
	role: Role;
	/** If the user is connected to the room, then we can use it's client id to identify the websocket connection. */
	clientId?: ClientId;
	auth?: RoomRequestAuthorization;
}

export type RoomRequest =
	| JoinRequest
	| LeaveRequest
	| PlaybackRequest
	| SkipRequest
	| SeekRequest
	| AddRequest
	| RemoveRequest
	| OrderRequest
	| VoteRequest
	| PromoteRequest
	| UpdateUser
	| ChatRequest
	| UndoRequest
	| ApplySettingsRequest
	| PlayNowRequest
	| ShuffleRequest
	| PlaybackSpeedRequest
	| RestoreQueueRequest
	| KickRequest
	| UpdateQueueItemRequest
	| ReactionRequest
	| VoiceJoinRequest
	| VoiceLeaveRequest
	| VoiceTalkRequest
	| VoiceRemoveRequest
	| VoiceAllowRequest
	| ChatReactionRequest;

export enum RoomRequestType {
	JoinRequest,
	LeaveRequest,
	PlaybackRequest,
	SkipRequest,
	SeekRequest,
	AddRequest,
	RemoveRequest,
	OrderRequest,
	VoteRequest,
	PromoteRequest,
	UpdateUser,
	ChatRequest,
	UndoRequest,
	ApplySettingsRequest,
	PlayNowRequest,
	ShuffleRequest,
	PlaybackSpeedRequest,
	RestoreQueueRequest,
	KickRequest,
	UpdateQueueItemRequest,
	ReactionRequest,
	VoiceJoinRequest,
	VoiceLeaveRequest,
	VoiceTalkRequest,
	VoiceRemoveRequest,
	VoiceAllowRequest,
	// New types go last: open tabs send these numbers, so existing ones can never shift.
	ChatReactionRequest,
}

export interface RoomRequestBase {
	type: RoomRequestType;
}

export interface JoinRequest extends RoomRequestBase {
	type: RoomRequestType.JoinRequest;
	info: ClientInfo;
}

export interface LeaveRequest extends RoomRequestBase {
	type: RoomRequestType.LeaveRequest;
}

export interface PlaybackRequest extends RoomRequestBase {
	type: RoomRequestType.PlaybackRequest;
	state: boolean;
}

export interface SkipRequest extends RoomRequestBase {
	type: RoomRequestType.SkipRequest;
}

export interface SeekRequest extends RoomRequestBase {
	type: RoomRequestType.SeekRequest;
	value: number;
}

export interface AddRequest extends RoomRequestBase {
	type: RoomRequestType.AddRequest;
	video?: VideoAdd;
	videos?: VideoAdd[];
	url?: string;
}

export interface RemoveRequest extends RoomRequestBase {
	type: RoomRequestType.RemoveRequest;
	video: VideoId;
}

export interface UpdateQueueItemRequest extends RoomRequestBase {
	type: RoomRequestType.UpdateQueueItemRequest;
	video: VideoId;
	update: QueueItemExtras;
}

export interface OrderRequest extends RoomRequestBase {
	type: RoomRequestType.OrderRequest;
	fromIdx: number;
	toIdx: number;
}

export interface VoteRequest extends RoomRequestBase {
	type: RoomRequestType.VoteRequest;
	video: VideoId;
	add: boolean;
}

export interface PromoteRequest extends RoomRequestBase {
	type: RoomRequestType.PromoteRequest;
	targetClientId: ClientId;
	role: Role;
}

/**
 * Request that the client manager pull new information about the user, and inform rooms.
 */
export interface UpdateUser extends RoomRequestBase {
	type: RoomRequestType.UpdateUser;
	info: ClientInfo;
}

export interface ChatRequest extends RoomRequestBase {
	type: RoomRequestType.ChatRequest;
	text: string;
}

export interface ReactionRequest extends RoomRequestBase {
	type: RoomRequestType.ReactionRequest;
	emoji: Reaction;
}

/** Add or take back this person's reaction on a chat message. */
export interface ChatReactionRequest extends RoomRequestBase {
	type: RoomRequestType.ChatReactionRequest;
	messageId: ChatMessageId;
	emoji: Reaction;
	add: boolean;
}

export interface VoiceJoinRequest extends RoomRequestBase {
	type: RoomRequestType.VoiceJoinRequest;
	channel: VoiceChannelId;
}

export interface VoiceLeaveRequest extends RoomRequestBase {
	type: RoomRequestType.VoiceLeaveRequest;
}

/** Press (true) or let go of (false) the talk button. */
export interface VoiceTalkRequest extends RoomRequestBase {
	type: RoomRequestType.VoiceTalkRequest;
	talking: boolean;
}

/** Take someone out of voice and keep them out until a mod allows them back. */
export interface VoiceRemoveRequest extends RoomRequestBase {
	type: RoomRequestType.VoiceRemoveRequest;
	clientId: ClientId;
}

/** Let someone who was removed from voice join again. */
export interface VoiceAllowRequest extends RoomRequestBase {
	type: RoomRequestType.VoiceAllowRequest;
	clientId: ClientId;
}

export interface UndoRequest extends RoomRequestBase {
	type: RoomRequestType.UndoRequest;
	event: ServerMessageEvent;
}

export interface ApplySettingsRequest extends RoomRequestBase {
	type: RoomRequestType.ApplySettingsRequest;
	settings: Partial<RoomSettings>;
}

/**
 * Request that the room play a video immediately, pushing the current video to the queue. If the video is already in the queue, it will be removed from the queue and start playing. If the video is already playing, this will be ignored.
 */
export interface PlayNowRequest extends RoomRequestBase {
	type: RoomRequestType.PlayNowRequest;
	video: VideoAdd;
}

export interface ShuffleRequest extends RoomRequestBase {
	type: RoomRequestType.ShuffleRequest;
}

export interface PlaybackSpeedRequest extends RoomRequestBase {
	type: RoomRequestType.PlaybackSpeedRequest;
	speed: number;
}

export interface RestoreQueueRequest extends RoomRequestBase {
	type: RoomRequestType.RestoreQueueRequest;
	discard?: boolean;
}

export interface KickRequest extends RoomRequestBase {
	type: RoomRequestType.KickRequest;
	clientId: ClientId;
}

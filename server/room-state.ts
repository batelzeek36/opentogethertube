import type { GrantMask } from "ott-common/permissions.js";
import type { ClientId, Role, RoomOptions, RoomUserInfo } from "ott-common/models/types.js";
import type { QueueItem } from "ott-common/models/video.js";
import type { Dayjs } from "dayjs";
import type { Segment } from "sponsorblock-api";
import type { VideoQueue } from "./videoqueue.js";

/**
 * Things that Rooms need to remember, but can safely be forgotten when the room is unloaded.
 * This rule does not necessarily apply to inherited fields.
 */
export interface RoomState extends RoomOptions, RoomStateComputed {
	currentSource: QueueItem | null;
	queue: VideoQueue;
	isPlaying: boolean;
	playbackPosition: number;
	playbackSpeed: number;
	users: RoomUserInfo[];
	votes: Map<string, Set<ClientId>>;
	votesToSkip: Set<ClientId>;
	videoSegments: Segment[];
}

export type RoomStateFromRedis = Omit<RoomState, "userRoles" | "grants"> & {
	grants: [Role, GrantMask][];
	userRoles: [Role, number[]][];
};

export interface RoomStateComputed {
	hasOwner: boolean;
	voteCounts: Map<string, number>;
}

// Only these should be sent to clients, all others should be considered unsafe
export type RoomStateSyncable = Omit<RoomState, "owner" | "votes" | "userRoles" | "users">;

// Only these should be stored in redis
export type RoomStateStorable = Omit<
	RoomState,
	"hasOwner" | "votes" | "voteCounts" | "users" | "votesToSkip"
> & { _playbackStart: Dayjs | null };

export const syncableProps: (keyof RoomStateSyncable)[] = [
	"name",
	"title",
	"description",
	"isTemporary",
	"visibility",
	"queueMode",
	"currentSource",
	"queue",
	"isPlaying",
	"playbackPosition",
	"playbackSpeed",
	"grants",
	"hasOwner",
	"voteCounts",
	"videoSegments",
	"autoSkipSegmentCategories",
	"prevQueue",
	"restoreQueueBehavior",
	"enableVoteSkip",
	"voiceEnabled",
	"voiceMaxTalkSeconds",
	"voiceSlowModeSeconds",
	"votesToSkip",
];

export const storableProps: (keyof RoomStateStorable)[] = [
	"name",
	"title",
	"description",
	"isTemporary",
	"visibility",
	"queueMode",
	"currentSource",
	"queue",
	"isPlaying",
	"playbackPosition",
	"playbackSpeed",
	"grants",
	"userRoles",
	"owner",
	"_playbackStart",
	"videoSegments",
	"autoSkipSegmentCategories",
	"prevQueue",
	"restoreQueueBehavior",
	"enableVoteSkip",
	"voiceEnabled",
	"voiceMaxTalkSeconds",
	"voiceSlowModeSeconds",
];

/** Only these should be stored in persistent storage */
export type RoomStatePersistable = Omit<
	RoomState,
	| "isTemporary"
	| "currentSource"
	| "queue"
	| "isPlaying"
	| "playbackPosition"
	| "playbackSpeed"
	| "users"
	| "votes"
	| "videoSegments"
	| "hasOwner"
	| "voteCounts"
	| "votesToSkip"
>;

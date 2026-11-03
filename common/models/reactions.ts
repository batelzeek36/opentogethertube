export const REACTIONS = ["❤️", "😂", "😱", "😭", "🔥", "👏", "🎃", "👻"] as const;

export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is Reaction {
	return REACTIONS.includes(value as Reaction);
}

/** Given to each chat message by the server. Messages from before this existed have none. */
export type ChatMessageId = string;

/** One chip under a chat message, as seen by the person it is sent to. */
export interface ChatReactionCount {
	emoji: Reaction;
	count: number;
	mine: boolean;
}

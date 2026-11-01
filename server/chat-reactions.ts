import type {
	ChatReactionRequest,
	ServerMessageChatReactions,
} from "ott-common/models/messages.js";
import {
	type ChatMessageId,
	type ChatReactionCount,
	REACTIONS,
	type Reaction,
	isReaction,
} from "ott-common/models/reactions.js";
import type { ClientId } from "ott-common/models/types.js";
import { randomUUID } from "node:crypto";
import { getLogger } from "./logger.js";

const log = getLogger("chat-reactions");

/** How many of a room's latest chat messages can be reacted to. Older ones lose their reactions. */
export const CHAT_REACTION_MAX_MESSAGES = 200;
/** How many reaction changes a client can make at once, far beyond what thumbs can do. */
export const CHAT_REACTION_BURST = 10;
/** How fast that allowance comes back. */
export const CHAT_REACTION_PER_SECOND = 4;

/** What chat reactions need from the room they belong to. */
export interface ChatReactionsHost {
	/** Identifies a person across reloads, or undefined if the client is not in the room. */
	personKey(clientId: ClientId): string | undefined;
	clientIds(): ClientId[];
	sendTo(clientId: ClientId, msg: ServerMessageChatReactions): void;
}

interface Allowance {
	tokens: number;
	updatedAt: number;
}

type MessageReactions = Map<Reaction, Set<string>>;

/**
 * The reactions on one room's chat messages, held in memory only, like chat itself.
 *
 * Each person counts once per emoji, whichever device or reload it comes from. Person keys stay in
 * here: each client is only told the counts and which of them are its own, so every change goes out
 * as a separate message per client rather than one broadcast.
 */
export class ChatReactions {
	/** Oldest first, since a Map keeps insertion order. */
	private messages = new Map<ChatMessageId, MessageReactions>();
	private allowances = new Map<ClientId, Allowance>();

	constructor(private host: ChatReactionsHost) {}

	/** A chat message is going out. Returns the id it goes out with. */
	addMessage(): ChatMessageId {
		const id = randomUUID();
		this.messages.set(id, new Map());
		if (this.messages.size > CHAT_REACTION_MAX_MESSAGES) {
			const oldest = this.messages.keys().next().value;
			if (oldest !== undefined) {
				this.messages.delete(oldest);
			}
		}
		return id;
	}

	/**
	 * Add or take back this person's reaction. The request is whatever the client sent, whatever its
	 * type says. Anything invalid is dropped without reaching anyone.
	 */
	setReaction(clientId: ClientId, request: Omit<ChatReactionRequest, "type">): void {
		const { messageId, emoji, add } = request;
		const person = this.host.personKey(clientId);
		if (person === undefined || !this.takeAllowance(clientId)) {
			return;
		}
		if (typeof messageId !== "string" || !isReaction(emoji) || typeof add !== "boolean") {
			log.debug(`ignoring a malformed chat reaction from client ${clientId}`);
			return;
		}
		const reactions = this.messages.get(messageId);
		if (!reactions) {
			// Past the cap, or from before a restart. Lets the client stop offering it.
			this.host.sendTo(clientId, {
				action: "chat-reactions",
				messages: [],
				closed: [messageId],
			});
			return;
		}
		if (this.applyChange(reactions, person, emoji, add)) {
			this.publish(messageId, reactions);
		}
	}

	/** Bring a client that just joined up to date, including one coming back from a dropped connection. */
	sendAllTo(clientId: ClientId): void {
		const person = this.host.personKey(clientId);
		const messages: ServerMessageChatReactions["messages"] = [];
		for (const [id, reactions] of this.messages) {
			if (reactions.size > 0) {
				messages.push({ id, reactions: this.countsFor(reactions, person) });
			}
		}
		this.host.sendTo(clientId, { action: "chat-reactions", messages, complete: true });
	}

	/** The client left the room. Its reactions stay, they belong to the person. */
	forgetClient(clientId: ClientId): void {
		this.allowances.delete(clientId);
	}

	private applyChange(
		reactions: MessageReactions,
		person: string,
		emoji: Reaction,
		add: boolean,
	): boolean {
		const people = reactions.get(emoji);
		if (!add) {
			const removed = people?.delete(person) ?? false;
			if (people?.size === 0) {
				reactions.delete(emoji);
			}
			return removed;
		}
		if (people?.has(person)) {
			return false;
		}
		if (people) {
			people.add(person);
		} else {
			reactions.set(emoji, new Set([person]));
		}
		return true;
	}

	private publish(messageId: ChatMessageId, reactions: MessageReactions): void {
		for (const clientId of this.host.clientIds()) {
			this.host.sendTo(clientId, {
				action: "chat-reactions",
				messages: [
					{
						id: messageId,
						reactions: this.countsFor(reactions, this.host.personKey(clientId)),
					},
				],
			});
		}
	}

	/** In the order of the reaction bar, so chips never swap places as counts change. */
	private countsFor(reactions: MessageReactions, person?: string): ChatReactionCount[] {
		const counts: ChatReactionCount[] = [];
		for (const emoji of REACTIONS) {
			const people = reactions.get(emoji);
			if (people) {
				counts.push({
					emoji,
					count: people.size,
					mine: person !== undefined && people.has(person),
				});
			}
		}
		return counts;
	}

	private takeAllowance(clientId: ClientId): boolean {
		const now = Date.now();
		const allowance = this.allowances.get(clientId) ?? {
			tokens: CHAT_REACTION_BURST,
			updatedAt: now,
		};
		const earned = ((now - allowance.updatedAt) / 1000) * CHAT_REACTION_PER_SECOND;
		allowance.tokens = Math.min(CHAT_REACTION_BURST, allowance.tokens + earned);
		allowance.updatedAt = now;
		this.allowances.set(clientId, allowance);
		if (allowance.tokens < 1) {
			return false;
		}
		allowance.tokens -= 1;
		return true;
	}
}

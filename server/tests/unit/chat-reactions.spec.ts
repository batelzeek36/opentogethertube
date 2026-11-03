import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessageChatReactions } from "ott-common/models/messages.js";
import type { ClientId } from "ott-common/models/types.js";
import {
	CHAT_REACTION_BURST,
	CHAT_REACTION_MAX_MESSAGES,
	CHAT_REACTION_PER_SECOND,
	ChatReactions,
} from "../../chat-reactions.js";

describe("ChatReactions", () => {
	let people: Map<ClientId, string>;
	let sent: Map<ClientId, ServerMessageChatReactions[]>;
	let reactions: ChatReactions;

	const lastTo = (id: ClientId) => sent.get(id)?.at(-1);
	const chipsTo = (id: ClientId) => lastTo(id)?.messages[0]?.reactions;
	const countSent = () => [...sent.values()].reduce((sum, list) => sum + list.length, 0);

	beforeEach(() => {
		vi.useFakeTimers();
		people = new Map([
			["a", "person-a"],
			["b", "person-b"],
		]);
		sent = new Map();
		reactions = new ChatReactions({
			personKey: id => people.get(id),
			clientIds: () => [...people.keys()],
			sendTo: (id, msg) => sent.set(id, [...(sent.get(id) ?? []), msg]),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("gives every message its own id", () => {
		expect(reactions.addMessage()).not.toEqual(reactions.addMessage());
	});

	it("tells everyone the count, and each person which chips are theirs", () => {
		const id = reactions.addMessage();
		reactions.setReaction("a", { messageId: id, emoji: "😂", add: true });
		expect(lastTo("a")?.messages[0].id).toEqual(id);
		expect(chipsTo("a")).toEqual([{ emoji: "😂", count: 1, mine: true }]);
		expect(chipsTo("b")).toEqual([{ emoji: "😂", count: 1, mine: false }]);
		reactions.setReaction("b", { messageId: id, emoji: "😂", add: true });
		expect(chipsTo("a")).toEqual([{ emoji: "😂", count: 2, mine: true }]);
		expect(chipsTo("b")).toEqual([{ emoji: "😂", count: 2, mine: true }]);
	});

	it("never sends a person key to a client", () => {
		const id = reactions.addMessage();
		reactions.setReaction("a", { messageId: id, emoji: "😂", add: true });
		reactions.sendAllTo("b");
		expect(JSON.stringify([...sent.values()])).not.toContain("person-");
	});

	it("lets one person add several different emoji, each once", () => {
		const id = reactions.addMessage();
		reactions.setReaction("a", { messageId: id, emoji: "🔥", add: true });
		reactions.setReaction("a", { messageId: id, emoji: "❤️", add: true });
		const before = countSent();
		reactions.setReaction("a", { messageId: id, emoji: "🔥", add: true });
		expect(countSent()).toEqual(before);
		// In reaction bar order, not the order they were added in.
		expect(chipsTo("b")).toEqual([
			{ emoji: "❤️", count: 1, mine: false },
			{ emoji: "🔥", count: 1, mine: false },
		]);
	});

	it("counts a person once across reloads and devices", () => {
		const id = reactions.addMessage();
		reactions.setReaction("a", { messageId: id, emoji: "🔥", add: true });
		people.delete("a");
		reactions.forgetClient("a");
		people.set("a-after-reload", "person-a");
		reactions.setReaction("a-after-reload", { messageId: id, emoji: "🔥", add: true });
		expect(chipsTo("b")).toEqual([{ emoji: "🔥", count: 1, mine: false }]);
		reactions.setReaction("a-after-reload", { messageId: id, emoji: "🔥", add: false });
		expect(chipsTo("b")).toEqual([]);
	});

	it("does not let one person take back another's reaction", () => {
		const id = reactions.addMessage();
		reactions.setReaction("a", { messageId: id, emoji: "🔥", add: true });
		const before = countSent();
		reactions.setReaction("b", { messageId: id, emoji: "🔥", add: false });
		expect(countSent()).toEqual(before);
	});

	it("keeps a reaction after the person leaves", () => {
		const id = reactions.addMessage();
		reactions.setReaction("a", { messageId: id, emoji: "🔥", add: true });
		people.delete("a");
		reactions.forgetClient("a");
		reactions.sendAllTo("b");
		expect(chipsTo("b")).toEqual([{ emoji: "🔥", count: 1, mine: false }]);
	});

	describe("refuses", () => {
		it.each([
			["an unknown emoji", { emoji: "<img src=x>", add: true }],
			["a missing emoji", { add: true }],
			["an add that is not true or false", { emoji: "🔥", add: "yes" }],
		])("%s", (_name, request) => {
			const id = reactions.addMessage();
			reactions.setReaction("a", { messageId: id, ...request } as never);
			expect(countSent()).toEqual(0);
		});

		it("a message id that is not a string", () => {
			reactions.addMessage();
			reactions.setReaction("a", { messageId: { $ne: 1 }, emoji: "🔥", add: true } as never);
			expect(countSent()).toEqual(0);
		});

		it("a client that is not in the room", () => {
			const id = reactions.addMessage();
			reactions.setReaction("stranger", { messageId: id, emoji: "🔥", add: true });
			expect(countSent()).toEqual(0);
		});

		it("an unknown message, telling only the sender to stop offering it", () => {
			reactions.setReaction("a", { messageId: "gone", emoji: "🔥", add: true });
			expect(lastTo("a")).toEqual({
				action: "chat-reactions",
				messages: [],
				closed: ["gone"],
			});
			expect(lastTo("b")).toBeUndefined();
		});
	});

	describe("rate limit", () => {
		const spam = (id: string, emoji: "🔥" | "❤️", client: ClientId, times: number) => {
			for (let i = 0; i < times; i++) {
				reactions.setReaction(client, { messageId: id, emoji, add: i % 2 === 0 });
			}
		};

		it("drops what one client sends past its allowance, and not another client's", () => {
			const id = reactions.addMessage();
			spam(id, "🔥", "a", CHAT_REACTION_BURST + 5);
			expect(sent.get("a")).toHaveLength(CHAT_REACTION_BURST);
			reactions.setReaction("b", { messageId: id, emoji: "❤️", add: true });
			expect(sent.get("a")).toHaveLength(CHAT_REACTION_BURST + 1);
		});

		it("gives the allowance back over time", () => {
			const id = reactions.addMessage();
			spam(id, "🔥", "a", CHAT_REACTION_BURST);
			reactions.setReaction("a", { messageId: id, emoji: "❤️", add: true });
			expect(sent.get("a")).toHaveLength(CHAT_REACTION_BURST);
			vi.advanceTimersByTime(1000 / CHAT_REACTION_PER_SECOND);
			reactions.setReaction("a", { messageId: id, emoji: "❤️", add: true });
			expect(sent.get("a")).toHaveLength(CHAT_REACTION_BURST + 1);
		});

		it("charges bad requests too", () => {
			const id = reactions.addMessage();
			for (let i = 0; i < CHAT_REACTION_BURST; i++) {
				reactions.setReaction("a", { messageId: id, emoji: "nope", add: true } as never);
			}
			reactions.setReaction("a", { messageId: id, emoji: "🔥", add: true });
			expect(countSent()).toEqual(0);
		});

		it("forgets a client that left", () => {
			const id = reactions.addMessage();
			spam(id, "🔥", "a", CHAT_REACTION_BURST);
			reactions.forgetClient("a");
			reactions.setReaction("a", { messageId: id, emoji: "❤️", add: true });
			expect(sent.get("a")).toHaveLength(CHAT_REACTION_BURST + 1);
		});
	});

	describe("memory cap", () => {
		it("forgets the oldest message past the cap, along with its reactions", () => {
			const oldest = reactions.addMessage();
			reactions.setReaction("a", { messageId: oldest, emoji: "🔥", add: true });
			for (let i = 1; i < CHAT_REACTION_MAX_MESSAGES; i++) {
				reactions.addMessage();
			}
			reactions.sendAllTo("b");
			expect(lastTo("b")?.messages.map(m => m.id)).toEqual([oldest]);

			reactions.addMessage();
			reactions.sendAllTo("b");
			expect(lastTo("b")?.messages).toEqual([]);
			reactions.setReaction("a", { messageId: oldest, emoji: "❤️", add: true });
			expect(lastTo("a")?.closed).toEqual([oldest]);
		});
	});

	describe("catching a client up", () => {
		it("sends everything with reactions, marked as complete, in that client's terms", () => {
			const reacted = reactions.addMessage();
			reactions.addMessage();
			reactions.setReaction("a", { messageId: reacted, emoji: "🔥", add: true });
			people.set("a-reconnected", "person-a");
			reactions.sendAllTo("a-reconnected");
			expect(lastTo("a-reconnected")).toEqual({
				action: "chat-reactions",
				complete: true,
				messages: [{ id: reacted, reactions: [{ emoji: "🔥", count: 1, mine: true }] }],
			});
		});

		it("says so when there is nothing, so a client clears what a restart lost", () => {
			reactions.sendAllTo("a");
			expect(lastTo("a")).toEqual({ action: "chat-reactions", complete: true, messages: [] });
		});
	});
});

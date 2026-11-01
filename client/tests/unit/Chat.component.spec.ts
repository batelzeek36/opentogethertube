import { afterEach, describe, expect, it, vi } from "vitest";
import {
	RoomRequestType,
	type ClientMessageRoomRequest,
	type ServerMessage,
} from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import Chat from "@/components/Chat.vue";
import {
	chatMessagePast,
	chatMessageRecent,
	chatOpen,
	chatReactions,
	chatReactionsClosed,
	chatUnread,
} from "@/components/chat-state";
import { mountComponent } from "./component-test-utils";

describe("Chat component", () => {
	it("opens and closes from the buttons", async () => {
		const { wrapper } = mountComponent(Chat);

		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		expect(wrapper.find('[data-cy="chat-activate"]').exists()).toBe(false);
		expect(wrapper.find('[data-cy="chat-deactivate"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(true);

		await wrapper.get('[data-cy="chat-deactivate"]').trigger("click");
		expect(wrapper.find('[data-cy="chat-activate"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(false);
	});

	it("puts the page back where it was when the chat closes", async () => {
		const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		Object.defineProperty(window, "scrollY", { configurable: true, value: 120 });
		const { wrapper } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		Object.defineProperty(window, "scrollY", { configurable: true, value: 500 });
		await wrapper.get('[data-cy="chat-deactivate"]').trigger("click");
		expect(scrollTo).toHaveBeenCalledWith({ top: 120 });
		scrollTo.mockRestore();
		Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
	});

	describe("following new messages", () => {
		function scrollState(
			el: Element,
			scrollHeight: number,
			clientHeight: number,
			scrollTop: number,
		) {
			Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
			Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
			el.scrollTop = scrollTop;
		}

		it("keeps following when content grows without the reader scrolling", async () => {
			const { wrapper } = mountComponent(Chat);
			const messages = wrapper.get(".messages");
			scrollState(messages.element, 500, 100, 400);
			await messages.trigger("scroll");
			scrollState(messages.element, 560, 100, 400);
			await messages.trigger("scroll");
			expect(wrapper.find(".to-bottom").exists()).toBe(false);
		});

		it("stops following when the reader scrolls up, and resumes at the bottom", async () => {
			const { wrapper } = mountComponent(Chat);
			const messages = wrapper.get(".messages");
			scrollState(messages.element, 500, 100, 400);
			await messages.trigger("scroll");
			scrollState(messages.element, 500, 100, 200);
			await messages.trigger("scroll");
			expect(wrapper.find(".to-bottom").exists()).toBe(true);
			scrollState(messages.element, 500, 100, 395);
			await messages.trigger("scroll");
			expect(wrapper.find(".to-bottom").exists()).toBe(false);
		});
	});

	describe("unread count", () => {
		const message = (id: string): ServerMessage => ({
			action: "chat",
			from: {
				id,
				name: id,
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text: "hi",
		});

		afterEach(() => {
			chatUnread.value = 0;
			chatMessageRecent.value = [];
		});

		it("counts messages from others while closed and clears when opened", async () => {
			const { wrapper, connection } = mountComponent(Chat);
			connection.mockReceive(message("other"));
			connection.mockReceive(message("other"));
			await wrapper.vm.$nextTick();
			expect(wrapper.get('[data-cy="chat-unread"]').text()).toBe("2");
			expect(wrapper.get('[data-cy="chat-activate"]').classes()).toContain("chat-has-unread");
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			await wrapper.get('[data-cy="chat-deactivate"]').trigger("click");
			expect(wrapper.find('[data-cy="chat-unread"]').exists()).toBe(false);
		});

		it("does not count a message while the chat is open", async () => {
			const { wrapper, connection } = mountComponent(Chat);
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			connection.mockReceive(message("other"));
			await wrapper.vm.$nextTick();
			expect(chatUnread.value).toBe(0);
		});

		it("does not count the person's own message", async () => {
			const { wrapper, connection, store } = mountComponent(Chat);
			connection.mockReceive(message(store.state.users.you.id));
			await wrapper.vm.$nextTick();
			expect(chatUnread.value).toBe(0);
		});
	});

	describe("reactions on messages", () => {
		const message = (id?: string, text = "hi"): ServerMessage => ({
			action: "chat",
			id,
			from: {
				id: "other",
				name: "other",
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text,
		});
		const chips = (
			id: string,
			reactions: { emoji: "😂" | "🔥"; count: number; mine: boolean }[],
		): ServerMessage => ({
			action: "chat-reactions",
			messages: [{ id, reactions }],
		});

		afterEach(() => {
			chatUnread.value = 0;
			chatMessageRecent.value = [];
			chatMessagePast.value = [];
			chatOpen.value = false;
			chatReactions.value = new Map();
			chatReactionsClosed.value = new Set();
		});

		async function openWithMessage() {
			const mounted = mountComponent(Chat);
			await mounted.wrapper.get('[data-cy="chat-activate"]').trigger("click");
			mounted.connection.mockReceive(message("m1"));
			await mounted.wrapper.vm.$nextTick();
			return mounted;
		}

		it("offers all eight emoji when a message is tapped, and closes on a second tap", async () => {
			const { wrapper } = await openWithMessage();
			await wrapper.get(".message").trigger("click");
			expect(wrapper.findAll('[data-cy="chat-reaction-picker"] button')).toHaveLength(8);
			await wrapper.get(".message").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("opens the row once from a tap on the words or the name", async () => {
			const { wrapper } = await openWithMessage();
			await wrapper.get(".message .text").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(true);
			await wrapper.get(".message .from").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("sends a chosen emoji and closes the row", async () => {
			const { wrapper, connection } = await openWithMessage();
			await wrapper.get(".message").trigger("click");
			await wrapper.get('[data-cy="chat-react-😂"]').trigger("click");
			expect(connection.sent).toEqual([
				{
					action: "req",
					request: {
						type: RoomRequestType.ChatReactionRequest,
						messageId: "m1",
						emoji: "😂",
						add: true,
					},
				},
			]);
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("shows chips from the server and takes back your own", async () => {
			const { wrapper, connection } = await openWithMessage();
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 2, mine: true }]));
			await wrapper.vm.$nextTick();
			const chip = wrapper.get('[data-cy="chat-reaction"]');
			expect(chip.text()).toContain("😂");
			expect(chip.text()).toContain("2");
			expect(chip.attributes("aria-pressed")).toBe("true");
			await chip.trigger("click");
			expect(connection.sent).toEqual([
				{
					action: "req",
					request: {
						type: RoomRequestType.ChatReactionRequest,
						messageId: "m1",
						emoji: "😂",
						add: false,
					},
				},
			]);
		});

		it("adds yours when tapping a chip that is only someone else's", async () => {
			const { wrapper, connection } = await openWithMessage();
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 1, mine: false }]));
			await wrapper.vm.$nextTick();
			await wrapper.get('[data-cy="chat-reaction"]').trigger("click");
			expect(connection.sent[0]).toMatchObject({ request: { emoji: "😂", add: true } });
		});

		it("removes a chip when the server says nobody is left on it", async () => {
			const { wrapper, connection } = await openWithMessage();
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 1, mine: true }]));
			await wrapper.vm.$nextTick();
			connection.mockReceive(chips("m1", []));
			await wrapper.vm.$nextTick();
			expect(wrapper.find('[data-cy="chat-reaction"]').exists()).toBe(false);
		});

		it("shows chips on a closed chat's floating message with nothing to press", async () => {
			const { wrapper, connection } = mountComponent(Chat);
			connection.mockReceive(message("m1"));
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 1, mine: false }]));
			await wrapper.vm.$nextTick();
			const chip = wrapper.get('[data-cy="chat-reaction"]');
			expect(chip.element.tagName).toBe("SPAN");
			await chip.trigger("click");
			await wrapper.get(".message").trigger("click");
			expect(connection.sent).toEqual([]);
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
			expect(wrapper.get(".message").attributes("tabindex")).toBeUndefined();
		});

		it("leaves the unread count alone", async () => {
			const { wrapper, connection } = mountComponent(Chat);
			connection.mockReceive(message("m1"));
			await wrapper.vm.$nextTick();
			expect(chatUnread.value).toBe(1);
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 1, mine: false }]));
			await wrapper.vm.$nextTick();
			expect(chatUnread.value).toBe(1);
		});

		it("stays on the bottom when a chip appears, unless the reader scrolled up", async () => {
			const { wrapper, connection } = await openWithMessage();
			const list = wrapper.get(".messages");
			const el = list.element as HTMLDivElement;
			Object.defineProperty(el, "clientHeight", { configurable: true, value: 100 });
			Object.defineProperty(el, "scrollHeight", { configurable: true, value: 300 });
			el.scrollTop = 200;
			await list.trigger("scroll");
			Object.defineProperty(el, "scrollHeight", { configurable: true, value: 330 });
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 1, mine: false }]));
			await wrapper.vm.$nextTick();
			await wrapper.vm.$nextTick();
			expect(el.scrollTop).toBe(330);

			el.scrollTop = 50;
			await list.trigger("scroll");
			connection.mockReceive(chips("m1", [{ emoji: "🔥", count: 1, mine: false }]));
			await wrapper.vm.$nextTick();
			await wrapper.vm.$nextTick();
			expect(el.scrollTop).toBe(50);
		});

		it("offers nothing on a message from a server without ids", async () => {
			const { wrapper, connection } = mountComponent(Chat);
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			connection.mockReceive(message(undefined));
			await wrapper.vm.$nextTick();
			await wrapper.get(".message").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("stops offering a message the room has forgotten", async () => {
			const { wrapper, connection } = await openWithMessage();
			await wrapper.get(".message").trigger("click");
			connection.mockReceive({ action: "chat-reactions", messages: [], closed: ["m1"] });
			await wrapper.vm.$nextTick();
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
			await wrapper.get(".message").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("clears chips a complete update no longer lists", async () => {
			const { wrapper, connection } = await openWithMessage();
			connection.mockReceive(chips("m1", [{ emoji: "😂", count: 1, mine: false }]));
			await wrapper.vm.$nextTick();
			connection.mockReceive({ action: "chat-reactions", messages: [], complete: true });
			await wrapper.vm.$nextTick();
			expect(wrapper.find('[data-cy="chat-reaction"]').exists()).toBe(false);
		});

		it("leaves a link in a message to do its own thing", async () => {
			const { wrapper, connection } = mountComponent(Chat);
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			connection.mockReceive(message("m1", "see https://example.com/video"));
			await wrapper.vm.$nextTick();
			await wrapper.get(".message a").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("closes the row when the chat closes", async () => {
			const { wrapper } = await openWithMessage();
			await wrapper.get(".message").trigger("click");
			await wrapper.get('[data-cy="chat-deactivate"]').trigger("click");
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("closes the row on a tap outside any message", async () => {
			const { wrapper } = await openWithMessage();
			await wrapper.get(".message").trigger("click");
			window.dispatchEvent(new Event("pointerdown"));
			await wrapper.vm.$nextTick();
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("offers nothing to a role without the chat permission", async () => {
			const { wrapper, store, connection } = mountComponent(Chat);
			store.state.room.grants.setRoleGrants(Role.Owner, 0);
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			connection.mockReceive(message("m1"));
			await wrapper.vm.$nextTick();
			await wrapper.get(".message").trigger("click");
			expect(wrapper.find('[data-cy="chat-reaction-picker"]').exists()).toBe(false);
		});

		it("keeps the input's focus on a touch screen", async () => {
			const matchMedia = window.matchMedia;
			window.matchMedia = ((query: string) => ({
				matches: query === "(pointer: coarse)",
			})) as unknown as typeof window.matchMedia;
			const { wrapper, connection } = mountComponent(Chat);
			await wrapper.get('[data-cy="chat-activate"]').trigger("click");
			connection.mockReceive(message("m1"));
			await wrapper.vm.$nextTick();
			const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
			wrapper.get(".message").element.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
			window.matchMedia = matchMedia;
		});
	});

	it("sends the message when enter is pressed", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await wrapper.get('[data-cy="chat-input"]').setValue("foo");
		await wrapper.get('[data-cy="chat-input"]').trigger("keydown", { key: "Enter" });

		const expected: ClientMessageRoomRequest = {
			action: "req",
			request: { type: RoomRequestType.ChatRequest, text: "foo" },
		};
		expect(connection.sent).toEqual([expected]);
	});

	it("does not send empty or escaped messages", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await wrapper.get('[data-cy="chat-input"]').trigger("keydown", { key: "Enter" });
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await wrapper.get('[data-cy="chat-input"]').setValue("foo");
		await wrapper.get('[data-cy="chat-input"]').trigger("keydown", { key: "Escape" });

		expect(connection.sent).toEqual([]);
	});

	it("displays received messages", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const message: ServerMessage = {
			action: "chat",
			from: {
				id: "1",
				name: "goober",
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text: "foo",
		};

		connection.mockReceive(message);
		await wrapper.vm.$nextTick();

		expect(wrapper.findAll(".message")).toHaveLength(1);
		expect(wrapper.get(".from").text()).toContain("goober");
		expect(wrapper.get(".text").text()).toContain("foo");
	});

	it("keeps the message list scrolled to the bottom when receiving messages", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const messages = wrapper.get(".messages").element as HTMLDivElement;
		Object.defineProperty(messages, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 300 });

		connection.mockReceive({
			action: "chat",
			from: {
				id: "1",
				name: "goober",
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text: "foo",
		});
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();

		expect(messages.scrollTop).toBe(300);
	});
});

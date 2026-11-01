import { describe, expect, it, vi } from "vitest";
import {
	RoomRequestType,
	type ClientMessageRoomRequest,
	type ServerMessage,
} from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import Chat from "@/components/Chat.vue";
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

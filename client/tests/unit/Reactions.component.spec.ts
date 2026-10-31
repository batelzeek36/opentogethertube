import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { RoomRequestType, type ServerMessage } from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import { REACTIONS } from "ott-common/models/reactions";
import { OttRoomConnectionMock, connectionInjectKey } from "@/plugins/connection";
import ReactionBar from "@/components/ReactionBar.vue";
import ReactionOverlay from "@/components/ReactionOverlay.vue";
import { mountComponent } from "./component-test-utils";

const from = {
	id: "other",
	name: "other",
	isLoggedIn: false,
	status: PlayerStatus.ready,
	role: Role.UnregisteredUser,
};

describe("ReactionBar", () => {
	it("has a labelled button for every reaction", () => {
		const { wrapper } = mountComponent(ReactionBar, {
			props: { mode: "in-video", visible: true },
		});
		const buttons = wrapper.findAll(".reaction-button");
		expect(buttons.map(b => b.text())).toEqual([...REACTIONS]);
		for (const button of buttons) {
			expect(button.attributes("aria-label")).toBeTruthy();
		}
	});

	it("sends the reaction that was tapped", async () => {
		const { wrapper, connection } = mountComponent(ReactionBar, {
			props: { mode: "in-video", visible: true },
		});
		await wrapper.get(`[data-cy="react-${REACTIONS[6]}"]`).trigger("click");
		expect(connection.sent).toEqual([
			{
				action: "req",
				request: { type: RoomRequestType.ReactionRequest, emoji: REACTIONS[6] },
			},
		]);
	});
});

describe("ReactionOverlay", () => {
	const reaction: ServerMessage = { action: "reaction", from, emoji: REACTIONS[0] };

	it("floats a received reaction and removes it when its animation ends", async () => {
		const { wrapper, connection } = mountComponent(ReactionOverlay);
		connection.mockReceive(reaction);
		await wrapper.vm.$nextTick();
		const item = wrapper.get('[data-cy="floating-reaction"]');
		expect(item.text()).toBe(REACTIONS[0]);
		await item.trigger("animationend");
		expect(wrapper.find('[data-cy="floating-reaction"]').exists()).toBe(false);
	});

	it("keeps at most 30 at once", async () => {
		const { wrapper, connection } = mountComponent(ReactionOverlay);
		for (let i = 0; i < 40; i++) {
			connection.mockReceive(reaction);
		}
		await wrapper.vm.$nextTick();
		expect(wrapper.findAll('[data-cy="floating-reaction"]')).toHaveLength(30);
	});

	it("stops listening after it unmounts", () => {
		const connection = new OttRoomConnectionMock();
		const removed = vi.spyOn(connection, "removeMessageHandler");
		const wrapper = mount(ReactionOverlay, {
			global: { provide: { [connectionInjectKey as symbol]: connection } },
		});
		wrapper.unmount();
		expect(removed).toHaveBeenCalledWith("reaction", expect.any(Function));
	});
});

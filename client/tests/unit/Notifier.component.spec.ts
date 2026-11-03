import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Notifier from "@/components/Notifier.vue";
import { ToastStyle } from "@/models/toast";
import { mountComponent } from "./component-test-utils";
import { RoomRequestType, type ServerMessageEvent } from "ott-common/models/messages";
import { Grants, parseIntoGrantMask } from "ott-common/permissions";
import { PlayerStatus, Role } from "ott-common/models/types";

const API = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/common-http", () => ({ API }));

describe("Notifier component", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders a toast notification", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test" });
		await wrapper.vm.$nextTick();

		expect(store.state.toast.notifications).toHaveLength(1);
	});

	it("renders a toast notification with a custom duration", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test", duration: 1000 });
		await wrapper.vm.$nextTick();
		expect(store.state.toast.notifications).toHaveLength(1);

		vi.advanceTimersByTime(1000);
		await wrapper.vm.$nextTick();

		expect(store.state.toast.notifications).toHaveLength(0);
	});

	for (const [toastStyle, className] of [
		[ToastStyle.Success, "bg-success"],
		[ToastStyle.Error, "bg-destructive"],
	] as const) {
		it(`renders a toast notification with ${className} style`, async () => {
			const { wrapper, store } = mountComponent(Notifier);
			store.commit("toast/CLEAR_ALL_TOASTS");
			store.commit("toast/ADD_TOAST", { content: "test", style: toastStyle });
			await wrapper.vm.$nextTick();

			expect(wrapper.get(".bar").classes()).toContain(className);
		});
	}

	it("renders toast structure used for dynamic sizing", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test", duration: 1000 });
		await wrapper.vm.$nextTick();

		expect(wrapper.get(".toast-content").text()).toContain("test");
		expect((wrapper.get(".bar").element as HTMLElement).style.animationDuration).toBe("1000ms");
	});

	it("shows a close all button if there is more than 1 toast", async () => {
		const { wrapper, store } = mountComponent(Notifier);
		store.commit("toast/CLEAR_ALL_TOASTS");
		store.commit("toast/ADD_TOAST", { content: "test" });
		store.commit("toast/ADD_TOAST", { content: "test" });
		await wrapper.vm.$nextTick();

		expect(store.state.toast.notifications).toHaveLength(2);
		await wrapper.get('[data-cy="toast-close-all"]').trigger("click");

		expect(store.state.toast.notifications).toHaveLength(0);
	});

	describe("undoing a room event", () => {
		const event = (
			id: string | undefined,
			type = RoomRequestType.SkipRequest,
			prevPosition = 10,
		) =>
			({
				action: "event",
				id,
				request: { type },
				user: { name: "someone", isLoggedIn: false },
				additional: { prevPosition },
			}) as unknown as ServerMessageEvent;

		function setup(permissions: string[]) {
			const mounted = mountComponent(Notifier);
			const { store } = mounted;
			store.commit("toast/CLEAR_ALL_TOASTS");
			const grants = new Grants();
			grants.setRoleGrants(Role.UnregisteredUser, parseIntoGrantMask(permissions));
			store.state.room.grants = grants;
			store.state.users.you.id = "me";
			store.commit("users/INIT_USERS", [
				{
					id: "me",
					name: "me",
					isLoggedIn: false,
					status: PlayerStatus.ready,
					role: Role.UnregisteredUser,
				},
			]);
			store.state.room.name = "foo";
			API.post.mockReset();
			return mounted;
		}
		const undoButton = (wrapper: ReturnType<typeof setup>["wrapper"]) =>
			wrapper.findAll("button").find(b => b.text().toLowerCase().includes("undo"));

		it("shows the button to someone who may undo, and asks by id only", async () => {
			const { wrapper, store } = setup(["playback.skip"]);
			API.post.mockResolvedValue({});
			store.commit("toast/ADD_TOAST", { content: "skipped", event: event("event-1") });
			await wrapper.vm.$nextTick();

			await undoButton(wrapper)?.trigger("click");

			expect(API.post).toHaveBeenCalledWith("/room/foo/undo", { eventId: "event-1" });
		});

		it("hides the button from someone who may not", async () => {
			const { wrapper, store } = setup(["chat"]);
			store.commit("toast/ADD_TOAST", { content: "skipped", event: event("event-1") });
			await wrapper.vm.$nextTick();
			expect(undoButton(wrapper)).toBeUndefined();
		});

		it("hides the button when undoing an add would need a permission they lack", async () => {
			const { wrapper, store } = setup(["manage-queue.add"]);
			store.commit("toast/ADD_TOAST", {
				content: "added",
				event: event("event-1", RoomRequestType.AddRequest),
			});
			await wrapper.vm.$nextTick();
			expect(undoButton(wrapper)).toBeUndefined();
		});

		it("hides the button on an event with no id", async () => {
			const { wrapper, store } = setup(["playback.skip"]);
			store.commit("toast/ADD_TOAST", { content: "skipped", event: event(undefined) });
			await wrapper.vm.$nextTick();
			expect(undoButton(wrapper)).toBeUndefined();
		});

		it("undoes seeks shown as one back to before the first of them", async () => {
			const { wrapper, store } = setup(["playback.seek"]);
			API.post.mockResolvedValue({});
			store.commit("toast/ADD_TOAST", {
				content: "seeked",
				event: event("first", RoomRequestType.SeekRequest, 10),
			});
			store.commit("toast/ADD_TOAST", {
				content: "seeked",
				event: event("second", RoomRequestType.SeekRequest, 20),
			});
			await wrapper.vm.$nextTick();
			expect(store.state.toast.notifications).toHaveLength(1);

			await undoButton(wrapper)?.trigger("click");

			expect(API.post).toHaveBeenCalledWith("/room/foo/undo", { eventId: "first" });
		});
	});
});

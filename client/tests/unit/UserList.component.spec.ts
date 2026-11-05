import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { PlayerStatus, Role, type RoomUserInfo } from "ott-common/models/types";
import { Grants } from "ott-common/permissions";
import { RoomRequestType } from "ott-common/models/messages";
import BasicControls from "@/components/controls/BasicControls.vue";
import UserList from "@/components/UserList.vue";
import { flush, mountComponent } from "./component-test-utils";

const person = (id: string, role: Role, isLoggedIn: boolean): RoomUserInfo => ({
	id,
	name: id,
	isLoggedIn,
	status: PlayerStatus.ready,
	role,
});

const guest = person("guest", Role.UnregisteredUser, false);
const guestModerator = person("guest", Role.Moderator, false);
const member = person("member", Role.RegisteredUser, true);
const memberModerator = person("member", Role.Moderator, true);

function mountAs(you: RoomUserInfo, others: RoomUserInfo[], grants = new Grants()) {
	const users = [you, ...others];
	const mounted = mountComponent(UserList, { props: { users } });
	mounted.store.state.room.grants = grants;
	mounted.store.dispatch("users/you", { action: "you", info: { id: you.id } });
	mounted.store.dispatch("users/user", {
		action: "user",
		update: { kind: "init", value: users },
	});
	return mounted;
}

/**
 * Opens someone's wrench menu and gives back what is in it. This goes by the keyboard, because the
 * test browser has no pointer events for the mouse way in.
 */
async function openMenu(wrapper: ReturnType<typeof mountAs>["wrapper"], name: string) {
	const row = wrapper.findAll(".user").find(candidate => candidate.text().includes(name));
	const trigger = row?.find(".user-actions");
	if (!trigger?.exists()) {
		throw new Error(`no wrench for ${name}`);
	}
	await trigger.trigger("keydown", { key: "Enter" });
	const menu = await vi.waitFor(() => {
		const open = document.body.querySelector('[role="menu"]');
		expect(open).not.toBeNull();
		return open as HTMLElement;
	});
	return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

const labels = (items: HTMLElement[]) => items.map(item => item.textContent?.trim());

const promoted = (connection: ReturnType<typeof mountAs>["connection"]) =>
	connection.sent.filter(
		message =>
			message.action === "req" && message.request.type === RoomRequestType.PromoteRequest,
	);

describe("UserList role actions", () => {
	const owner = person("owner", Role.Owner, true);

	it("offers the owner Moderator for a guest, and nothing a guest can't hold", async () => {
		const { wrapper } = mountAs(owner, [guest]);
		const items = await openMenu(wrapper, "guest");
		expect(labels(items)).toEqual(["Promote to Moderator", "Kick"]);
	});

	it("offers the owner the way back once a guest is a moderator", async () => {
		const { wrapper } = mountAs(owner, [guestModerator]);
		const items = await openMenu(wrapper, "guest");
		expect(labels(items)).toEqual(["Demote to Unregistered User", "Kick"]);
	});

	it("sends the role when the owner picks an item", async () => {
		const { wrapper, connection } = mountAs(owner, [guest]);
		const [promote] = await openMenu(wrapper, "guest");
		promote.click();
		await flush();
		expect(promoted(connection)).toEqual([
			{
				action: "req",
				request: {
					type: RoomRequestType.PromoteRequest,
					targetClientId: "guest",
					role: Role.Moderator,
				},
			},
		]);
	});

	it("takes the role away by asking for a plain guest", async () => {
		const { wrapper, connection } = mountAs(owner, [guestModerator]);
		const [demote] = await openMenu(wrapper, "guest");
		demote.click();
		await flush();
		expect(promoted(connection)).toEqual([
			{
				action: "req",
				request: {
					type: RoomRequestType.PromoteRequest,
					targetClientId: "guest",
					role: Role.UnregisteredUser,
				},
			},
		]);
	});

	it("keeps the same list for signed in people", async () => {
		const { wrapper } = mountAs(owner, [member]);
		const items = await openMenu(wrapper, "member");
		expect(labels(items)).toEqual([
			"Promote to Administrator",
			"Promote to Moderator",
			"Promote to Trusted User",
			"Kick",
		]);
	});

	it("keeps the same way back for a signed in moderator", async () => {
		const { wrapper } = mountAs(owner, [memberModerator]);
		const items = await openMenu(wrapper, "member");
		expect(labels(items)).toEqual([
			"Promote to Administrator",
			"Demote to Trusted User",
			"Demote to Registered User",
			"Kick",
		]);
	});

	it("offers a plain viewer nothing at all", async () => {
		const you = person("viewer", Role.UnregisteredUser, false);
		const { wrapper } = mountAs(you, [guest]);
		expect(await openMenu(wrapper, "guest")).toEqual([]);
	});

	it("shows a moderator without the grant no way to promote a guest", async () => {
		const you = person("moderator", Role.Moderator, false);
		const { wrapper } = mountAs(you, [guest]);
		expect(labels(await openMenu(wrapper, "guest"))).toEqual(["Kick"]);
	});

	it("offers it to anyone who holds the grant", async () => {
		const you = person("moderator", Role.Moderator, true);
		const grants = new Grants();
		grants.setRoleGrants(Role.Moderator, [
			"manage-users.promote-moderator",
			"manage-users.demote-moderator",
		]);
		const { wrapper } = mountAs(you, [guest], grants);
		expect(labels(await openMenu(wrapper, "guest"))).toContain("Promote to Moderator");
	});

	it("does not let a demote grant alone stand in for promote", async () => {
		const you = person("moderator", Role.Moderator, true);
		const grants = new Grants();
		grants.setRoleGrants(Role.Moderator, ["manage-users.demote-moderator"]);
		const { wrapper } = mountAs(you, [guest], grants);
		expect(labels(await openMenu(wrapper, "guest"))).not.toContain("Promote to Moderator");
	});
});

describe("a guest's own controls", () => {
	function lockedGrants() {
		const grants = new Grants();
		for (const role of [Role.UnregisteredUser, Role.RegisteredUser, Role.TrustedUser]) {
			grants.setRoleGrants(role, ["chat"]);
		}
		grants.setRoleGrants(Role.Moderator, ["chat", "playback", "manage-queue"]);
		return grants;
	}

	function mountControls() {
		const mounted = mountComponent(BasicControls, { props: { currentPosition: 0 } });
		mounted.store.state.room.grants = lockedGrants();
		mounted.store.dispatch("users/you", { action: "you", info: { id: "guest" } });
		mounted.store.dispatch("users/user", {
			action: "user",
			update: { kind: "init", value: [guest] },
		});
		return mounted;
	}

	const setRole = (store: ReturnType<typeof mountControls>["store"], role: Role) =>
		store.dispatch("users/user", {
			action: "user",
			update: { kind: "update", value: { ...guest, role } },
		});

	const playPause = (wrapper: ReturnType<typeof mountControls>["wrapper"]) =>
		wrapper.get('[aria-label="Play/Pause"]').attributes("disabled");

	it("unlocks when the server says moderator, and locks at once when it stops", async () => {
		const { wrapper, store } = mountControls();
		await nextTick();
		expect(playPause(wrapper)).toBeDefined();

		await setRole(store, Role.Moderator);
		await nextTick();
		expect(playPause(wrapper)).toBeUndefined();

		await setRole(store, Role.UnregisteredUser);
		await nextTick();
		expect(playPause(wrapper)).toBeDefined();
	});
});

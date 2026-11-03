import { describe, expect, it } from "vitest";
import { PlayerStatus, Role, type RoomUserInfo } from "ott-common/models/types";
import DeviceIcon from "@/components/DeviceIcon.vue";
import ServerMessageHandler from "@/components/ServerMessageHandler.vue";
import UserList from "@/components/UserList.vue";
import { mountComponent } from "./component-test-utils";

describe("DeviceIcon", () => {
	it.each([
		["phone", "On a phone"],
		["tablet", "On a tablet"],
		["computer", "On a computer"],
	])("labels a %s", (device, label) => {
		const { wrapper } = mountComponent(DeviceIcon, { props: { device } });
		const icon = wrapper.get('[data-cy="device-icon"]');
		expect(icon.attributes("aria-label")).toBe(label);
		expect(icon.attributes("role")).toBe("img");
		expect(icon.find("svg").exists()).toBe(true);
	});

	it.each([[undefined], ["smart fridge"]])("shows nothing for %s", device => {
		const { wrapper } = mountComponent(DeviceIcon, { props: { device } });
		expect(wrapper.find('[data-cy="device-icon"]').exists()).toBe(false);
	});
});

describe("UserList device icons", () => {
	const user = (id: string, device?: RoomUserInfo["device"]): RoomUserInfo => ({
		id,
		name: id,
		isLoggedIn: false,
		status: PlayerStatus.ready,
		role: Role.UnregisteredUser,
		device,
	});

	it("shows the type next to each name that has one", () => {
		const { wrapper } = mountComponent(UserList, {
			props: { users: [user("pc", "computer"), user("phone", "phone"), user("old-tab")] },
		});
		expect(
			wrapper.findAll('[data-cy="device-icon"]').map(icon => icon.attributes("data-device")),
		).toEqual(["computer", "phone"]);
	});
});

describe("reporting this device", () => {
	it("sends only the coarse type, once the server says this client is in the room", () => {
		const { connection } = mountComponent(ServerMessageHandler);
		expect(connection.sent).toEqual([]);
		connection.mockReceive({ action: "you", info: { id: "me" } });
		// The test browser's user agent names no device it can place, or a computer.
		for (const message of connection.sent) {
			expect(message).toEqual({ action: "device", device: expect.any(String) });
		}
		expect(JSON.stringify(connection.sent)).not.toContain(navigator.userAgent);
	});
});

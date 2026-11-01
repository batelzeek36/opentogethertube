import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import clientmanager from "../../clientmanager.js";
import { Client } from "../../client.js";
import roommanager from "../../roommanager.js";
import usermanager from "../../usermanager.js";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import { buildClients } from "../../redisclient.js";
import { loadModels } from "../../models/index.js";
import { loadConfigFile } from "../../ott-config.js";
import { UnloadReason } from "../../generated.js";
import type { Room } from "../../room.js";
import type { User } from "../../models/user.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";

const OWNER_ID = 101;

class TestClient extends Client {
	get clientType() {
		return "test";
	}

	sendRaw(): void {
		// These tests look at the room, not at what reaches the socket.
	}

	kick(): void {
		this.emit("disconnect", this);
	}

	/** Exactly what a socket does with a parsed message, with no server code in between. */
	sendMessage(msg: unknown) {
		this.emit("message", this, msg as never);
	}

	sendRequest(request: unknown) {
		this.sendMessage({ action: "req", request });
	}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe("room requests sent by clients", () => {
	let room: Room;
	let viewer: TestClient;
	let other: TestClient;
	let sessions: Map<string, SessionInfo>;

	async function connect(token: string, session: SessionInfo): Promise<TestClient> {
		sessions.set(token, session);
		const client = new TestClient("foo");
		client.token = token;
		client.session = session;
		clientmanager.addClient(client);
		client.emit("auth", client, token, session);
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		return client;
	}

	const roleOf = (client: Client) => room.getRole(room.getUser(client.id));
	const anyoneHolding = (userId: number) => room.realusers.filter(u => u.user_id === userId);

	beforeAll(async () => {
		loadConfigFile();
		loadModels();
		await buildClients();
		await clientmanager.setup();
	});

	beforeEach(async () => {
		sessions = new Map();
		vi.spyOn(tokens, "getSessionInfo").mockImplementation(async token => {
			const session = sessions.get(token);
			if (!session) {
				throw new Error("No session info found");
			}
			return session;
		});
		vi.spyOn(usermanager, "getUser").mockImplementation(
			async ({ id }) => ({ id, username: `user${id}` }) as User,
		);
		await roommanager.createRoom({ name: "foo", isTemporary: true });
		room = (await roommanager.getRoom("foo")).unwrap();
		room.owner = { id: OWNER_ID, username: `user${OWNER_ID}` } as User;
		viewer = await connect("viewer-token", { isLoggedIn: false, username: "viewer" });
		other = await connect("other-token", { isLoggedIn: false, username: "other" });
	});

	afterEach(async () => {
		await roommanager.unloadRoom("foo", UnloadReason.Admin);
		vi.restoreAllMocks();
	});

	describe("claiming an identity", () => {
		it.each([
			["as a number", RoomRequestType.UpdateUser],
			["as a string", String(RoomRequestType.UpdateUser)],
			["inside an array", [RoomRequestType.UpdateUser]],
		])("does not make a viewer the owner with UpdateUser, type %s", async (_label, type) => {
			viewer.sendRequest({ type, info: { id: viewer.id, user_id: OWNER_ID } });
			await settle();
			expect(roleOf(viewer)).toEqual(Role.UnregisteredUser);
			expect(room.getUser(viewer.id)?.user_id).toBeUndefined();
			expect(anyoneHolding(OWNER_ID)).toHaveLength(0);
		});

		it("does not let a viewer give another client an account", async () => {
			viewer.sendRequest({
				type: RoomRequestType.UpdateUser,
				info: { id: other.id, user_id: OWNER_ID },
			});
			await settle();
			expect(roleOf(other)).toEqual(Role.UnregisteredUser);
			expect(anyoneHolding(OWNER_ID)).toHaveLength(0);
		});

		it("does not let a viewer rename another client", async () => {
			viewer.sendRequest({
				type: RoomRequestType.UpdateUser,
				info: { id: other.id, username: "someone else" },
			});
			await settle();
			expect(room.getUser(other.id)?.username).toEqual("other");
		});

		it.each([
			["their own client id", () => viewer.id],
			["an id nobody has", () => "phantom"],
			["another client's id", () => other.id],
		])("does not add a user from a JoinRequest using %s", async (_label, id) => {
			const before = room.realusers.length;
			viewer.sendRequest({
				type: RoomRequestType.JoinRequest,
				info: { id: id(), user_id: OWNER_ID },
			});
			await settle();
			expect(room.realusers).toHaveLength(before);
			expect(anyoneHolding(OWNER_ID)).toHaveLength(0);
		});

		it("does not let a viewer leave and rejoin as the owner", async () => {
			viewer.sendRequest({ type: RoomRequestType.LeaveRequest });
			await settle();
			expect(room.getUser(viewer.id)).toBeDefined();
			viewer.sendRequest({
				type: RoomRequestType.JoinRequest,
				info: { id: viewer.id, user_id: OWNER_ID },
			});
			await settle();
			expect(anyoneHolding(OWNER_ID)).toHaveLength(0);
			expect(roleOf(viewer)).toEqual(Role.UnregisteredUser);
		});
	});

	describe("the type of a request", () => {
		it.each([
			["a number", RoomRequestType.PlaybackRequest],
			["a string", String(RoomRequestType.PlaybackRequest)],
			["an array", [RoomRequestType.PlaybackRequest]],
		])("cannot get around a permission by being %s", async (_label, type) => {
			room.grants.setRoleGrants(Role.UnregisteredUser, 0);
			viewer.sendRequest({ type, state: true });
			await settle();
			expect(room.isPlaying).toEqual(false);
		});

		it("does not throw a viewer out for a request that is not an object", async () => {
			const kick = vi.spyOn(viewer, "kick");
			viewer.sendRequest(null);
			viewer.sendRequest("nonsense");
			await settle();
			expect(kick).not.toHaveBeenCalled();
		});
	});

	describe("what must keep working", () => {
		it("lets a client send an ordinary request", async () => {
			viewer.sendRequest({ type: RoomRequestType.PlaybackRequest, state: true });
			await settle();
			expect(room.isPlaying).toEqual(true);
		});

		it("takes a logged in identity from the session", async () => {
			const owner = await connect("owner-token", {
				isLoggedIn: true,
				user_id: OWNER_ID,
			});
			expect(roleOf(owner)).toEqual(Role.Owner);
			expect(roleOf(viewer)).toEqual(Role.UnregisteredUser);
		});

		it("reaches an open room when someone logs in, then out, on the same token", async () => {
			sessions.set("viewer-token", { isLoggedIn: true, user_id: OWNER_ID });
			await clientmanager.onUserModified("viewer-token");
			await settle();
			expect(roleOf(viewer)).toEqual(Role.Owner);
			expect(room.getUser(viewer.id)?.username).toEqual(`user${OWNER_ID}`);

			sessions.set("viewer-token", { isLoggedIn: false, username: "viewer again" });
			await clientmanager.onUserModified("viewer-token");
			await settle();
			expect(roleOf(viewer)).toEqual(Role.UnregisteredUser);
			expect(room.getUser(viewer.id)?.username).toEqual("viewer again");
			expect(roleOf(other)).toEqual(Role.UnregisteredUser);
		});

		it("re-reads the session when a client says its name changed", async () => {
			sessions.set("viewer-token", { isLoggedIn: false, username: "new name" });
			viewer.sendMessage({ action: "notify", message: "usernameChanged" });
			await settle();
			expect(room.getUser(viewer.id)?.username).toEqual("new name");
			expect(room.getUser(other.id)?.username).toEqual("other");
		});

		it("still takes player status and device from their own messages", async () => {
			viewer.sendMessage({ action: "status", status: "ready" });
			viewer.sendMessage({ action: "device", device: "phone" });
			await settle();
			expect(room.getUser(viewer.id)).toMatchObject({
				playerStatus: "ready",
				device: "phone",
			});
		});
	});
});

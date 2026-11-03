import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import clientmanager from "../../clientmanager.js";
import { DirectClient } from "../../client.js";
import roommanager from "../../roommanager.js";
import usermanager from "../../usermanager.js";
import tokens from "../../auth/tokens.js";
import { buildClients } from "../../redisclient.js";
import { loadModels } from "../../models/index.js";
import { loadConfigFile } from "../../ott-config.js";
import { UnloadReason } from "../../generated.js";
import type { Room } from "../../room.js";
import type { User } from "../../models/user.js";
import { PlayerStatus, Role } from "ott-common/models/types.js";

const OWNER_ID = 101;

class FakeSocket extends EventEmitter {
	bufferedAmount = 0;
	close = vi.fn();
	send = vi.fn();
	ping = vi.fn();
	pong = vi.fn();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe("one socket, one identity", () => {
	let room: Room;
	let socket: FakeSocket;
	let client: DirectClient;
	const say = (msg: unknown) => socket.emit("message", JSON.stringify(msg));
	const sent = () => socket.send.mock.calls.map(([text]) => JSON.parse(text as string));

	beforeAll(async () => {
		loadConfigFile();
		loadModels();
		await buildClients();
		await clientmanager.setup();
	});

	beforeEach(async () => {
		vi.spyOn(usermanager, "getUser").mockImplementation(
			async ({ id }) => ({ id, username: `user${id}` }) as User,
		);
		await roommanager.createRoom({ name: "foo", isTemporary: true });
		room = (await roommanager.getRoom("foo")).unwrap();
		room.owner = { id: OWNER_ID, username: `user${OWNER_ID}` } as User;
		await tokens.setSessionInfo("viewer", { isLoggedIn: false, username: "viewer" });
		await tokens.setSessionInfo("owner", { isLoggedIn: true, user_id: OWNER_ID });
		socket = new FakeSocket();
		client = new DirectClient("foo", socket as unknown as WebSocket);
		clientmanager.addClient(client);
	});

	afterEach(async () => {
		socket.emit("close");
		await settle();
		await roommanager.unloadRoom("foo", UnloadReason.Admin);
		vi.restoreAllMocks();
	});

	async function authOnce() {
		say({ action: "auth", token: "viewer" });
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
	}

	it("does not join the room again with the same token", async () => {
		await authOnce();
		say({ action: "auth", token: "viewer" });
		await settle();
		expect(room.realusers.filter(user => user.id === client.id)).toHaveLength(1);
		expect(clientmanager.getClientsInRoom("foo").filter(c => c === client)).toHaveLength(1);
	});

	it("does not send everything to the socket twice afterwards", async () => {
		await authOnce();
		say({ action: "auth", token: "viewer" });
		await settle();
		socket.send.mockClear();
		await room.publish({ action: "reaction", from: room.getUserInfo(client.id), emoji: "🔥" });
		await settle();
		expect(sent().filter(msg => msg.action === "reaction")).toHaveLength(1);
	});

	it("does not sync and introduce a client again", async () => {
		await authOnce();
		socket.send.mockClear();
		say({ action: "auth", token: "viewer" });
		await settle();
		expect(sent().filter(msg => msg.action === "you")).toHaveLength(0);
	});

	it("does not change who the socket is", async () => {
		await authOnce();
		say({ action: "auth", token: "owner" });
		await settle();
		expect(client.token).toEqual("viewer");
		expect(client.session).toEqual({ isLoggedIn: false, username: "viewer" });
		expect(room.getRole(room.getUser(client.id))).toEqual(Role.UnregisteredUser);
		expect(room.realusers.filter(user => user.user_id === OWNER_ID)).toHaveLength(0);
	});

	it("does not throw the client out over a bad second token", async () => {
		await authOnce();
		say({ action: "auth", token: "no-such-token" });
		await settle();
		expect(socket.close).not.toHaveBeenCalled();
		expect(client.token).toEqual("viewer");
	});

	it("takes only the first of two sent together", async () => {
		say({ action: "auth", token: "viewer" });
		say({ action: "auth", token: "owner" });
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		await settle();
		expect(client.token).toEqual("viewer");
		expect(room.realusers.filter(user => user.id === client.id)).toHaveLength(1);
		expect(room.getRole(room.getUser(client.id))).toEqual(Role.UnregisteredUser);
	});

	it("leaves a client that auths once working normally", async () => {
		await authOnce();
		say({ action: "status", status: PlayerStatus.ready });
		await vi.waitFor(() =>
			expect(room.getUser(client.id)?.playerStatus).toEqual(PlayerStatus.ready),
		);
	});

	it("still lets the same person in on a new socket", async () => {
		await authOnce();
		const another = new FakeSocket();
		const reconnected = new DirectClient("foo", another as unknown as WebSocket);
		clientmanager.addClient(reconnected);
		another.emit("message", JSON.stringify({ action: "auth", token: "viewer" }));
		await vi.waitFor(() => expect(room.getUser(reconnected.id)).toBeDefined());
		another.emit("close");
		await settle();
	});

	it("still throws out a bad first token", async () => {
		say({ action: "auth", token: "no-such-token" });
		await settle();
		expect(socket.close).toHaveBeenCalled();
	});
});

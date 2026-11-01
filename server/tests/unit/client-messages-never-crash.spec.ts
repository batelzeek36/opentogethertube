/* eslint-disable vitest/expect-expect -- every test here asserts through expectNoCrash */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import clientmanager from "../../clientmanager.js";
import { BalancerClient, DirectClient } from "../../client.js";
import roommanager from "../../roommanager.js";
import storage from "../../storage.js";
import InfoExtract from "../../infoextractor.js";
import { redisClient } from "../../redisclient.js";
import type { QueueItem } from "ott-common/models/video.js";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import { buildClients } from "../../redisclient.js";
import { loadModels, Room as RoomModel } from "../../models/index.js";
import { loadConfigFile } from "../../ott-config.js";
import { UnloadReason } from "../../generated.js";
import type { Room } from "../../room.js";
import type { BalancerConnection } from "../../balancer.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { OttWebsocketError } from "ott-common/models/types.js";
import { ok } from "ott-common/result.js";

class FakeSocket extends EventEmitter {
	bufferedAmount = 0;
	close = vi.fn();
	send = vi.fn();
	ping = vi.fn();
	pong = vi.fn();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** Every way a parsed message can be shaped wrong, in the fields handlers tend to reach into. */
const JUNK: unknown[] = [
	undefined,
	null,
	0,
	-1,
	"",
	"junk",
	true,
	[],
	[null],
	{},
	{ id: null },
	{ toString: null },
	{ service: {}, id: {} },
];

const FIELDS = [
	"value",
	"state",
	"video",
	"videos",
	"url",
	"text",
	"event",
	"eventId",
	"settings",
	"speed",
	"clientId",
	"targetClientId",
	"role",
	"fromIdx",
	"toIdx",
	"add",
	"update",
	"emoji",
	"messageId",
	"channel",
	"talking",
];

function junkRequests(): unknown[] {
	const requests: unknown[] = [];
	for (const type of Object.values(RoomRequestType).filter(t => typeof t === "number")) {
		requests.push({ type });
		for (const field of FIELDS) {
			for (const value of JUNK) {
				requests.push({ type, [field]: value });
			}
		}
	}
	return requests;
}

describe("nothing a client sends can take the process down", () => {
	const unhandled = vi.fn();
	const uncaught = vi.fn();
	let room: Room;
	let roomName: string;

	function connectUnauthenticated() {
		const socket = new FakeSocket();
		const client = new DirectClient(roomName, socket as unknown as WebSocket);
		clientmanager.addClient(client);
		const say = (msg: unknown) => socket.emit("message", JSON.stringify(msg));
		return { socket, client, say };
	}

	async function connect(token: string, session: SessionInfo) {
		await tokens.setSessionInfo(token, session);
		const connection = connectUnauthenticated();
		connection.say({ action: "auth", token });
		await vi.waitFor(() => expect(room.getUser(connection.client.id)).toBeDefined());
		return connection;
	}

	beforeAll(async () => {
		loadConfigFile();
		loadModels();
		await buildClients();
		await clientmanager.setup();
		process.on("unhandledRejection", unhandled);
		process.on("uncaughtException", uncaught);
	});

	afterAll(() => {
		process.off("unhandledRejection", unhandled);
		process.off("uncaughtException", uncaught);
	});

	beforeEach(async () => {
		unhandled.mockClear();
		uncaught.mockClear();
		await openRoom("foo", true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await roommanager.unloadRoom(roomName, UnloadReason.Admin);
		await RoomModel.destroy({ where: { name: roomName } });
		await redisClient.del(`room:${roomName}`);
	});

	async function openRoom(name: string, isTemporary: boolean) {
		roomName = name;
		await roommanager.createRoom({ name, isTemporary });
		room = (await roommanager.getRoom(name)).unwrap();
	}

	/** Spec files share a database, so a room that gets saved needs a name nobody else uses. */
	async function openRoomThatSaves() {
		await roommanager.unloadRoom(roomName, UnloadReason.Admin);
		await openRoom("never-crash-saved", false);
	}

	const expectNoCrash = async () => {
		await settle();
		expect(unhandled).not.toHaveBeenCalled();
		expect(uncaught).not.toHaveBeenCalled();
	};

	describe("the notify message", () => {
		it("sent before auth is refused, not looked up", async () => {
			const { socket, say } = connectUnauthenticated();
			const lookups = vi.spyOn(tokens, "getSessionInfo");
			say({ action: "notify", message: "usernameChanged" });
			await expectNoCrash();
			expect(lookups).not.toHaveBeenCalled();
			expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.MISSING_TOKEN);
		});

		it("sent before auth does not touch anyone else waiting to auth", async () => {
			const waiting = connectUnauthenticated();
			const { say } = connectUnauthenticated();
			say({ action: "notify", message: "usernameChanged" });
			await expectNoCrash();
			expect(waiting.socket.close).not.toHaveBeenCalled();
		});

		it("survives the session having gone away", async () => {
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			vi.spyOn(tokens, "getSessionInfo").mockRejectedValue(
				new Error("No session info found"),
			);
			say({ action: "notify", message: "usernameChanged" });
			await expectNoCrash();
		});

		it("still refreshes the name of a client that has authed", async () => {
			const { client, say } = await connect("t", { isLoggedIn: false, username: "before" });
			await tokens.setSessionInfo("t", { isLoggedIn: false, username: "after" });
			say({ action: "notify", message: "usernameChanged" });
			await vi.waitFor(() => expect(room.getUser(client.id)?.username).toEqual("after"));
			await expectNoCrash();
		});
	});

	describe("a user being modified", () => {
		it("does not stop at one client that fails", async () => {
			const first = await connect("t", { isLoggedIn: false, username: "before" });
			const second = await connect("t", { isLoggedIn: false, username: "before" });
			await tokens.setSessionInfo("t", { isLoggedIn: false, username: "after" });
			const real = room.processUnauthorizedRequest.bind(room);
			vi.spyOn(room, "processUnauthorizedRequest").mockImplementation(
				async (request, authorization) => {
					if (authorization.clientId === first.client.id) {
						throw new Error("this one fails");
					}
					await real(request, authorization);
				},
			);
			await clientmanager.onUserModified("t");
			await vi.waitFor(() =>
				expect(room.getUser(second.client.id)?.username).toEqual("after"),
			);
			await expectNoCrash();
		});
	});

	describe("the socket itself", () => {
		it.each(["null", "5", '"text"', "[]", "true", "{}", '{"action":null}', "not json"])(
			"ignores %s",
			async text => {
				const { socket } = connectUnauthenticated();
				expect(() => socket.emit("message", text)).not.toThrow();
				await expectNoCrash();
			},
		);

		it.each(JUNK.filter(token => token !== undefined))("auth with token %j", async token => {
			const { socket, say } = connectUnauthenticated();
			expect(() => say({ action: "auth", token })).not.toThrow();
			await expectNoCrash();
			expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.MISSING_TOKEN);
		});

		it("a room that fails to load while joining", async () => {
			await tokens.setSessionInfo("t", { isLoggedIn: false, username: "a" });
			vi.spyOn(roommanager, "getRoom").mockRejectedValue(new Error("storage is down"));
			const { socket, say } = connectUnauthenticated();
			say({ action: "auth", token: "t" });
			await expectNoCrash();
			expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.UNKNOWN);
		});

		it("a room that fails to load while leaving", async () => {
			const { socket } = await connect("t", { isLoggedIn: false, username: "a" });
			vi.spyOn(roommanager, "getRoom").mockRejectedValue(new Error("storage is down"));
			socket.emit("close");
			await expectNoCrash();
		});

		it("an audio frame the room fails on", async () => {
			const { socket } = await connect("t", { isLoggedIn: false, username: "a" });
			vi.spyOn(room.voice, "acceptFrame").mockImplementation(() => {
				throw new Error("frame failed");
			});
			expect(() => socket.emit("message", Buffer.from([1, 2, 3]))).not.toThrow();
			await expectNoCrash();
		});
	});

	describe("the work a message leaves behind", () => {
		it("a room that fails to save a change", async () => {
			await openRoomThatSaves();
			vi.spyOn(storage, "updateRoom").mockRejectedValue(new Error("storage is down"));
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			say({ action: "req", request: { type: RoomRequestType.PlaybackRequest, state: true } });
			// Long enough for the sync of that change, which nothing waits for.
			await new Promise(resolve => setTimeout(resolve, 100));
			await expectNoCrash();
		});

		it("a room that fails to save its state to redis", async () => {
			vi.spyOn(redisClient, "set").mockRejectedValue(new Error("redis is down"));
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			say({ action: "req", request: { type: RoomRequestType.PlaybackRequest, state: true } });
			await new Promise(resolve => setTimeout(resolve, 100));
			await room.saveStateToRedisDebounced.flush();
			await expectNoCrash();
		});

		it("a queue that fails while skipping", async () => {
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			room.currentSource = { service: "direct", id: "movie" } as QueueItem;
			await room.queue.enqueue({ service: "direct", id: "next" } as QueueItem);
			vi.spyOn(room.queue, "dequeue").mockRejectedValue(new Error("queue failed"));
			say({ action: "req", request: { type: RoomRequestType.SkipRequest } });
			await expectNoCrash();
		});

		it("a queue that fails while adding", async () => {
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			const video = { service: "direct", id: "new" } as QueueItem;
			vi.spyOn(InfoExtract, "getVideoInfo").mockResolvedValue(video);
			vi.spyOn(room.queue, "enqueue").mockRejectedValue(new Error("queue failed"));
			say({ action: "req", request: { type: RoomRequestType.AddRequest, video } });
			say({
				action: "req",
				request: { type: RoomRequestType.AddRequest, videos: [video] },
			});
			await expectNoCrash();
		});

		it("every request type with junk in every field, in a room that saves", async () => {
			await openRoomThatSaves();
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			for (const request of junkRequests()) {
				say({ action: "req", request });
			}
			await new Promise(resolve => setTimeout(resolve, 200));
			await room.sync().catch(() => undefined);
			await expectNoCrash();
		});
	});

	describe("the balancer's clients", () => {
		function connectThroughBalancer() {
			const conn = {
				id: "balancer",
				send: vi.fn(() => ok(undefined)),
			} as unknown as BalancerConnection;
			const client = new BalancerClient(roomName, "balancer-client", conn);
			clientmanager.addClient(client);
			return client;
		}

		it.each([[null], [5], ["text"], [[]], [{}], [{ action: null }]])(
			"ignores %j",
			async message => {
				const client = connectThroughBalancer();
				expect(() => client.receiveMessage(message as never)).not.toThrow();
				await expectNoCrash();
			},
		);

		it("notify before auth", async () => {
			const client = connectThroughBalancer();
			client.receiveMessage({ action: "notify", message: "usernameChanged" });
			await expectNoCrash();
		});
	});

	describe("every message shape", () => {
		it.each(["status", "device", "notify", "kickme", "nonsense"])(
			"action %s with junk in every field, before auth",
			async action => {
				for (const value of JUNK) {
					const { say } = connectUnauthenticated();
					say({ action, status: value, device: value, message: value, reason: value });
				}
				await expectNoCrash();
			},
		);

		it("every request type with junk in every field, before auth", async () => {
			const { say } = connectUnauthenticated();
			for (const request of junkRequests()) {
				say({ action: "req", request });
			}
			await expectNoCrash();
		});

		it("every request type with junk in every field, once in the room", async () => {
			const { say } = await connect("t", { isLoggedIn: false, username: "a" });
			for (const request of junkRequests()) {
				say({ action: "req", request });
			}
			await expectNoCrash();
			// The room still works for the next person.
			const next = await connect("t2", { isLoggedIn: false, username: "b" });
			expect(room.getUser(next.client.id)).toBeDefined();
		});
	});
});

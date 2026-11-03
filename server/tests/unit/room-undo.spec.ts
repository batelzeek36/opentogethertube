import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import clientmanager from "../../clientmanager.js";
import { Client } from "../../client.js";
import roommanager from "../../roommanager.js";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import InfoExtract from "../../infoextractor.js";
import { buildClients } from "../../redisclient.js";
import { loadModels } from "../../models/index.js";
import { loadConfigFile } from "../../ott-config.js";
import { UnloadReason } from "../../generated.js";
import type { Room } from "../../room.js";
import { MAX_UNDOABLE_EVENTS, UNDO_WINDOW_MS } from "../../room-undo.js";
import {
	type RoomRequest,
	RoomRequestType,
	type ServerMessageEvent,
} from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";
import type { Video } from "ott-common/models/video.js";
import permissions from "ott-common/permissions.js";

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

	sendRequest(request: unknown) {
		this.emit("message", this, { action: "req", request } as never);
	}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

const video = (id: string): Video => ({ service: "direct", id, title: id }) as Video;
const MOVIE = video("movie");
const OTHER = video("other");
const INJECTED = video("https://example.com/injected.mp4");

describe("undoing a room event", () => {
	let room: Room;
	let viewer: TestClient;
	let published: ServerMessageEvent[];

	const allow = (...names: string[]) =>
		room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(names));
	const allowEverythingExcept = (...names: string[]) => {
		const all = permissions.PERMISSIONS.map(p => p.name).filter(n => !names.includes(n));
		room.grants.setRoleGrants(Role.UnregisteredUser, permissions.parseIntoGrantMask(all));
	};

	const lastEvent = () => published[published.length - 1];
	const undo = async (eventId: unknown = lastEvent().id) => {
		viewer.sendRequest({ type: RoomRequestType.UndoRequest, eventId });
		await settle();
	};
	const act = async (request: unknown) => {
		// These two have REST routes and can't come over a socket, so go the way those routes do.
		const { type } = request as RoomRequest;
		if (type === RoomRequestType.AddRequest || type === RoomRequestType.RemoveRequest) {
			await clientmanager.makeRoomRequest(viewer, request as RoomRequest);
		} else {
			viewer.sendRequest(request);
		}
		await settle();
	};
	const queueIds = () => room.queue.items.map(item => item.id);
	const snapshot = () => ({
		current: room.currentSource?.id,
		position: room.playbackPosition,
		queue: queueIds(),
	});

	async function connectViewer(): Promise<TestClient> {
		const client = new TestClient("foo");
		client.token = "viewer-token";
		const session: SessionInfo = { isLoggedIn: false, username: "viewer" };
		client.session = session;
		await tokens.setSessionInfo(client.token, session);
		clientmanager.addClient(client);
		client.emit("auth", client, client.token, session);
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		return client;
	}

	beforeAll(async () => {
		loadConfigFile();
		loadModels();
		await buildClients();
		await clientmanager.setup();
	});

	beforeEach(async () => {
		await roommanager.createRoom({ name: "foo", isTemporary: true });
		room = (await roommanager.getRoom("foo")).unwrap();

		published = [];
		const publish = room.publish.bind(room);
		vi.spyOn(room, "publish").mockImplementation(async msg => {
			if (msg.action === "event") {
				published.push(msg);
			}
			await publish(msg);
		});
		vi.spyOn(InfoExtract, "getVideoInfo").mockImplementation(async (service, id) => video(id));
		vi.spyOn(InfoExtract, "getManyVideoInfo").mockImplementation(async videos => ({
			videos: videos.map(v => video(v.id)),
			complete: true,
		}));

		viewer = await connectViewer();
		allow("*");
		room.currentSource = MOVIE;
		room.playbackPosition = 100;
		published = [];
	});

	afterEach(async () => {
		await roommanager.unloadRoom("foo", UnloadReason.Admin);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe("an event the client made up", () => {
		const FORGED: [string, unknown][] = [
			[
				"a skip naming a video to play",
				{
					request: { type: RoomRequestType.SkipRequest },
					additional: { video: INJECTED, prevPosition: 1234 },
				},
			],
			[
				"a remove naming a video to put in the queue",
				{
					request: { type: RoomRequestType.RemoveRequest },
					additional: { video: INJECTED, queueIdx: 0 },
				},
			],
			[
				"a remove with an index past the end of the queue",
				{
					request: { type: RoomRequestType.RemoveRequest },
					additional: { video: INJECTED, queueIdx: 99 },
				},
			],
			[
				"an add, which stopped whatever was playing",
				{ request: { type: RoomRequestType.AddRequest }, additional: {} },
			],
			[
				"a seek to anywhere",
				{
					request: { type: RoomRequestType.SeekRequest },
					additional: { prevPosition: 1234 },
				},
			],
		];

		it.each(FORGED)("changes nothing for a chat-only viewer: %s", async (_label, event) => {
			allow("chat");
			const before = snapshot();
			await act({ type: RoomRequestType.UndoRequest, event });
			expect(snapshot()).toEqual(before);
		});

		it.each(FORGED)("changes nothing for anyone at all: %s", async (_label, event) => {
			const before = snapshot();
			await act({ type: RoomRequestType.UndoRequest, event });
			expect(snapshot()).toEqual(before);
		});

		it.each([
			["nothing", undefined],
			["a guess", "not-an-event"],
			["an object", {}],
			["a key", "__proto__"],
		])("changes nothing when the id is %s", async (_label, eventId) => {
			await act({ type: RoomRequestType.UndoRequest, eventId });
			expect(room.currentSource).toEqual(MOVIE);
			expect(room.playbackPosition).toEqual(100);
		});

		it("takes nothing from a client's copy of a real event", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			await act({
				type: RoomRequestType.UndoRequest,
				eventId: lastEvent().id,
				event: { additional: { prevPosition: 1234 } },
				additional: { prevPosition: 1234 },
			});
			expect(room.playbackPosition).toEqual(100);
		});
	});

	describe("who may undo a real event", () => {
		const CASES: [string, unknown, string[]][] = [
			["a seek", { type: RoomRequestType.SeekRequest, value: 500 }, ["playback.seek"]],
			["a skip", { type: RoomRequestType.SkipRequest }, ["playback.skip"]],
			[
				"an add",
				{ type: RoomRequestType.AddRequest, video: { service: "direct", id: "new" } },
				["manage-queue.add", "manage-queue.remove"],
			],
			[
				"a remove",
				{ type: RoomRequestType.RemoveRequest, video: { service: "direct", id: "other" } },
				["manage-queue.remove"],
			],
		];

		beforeEach(async () => {
			await room.queue.enqueue(OTHER);
		});

		it.each(CASES)("not a chat-only viewer: %s", async (_label, request) => {
			await act(request);
			allow("chat");
			const before = snapshot();
			await undo();
			expect(snapshot()).toEqual(before);
		});

		it.each(
			CASES.flatMap(([label, request, needed]) =>
				needed.map(name => [label, name, request] as const),
			),
		)("not without the permission it takes: %s needs %s", async (_label, name, request) => {
			await act(request);
			allowEverythingExcept(name);
			const before = snapshot();
			await undo();
			expect(snapshot()).toEqual(before);
		});

		it.each(CASES)(
			"someone with exactly what it takes: %s",
			async (_label, request, needed) => {
				await act(request);
				const before = snapshot();
				allow(...needed);
				await undo();
				expect(snapshot()).not.toEqual(before);
			},
		);

		it("a refused person does not use the undo up for someone else", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			const { id } = lastEvent();
			allow("chat");
			await undo(id);
			expect(room.playbackPosition).toEqual(500);
			allow("playback.seek");
			await undo(id);
			expect(room.playbackPosition).toEqual(100);
		});
	});

	describe("what a permitted undo does", () => {
		it("seeks back", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			await undo();
			expect(room.playbackPosition).toEqual(100);
		});

		it("seeks back to the very start", async () => {
			room.playbackPosition = 0;
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			await undo();
			expect(room.playbackPosition).toEqual(0);
		});

		it("brings back a skipped video and queues what replaced it", async () => {
			await room.queue.enqueue(OTHER);
			await act({ type: RoomRequestType.SkipRequest });
			expect(room.currentSource?.id).toEqual("other");
			await undo();
			expect(room.currentSource?.id).toEqual("movie");
			expect(room.playbackPosition).toEqual(100);
			expect(queueIds()).toEqual(["other"]);
		});

		it("brings back a video skipped at the very start", async () => {
			room.playbackPosition = 0;
			await room.queue.enqueue(OTHER);
			await act({ type: RoomRequestType.SkipRequest });
			await undo();
			expect(room.currentSource?.id).toEqual("movie");
			expect(room.playbackPosition).toEqual(0);
			expect(queueIds()).toEqual(["other"]);
		});

		it("takes an added video back out of the queue", async () => {
			await room.queue.enqueue(OTHER);
			await act({
				type: RoomRequestType.AddRequest,
				video: { service: "direct", id: "new" },
			});
			expect(queueIds()).toEqual(["other", "new"]);
			await undo();
			expect(queueIds()).toEqual(["other"]);
			expect(room.currentSource).toEqual(MOVIE);
		});

		it("stops an added video that started playing", async () => {
			room.currentSource = null;
			await act({
				type: RoomRequestType.AddRequest,
				video: { service: "direct", id: "new" },
			});
			const { id } = lastEvent();
			await room.queue.dequeue();
			room.currentSource = video("new");
			await undo(id);
			expect(room.currentSource).toBeNull();
		});

		it("leaves the movie alone when the added video has already gone", async () => {
			await act({
				type: RoomRequestType.AddRequest,
				video: { service: "direct", id: "new" },
			});
			const { id } = lastEvent();
			await room.queue.evict({ service: "direct", id: "new" });
			await undo(id);
			expect(room.currentSource).toEqual(MOVIE);
		});

		it("takes back a batch without touching the movie", async () => {
			await act({
				type: RoomRequestType.AddRequest,
				videos: [
					{ service: "direct", id: "a" },
					{ service: "direct", id: "b" },
				],
			});
			const addition = published.findLast(
				e => e.request.type === RoomRequestType.AddRequest,
			)!;
			expect(queueIds()).toEqual(["a", "b"]);
			await undo(addition.id);
			expect(queueIds()).toEqual([]);
			expect(room.currentSource).toEqual(MOVIE);
		});

		it("puts a removed video back where it was", async () => {
			await room.queue.enqueue(video("a"), OTHER, video("b"));
			await act({ type: RoomRequestType.RemoveRequest, video: OTHER });
			expect(queueIds()).toEqual(["a", "b"]);
			await undo();
			expect(queueIds()).toEqual(["a", "other", "b"]);
		});

		it("puts a removed video at the end when the queue has since shrunk", async () => {
			await room.queue.enqueue(video("a"), video("b"), OTHER);
			await act({ type: RoomRequestType.RemoveRequest, video: OTHER });
			const { id } = lastEvent();
			await room.queue.evict(video("a"));
			await room.queue.evict(video("b"));
			await undo(id);
			expect(queueIds()).toEqual(["other"]);
		});

		it("does not queue a removed video twice", async () => {
			await room.queue.enqueue(OTHER);
			await act({ type: RoomRequestType.RemoveRequest, video: OTHER });
			const { id } = lastEvent();
			await room.queue.enqueue(OTHER);
			await undo(id);
			expect(queueIds()).toEqual(["other"]);
		});
	});

	describe("how long an event can be undone", () => {
		it("only once", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			const { id } = lastEvent();
			await undo(id);
			await act({ type: RoomRequestType.SeekRequest, value: 700 });
			await undo(id);
			expect(room.playbackPosition).toEqual(700);
		});

		it("not after the window", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			const { id } = lastEvent();
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + UNDO_WINDOW_MS + 1);
			await undo(id);
			expect(room.playbackPosition).toEqual(500);
		});

		it("not once enough newer events have come along", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			const { id } = lastEvent();
			for (let i = 0; i < MAX_UNDOABLE_EVENTS; i++) {
				viewer.sendRequest({ type: RoomRequestType.SeekRequest, value: 600 });
			}
			await settle();
			await undo(id);
			expect(room.playbackPosition).toEqual(600);
		});

		it("gives an id only to events that can be undone", async () => {
			await act({ type: RoomRequestType.SeekRequest, value: 500 });
			expect(lastEvent().id).toEqual(expect.any(String));
			await act({ type: RoomRequestType.PlaybackRequest, state: true });
			expect(lastEvent().id).toBeUndefined();
		});
	});
});

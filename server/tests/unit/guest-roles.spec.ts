import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";
import { PermissionDeniedException } from "ott-common/exceptions.js";
import clientmanager from "../../clientmanager.js";
import { Client, ClientJoinStatus } from "../../client.js";
import { GuestRoles } from "../../guest-roles.js";
import { ImpossiblePromotionException } from "../../exceptions.js";
import roommanager, { redisStateToState } from "../../roommanager.js";
import usermanager from "../../usermanager.js";
import storage from "../../storage.js";
import tokens, { type SessionInfo } from "../../auth/tokens.js";
import { buildClients } from "../../redisclient.js";
import { loadModels } from "../../models/index.js";
import { loadConfigFile } from "../../ott-config.js";
import { UnloadReason } from "../../generated.js";
import { Room } from "../../room.js";
import { roomToDbPartial } from "../../storage/room.js";
import type { User } from "../../models/user.js";

const OWNER_ID = 101;
const MEMBER_ID = 102;
const GUEST_TOKEN = "guest-browser-token";

/** A socket with nothing in between, that keeps every byte the server sends down it. */
class WireClient extends Client {
	received: string[] = [];

	get clientType() {
		return "test";
	}

	sendRaw(text: string): void {
		this.received.push(text);
	}

	kick(): void {
		this.emit("disconnect", this);
	}

	sendMessage(msg: unknown) {
		this.emit("message", this, msg as never);
	}

	sendRequest(request: unknown) {
		this.sendMessage({ action: "req", request });
	}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

describe("GuestRoles", () => {
	it("starts everyone as a plain guest", () => {
		expect(new GuestRoles().roleOf("token")).toEqual(Role.UnregisteredUser);
	});

	it("gives and takes moderator by token, for that token alone", () => {
		const roles = new GuestRoles();
		roles.assign("token", Role.Moderator);
		expect(roles.roleOf("token")).toEqual(Role.Moderator);
		expect(roles.roleOf("other")).toEqual(Role.UnregisteredUser);
		roles.assign("token", Role.UnregisteredUser);
		expect(roles.roleOf("token")).toEqual(Role.UnregisteredUser);
	});

	it("treats going back to registered as taking moderator away", () => {
		const roles = new GuestRoles();
		roles.assign("token", Role.Moderator);
		roles.assign("token", Role.RegisteredUser);
		expect(roles.roleOf("token")).toEqual(Role.UnregisteredUser);
	});

	it.each([Role.Administrator, Role.TrustedUser, Role.Owner])(
		"refuses role %s, which a guest can't hold",
		role => {
			const roles = new GuestRoles();
			roles.assign("token", Role.Moderator);
			expect(() => roles.assign("token", role)).toThrow(ImpossiblePromotionException);
			expect(roles.roleOf("token")).toEqual(Role.Moderator);
		},
	);

	it.each([Role.UnregisteredUser, Role.RegisteredUser])(
		"refuses to take moderator from a guest who doesn't have it, as role %s",
		role => {
			expect(() => new GuestRoles().assign("token", role)).toThrow(
				ImpossiblePromotionException,
			);
		},
	);

	it("never keeps the token itself", () => {
		const roles = new GuestRoles();
		roles.assign(GUEST_TOKEN, Role.Moderator);
		expect(JSON.stringify(roles)).not.toContain(GUEST_TOKEN);
	});

	it("comes back the same from what it saved", () => {
		const roles = new GuestRoles();
		roles.assign("token", Role.Moderator);
		const loaded = new GuestRoles(JSON.parse(JSON.stringify(roles)));
		expect(loaded.roleOf("token")).toEqual(Role.Moderator);
		expect(loaded.roleOf("other")).toEqual(Role.UnregisteredUser);
	});

	it.each([[undefined], [null], ["abc"], [{ a: 1 }], [[1, 2]]])(
		"gives nobody a role from saved state of %j",
		saved => {
			expect(new GuestRoles(saved).toJSON()).toEqual([]);
		},
	);
});

describe("guest moderators", () => {
	let room: Room;
	let owner: WireClient;
	let guest: WireClient;
	let other: WireClient;
	let sessions: Map<string, SessionInfo>;

	async function connect(token: string, session: SessionInfo): Promise<WireClient> {
		sessions.set(token, session);
		const client = new WireClient("foo");
		client.token = token;
		client.session = session;
		client.joinStatus = ClientJoinStatus.Joined;
		clientmanager.addClient(client);
		client.emit("auth", client, token, session);
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		return client;
	}

	const connectGuest = () => connect(GUEST_TOKEN, { isLoggedIn: false, username: "guest" });

	async function disconnect(client: WireClient) {
		client.kick();
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeUndefined());
	}

	const roleOf = (client: Client) => room.getRole(room.getUser(client.id));

	const promote = (by: WireClient, target: WireClient, role: Role) =>
		by.sendRequest({
			type: RoomRequestType.PromoteRequest,
			targetClientId: target.id,
			role,
		});

	async function makeModerator(target: WireClient = guest) {
		promote(owner, target, Role.Moderator);
		await vi.waitFor(() => expect(roleOf(target)).toEqual(Role.Moderator));
	}

	async function removeModerator(target: WireClient = guest) {
		promote(owner, target, Role.UnregisteredUser);
		await vi.waitFor(() => expect(roleOf(target)).toEqual(Role.UnregisteredUser));
	}

	/** Every role a client was told someone has, in the order it heard them. */
	function rolesHeard(listener: WireClient, about: WireClient): Role[] {
		return listener.received
			.map(text => JSON.parse(text))
			.filter(msg => msg.action === "user" && msg.update.kind === "update")
			.filter(msg => msg.update.value.id === about.id)
			.map(msg => msg.update.value.role);
	}

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
		// How a movie night is set up: everyone below moderator can only chat.
		for (const role of [Role.UnregisteredUser, Role.RegisteredUser, Role.TrustedUser]) {
			room.grants.setRoleGrants(role, ["chat"]);
		}
		room.grants.setRoleGrants(Role.Moderator, ["chat", "playback", "manage-queue"]);
		owner = await connect("owner-token", { isLoggedIn: true, user_id: OWNER_ID });
		guest = await connectGuest();
		other = await connect("other-token", { isLoggedIn: false, username: "other" });
	});

	afterEach(async () => {
		room.saveStateToRedisDebounced.cancel();
		if (roommanager.getLoadedRoom("foo")) {
			await roommanager.unloadRoom("foo", UnloadReason.Admin);
		}
		vi.restoreAllMocks();
	});

	describe("promoting and demoting", () => {
		it("lets the owner make a guest a moderator, and everyone hears it", async () => {
			await makeModerator();
			await settle();
			expect(room.users.find(user => user.id === guest.id)).toMatchObject({
				role: Role.Moderator,
				isLoggedIn: false,
			});
			for (const listener of [owner, guest, other]) {
				expect(rolesHeard(listener, guest).at(-1)).toEqual(Role.Moderator);
			}
		});

		it("lets the owner take it away, and everyone hears it at once", async () => {
			await makeModerator();
			await removeModerator();
			await settle();
			for (const listener of [owner, guest, other]) {
				expect(rolesHeard(listener, guest).at(-1)).toEqual(Role.UnregisteredUser);
			}
		});

		it("lets a signed in member holding the grant do both", async () => {
			room.grants.setRoleGrants(Role.Moderator, [
				"chat",
				"playback",
				"manage-users.promote-moderator",
				"manage-users.demote-moderator",
			]);
			room.userRoles.get(Role.Moderator)?.add(MEMBER_ID);
			const member = await connect("member-token", { isLoggedIn: true, user_id: MEMBER_ID });
			promote(member, guest, Role.Moderator);
			await vi.waitFor(() => expect(roleOf(guest)).toEqual(Role.Moderator));
			promote(member, guest, Role.UnregisteredUser);
			await vi.waitFor(() => expect(roleOf(guest)).toEqual(Role.UnregisteredUser));
		});

		it("reaches every tab the guest has open", async () => {
			const secondTab = await connectGuest();
			await makeModerator();
			expect(roleOf(secondTab)).toEqual(Role.Moderator);
			await settle();
			expect(rolesHeard(secondTab, secondTab).at(-1)).toEqual(Role.Moderator);
			await removeModerator(secondTab);
			await settle();
			expect(rolesHeard(guest, guest).at(-1)).toEqual(Role.UnregisteredUser);
			expect(rolesHeard(guest, secondTab).at(-1)).toEqual(Role.UnregisteredUser);
		});

		it("leaves signed in people's roles where they always were", async () => {
			const member = await connect("member-token", { isLoggedIn: true, user_id: MEMBER_ID });
			await makeModerator(member);
			expect(room.userRoles.get(Role.Moderator)?.has(MEMBER_ID)).toEqual(true);
			expect(room.guestRoles.toJSON()).toEqual([]);
			promote(owner, member, Role.RegisteredUser);
			await vi.waitFor(() => expect(roleOf(member)).toEqual(Role.RegisteredUser));
			expect(room.userRoles.get(Role.Moderator)?.has(MEMBER_ID)).toEqual(false);
		});
	});

	describe("refusals", () => {
		const denied = (role: Role) =>
			room.processUnauthorizedRequest(
				{ type: RoomRequestType.PromoteRequest, targetClientId: other.id, role },
				{ token: GUEST_TOKEN, clientId: guest.id },
			);

		it("does not let a plain guest promote anyone, themselves included", async () => {
			await expect(denied(Role.Moderator)).rejects.toThrow(PermissionDeniedException);
			promote(guest, guest, Role.Moderator);
			await settle();
			expect(roleOf(guest)).toEqual(Role.UnregisteredUser);
			expect(room.guestRoles.toJSON()).toEqual([]);
		});

		it("does not let a guest moderator promote others while grants don't allow it", async () => {
			await makeModerator();
			await expect(denied(Role.Moderator)).rejects.toThrow(PermissionDeniedException);
			expect(roleOf(other)).toEqual(Role.UnregisteredUser);
		});

		it("lets a guest moderator promote others once grants do allow it", async () => {
			await makeModerator();
			room.grants.setRoleGrants(Role.Moderator, ["manage-users.promote-moderator"]);
			promote(guest, other, Role.Moderator);
			await vi.waitFor(() => expect(roleOf(other)).toEqual(Role.Moderator));
		});

		it("does not let someone without the demote grant remove a guest moderator", async () => {
			await makeModerator();
			await makeModerator(other);
			promote(other, guest, Role.UnregisteredUser);
			await settle();
			expect(roleOf(guest)).toEqual(Role.Moderator);
		});

		it.each([
			["Administrator", Role.Administrator],
			["Trusted User", Role.TrustedUser],
		])("does not make a guest %s, even for the owner", async (_name, role) => {
			await expect(
				room.processRequest(
					{ type: RoomRequestType.PromoteRequest, targetClientId: guest.id, role },
					{ username: "owner", role: Role.Owner, clientId: owner.id },
				),
			).rejects.toThrow(ImpossiblePromotionException);
			expect(roleOf(guest)).toEqual(Role.UnregisteredUser);
		});

		it("does not take a guest moderator down to Trusted User", async () => {
			await makeModerator();
			await expect(
				room.processRequest(
					{
						type: RoomRequestType.PromoteRequest,
						targetClientId: guest.id,
						role: Role.TrustedUser,
					},
					{ username: "owner", role: Role.Owner, clientId: owner.id },
				),
			).rejects.toThrow(ImpossiblePromotionException);
			expect(roleOf(guest)).toEqual(Role.Moderator);
		});
	});

	describe("what the role lets a guest do", () => {
		const press = (client: WireClient, state: boolean) =>
			client.sendRequest({ type: RoomRequestType.PlaybackRequest, state });
		const seek = (client: WireClient, value: number) =>
			client.sendRequest({ type: RoomRequestType.SeekRequest, value });

		beforeEach(() => {
			room.currentSource = { service: "direct", id: "movie", length: 600 };
		});

		it("refuses play and seek before the role, allows them with it, refuses after", async () => {
			press(guest, true);
			seek(guest, 100);
			await settle();
			expect(room.isPlaying).toEqual(false);
			expect(room.playbackPosition).toEqual(0);

			await makeModerator();
			seek(guest, 100);
			await vi.waitFor(() => expect(room.playbackPosition).toEqual(100));
			press(guest, true);
			await vi.waitFor(() => expect(room.isPlaying).toEqual(true));

			await removeModerator();
			press(guest, false);
			seek(guest, 200);
			await settle();
			expect(room.isPlaying).toEqual(true);
			expect(room.playbackPosition).toEqual(100);
			expect(room.getUser(guest.id)).toBeDefined();
		});

		it("applies to REST too, in the room or not, by the guest's token", async () => {
			const request = { type: RoomRequestType.PlaybackRequest, state: true } as const;
			await expect(
				room.processUnauthorizedRequest(request, { token: GUEST_TOKEN }),
			).rejects.toThrow(PermissionDeniedException);

			await makeModerator();
			await room.processUnauthorizedRequest(request, { token: GUEST_TOKEN });
			expect(room.isPlaying).toEqual(true);

			await disconnect(guest);
			await room.pause();
			await room.processUnauthorizedRequest(request, { token: GUEST_TOKEN });
			expect(room.isPlaying).toEqual(true);

			guest = await connectGuest();
			await removeModerator();
			await disconnect(guest);
			await room.pause();
			await expect(
				room.processUnauthorizedRequest(request, { token: GUEST_TOKEN }),
			).rejects.toThrow(PermissionDeniedException);
		});

		it("gives a guest moderator nothing from another guest's name", async () => {
			await makeModerator();
			const sameName = await connect("different-token", {
				isLoggedIn: false,
				username: "guest",
			});
			expect(roleOf(sameName)).toEqual(Role.UnregisteredUser);
			press(sameName, true);
			await settle();
			expect(room.isPlaying).toEqual(false);
		});
	});

	describe("reconnecting", () => {
		it("keeps the role across a reload, on a new client id", async () => {
			await makeModerator();
			await disconnect(guest);
			const reloaded = await connectGuest();
			expect(reloaded.id).not.toEqual(guest.id);
			expect(roleOf(reloaded)).toEqual(Role.Moderator);
			await settle();
			expect(rolesHeard(owner, reloaded).at(-1)).toEqual(Role.Moderator);
		});

		it("keeps the role taken away while the guest was gone", async () => {
			await makeModerator();
			const secondTab = await connectGuest();
			await disconnect(guest);
			await removeModerator(secondTab);
			await disconnect(secondTab);
			const reloaded = await connectGuest();
			expect(roleOf(reloaded)).toEqual(Role.UnregisteredUser);
		});

		it("keeps the role after a rename", async () => {
			await makeModerator();
			sessions.set(GUEST_TOKEN, { isLoggedIn: false, username: "renamed" });
			guest.sendMessage({ action: "notify", message: "usernameChanged" });
			await vi.waitFor(() => expect(room.getUser(guest.id)?.username).toEqual("renamed"));
			expect(roleOf(guest)).toEqual(Role.Moderator);
		});

		it("gives way to the account while signed in, and returns on signing out", async () => {
			await makeModerator();
			sessions.set(GUEST_TOKEN, { isLoggedIn: true, user_id: MEMBER_ID });
			guest.sendMessage({ action: "notify", message: "usernameChanged" });
			await vi.waitFor(() => expect(room.getUser(guest.id)?.user_id).toEqual(MEMBER_ID));
			expect(roleOf(guest)).toEqual(Role.RegisteredUser);

			sessions.set(GUEST_TOKEN, { isLoggedIn: false, username: "guest" });
			guest.sendMessage({ action: "notify", message: "usernameChanged" });
			await vi.waitFor(() => expect(room.getUser(guest.id)?.user_id).toBeUndefined());
			expect(roleOf(guest)).toEqual(Role.Moderator);
		});
	});

	describe("keeping the token to the server", () => {
		const secrets = () => [GUEST_TOKEN, ...room.guestRoles.toJSON()];

		it("has something to look for", async () => {
			await makeModerator();
			expect(secrets()).toHaveLength(2);
			expect(room.guestRoles.toJSON()[0]).not.toEqual(GUEST_TOKEN);
		});

		it("sends neither token nor key down any socket", async () => {
			await makeModerator();
			await room.sync();
			await removeModerator();
			await makeModerator();
			const reloaded = await connectGuest();
			guest.sendRequest({ type: RoomRequestType.ChatRequest, text: "hello" });
			await settle();
			const keys = secrets();
			for (const listener of [owner, guest, other, reloaded]) {
				const wire = listener.received.join("\n");
				expect(wire).toContain('"role":3');
				for (const secret of keys) {
					expect(wire).not.toContain(secret);
				}
			}
		});

		it("leaves both out of syncable state and the users list", async () => {
			await makeModerator();
			expect(room.syncableState()).not.toHaveProperty("guestRoles");
			const outgoing = [room.serializeSyncableState(), JSON.stringify(room.users)];
			for (const secret of secrets()) {
				for (const text of outgoing) {
					expect(text).not.toContain(secret);
				}
			}
		});

		it("saves only the key, never the token", async () => {
			await makeModerator();
			const saved = JSON.parse(room.serializeState());
			expect(saved.guestRoles).toEqual(room.guestRoles.toJSON());
			expect(room.serializeState()).not.toContain(GUEST_TOKEN);
		});

		it("does not put any of it in the database", async () => {
			const updateRoom = vi.spyOn(storage, "updateRoom").mockResolvedValue(true);
			room.isTemporary = false;
			await makeModerator();
			expect(updateRoom).not.toHaveBeenCalled();
			room.title = "something for the room to save";
			await room.sync();
			expect(updateRoom).toHaveBeenCalled();
			for (const [saved] of updateRoom.mock.calls) {
				expect(saved).not.toHaveProperty("guestRoles");
			}
			const row = JSON.stringify(roomToDbPartial(room));
			for (const secret of secrets()) {
				expect(row).not.toContain(secret);
			}
		});
	});

	describe("how long it lasts", () => {
		const fromRedis = (text: string) => new Room(redisStateToState(JSON.parse(text)));

		it("comes back from the room's saved state", async () => {
			await makeModerator();
			const loaded = fromRedis(room.serializeState());
			expect(loaded.guestRoles.roleOf(GUEST_TOKEN)).toEqual(Role.Moderator);
		});

		it("loads state saved before guests could hold a role", async () => {
			const old = JSON.parse(room.serializeState());
			delete old.guestRoles;
			const loaded = fromRedis(JSON.stringify(old));
			expect(loaded.guestRoles.roleOf(GUEST_TOKEN)).toEqual(Role.UnregisteredUser);
		});

		it("survives a server restart, where the room's Redis state is kept", async () => {
			await makeModerator();
			await roommanager.unloadRoom("foo", UnloadReason.Shutdown, { preserveRedis: true });
			room = (await roommanager.getRoom("foo")).unwrap();
			const back = await connectGuest();
			expect(roleOf(back)).toEqual(Role.Moderator);
		});

		it("ends when the empty room unloads and comes back from the database", async () => {
			await makeModerator();
			room.isTemporary = false;
			vi.spyOn(storage, "updateRoom").mockResolvedValue(true);
			vi.spyOn(storage, "getRoomByName").mockResolvedValue({
				name: "foo",
				owner: room.owner,
			} as never);
			for (const client of [owner, guest, other]) {
				await disconnect(client);
			}
			await roommanager.unloadRoom("foo", UnloadReason.Keepalive);
			room = (await roommanager.getRoom("foo")).unwrap();
			expect(room.guestRoles.toJSON()).toEqual([]);
			const back = await connectGuest();
			expect(roleOf(back)).toEqual(Role.UnregisteredUser);
		});
	});
});

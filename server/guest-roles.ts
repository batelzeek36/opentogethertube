import crypto from "node:crypto";
import { type AuthToken, Role } from "ott-common/models/types.js";
import { z } from "zod";
import { ImpossiblePromotionException } from "./exceptions.js";

/** Anything else out of Redis means no roles, never a role someone was not given. */
const SavedGuestRoles = z.array(z.string()).catch([]);

/**
 * What a room knows a guest by. A guest has no account, so the one thing that stays the same for
 * them across reloads is their browser's auth token, and that token is a credential: whoever holds
 * it is that person. So a room keeps only this one way hash of it, and nothing the room stores can
 * be turned back into a session.
 */
function guestKey(token: AuthToken): string {
	return crypto.createHash("sha256").update(token).digest("base64url");
}

/**
 * The roles a room has given to guests. They can't go in `userRoles` with everyone else's, because
 * that holds account ids. Moderator is the only one a guest can have.
 *
 * This lives with the rest of the room's state in Redis, so it comes back after a server restart and
 * is forgotten when the room unloads. It stays out of the database, and it never goes to a client.
 */
export class GuestRoles {
	private moderators: Set<string>;

	/** @param saved What `toJSON` gave, out of Redis. Rooms saved before this class have nothing. */
	constructor(saved?: unknown) {
		this.moderators = new Set(SavedGuestRoles.parse(saved));
	}

	/** The role the holder of this token has when they are a guest. */
	roleOf(token: AuthToken): Role {
		return this.moderators.has(guestKey(token)) ? Role.Moderator : Role.UnregisteredUser;
	}

	/**
	 * Permissions are the caller's job, this only knows what a guest is able to hold.
	 * @throws ImpossiblePromotionException if a guest can't go from where they are to this role.
	 */
	assign(token: AuthToken, role: Role): void {
		const key = guestKey(token);
		if (role === Role.Moderator) {
			this.moderators.add(key);
			return;
		}
		const isRemoval = role === Role.UnregisteredUser || role === Role.RegisteredUser;
		if (!isRemoval || !this.moderators.delete(key)) {
			throw new ImpossiblePromotionException();
		}
	}

	toJSON(): string[] {
		return Array.from(this.moderators);
	}
}

import { RoomRequestType } from "./models/messages.js";
import type { PermissionName } from "./permissions.js";

/**
 * The room events that can be undone, and the permissions it takes.
 *
 * Undoing takes the permission the undone action took. Undoing an add also takes "remove", because
 * it takes a video out of the queue, and otherwise anyone allowed to add could remove anything that
 * was added recently. Undoing a remove only puts back what was just there, and nothing new can get
 * in that way, so it does not also take "add".
 */
const PERMISSIONS_TO_UNDO: { [T in RoomRequestType]?: PermissionName[] } = {
	[RoomRequestType.SeekRequest]: ["playback.seek"],
	[RoomRequestType.SkipRequest]: ["playback.skip"],
	[RoomRequestType.AddRequest]: ["manage-queue.add", "manage-queue.remove"],
	[RoomRequestType.RemoveRequest]: ["manage-queue.remove"],
};

/** @returns The permissions undoing this kind of event takes, or undefined if it can't be undone. */
export function permissionsToUndo(type: RoomRequestType): PermissionName[] | undefined {
	return PERMISSIONS_TO_UNDO[type];
}

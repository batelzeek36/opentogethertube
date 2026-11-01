import type { RoomEventId, RoomRequest, RoomRequestContext } from "ott-common/models/messages.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import type { RoomEventContext } from "ott-common/models/types.js";
import type { QueueItem } from "ott-common/models/video.js";
import type { Grants } from "ott-common/permissions.js";
import { permissionsToUndo } from "ott-common/undo.js";
import { v4 as uuidv4 } from "uuid";
import { EventNotUndoableException } from "./exceptions.js";
import type { VideoQueue } from "./videoqueue.js";

/** Longer than any toast's undo button stays up, even after being renewed by more seeks. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;
/** Rooms can be busy for a long time, and nothing else ever clears this out. */
export const MAX_UNDOABLE_EVENTS = 100;

/** What undoing needs from the room it belongs to. */
export interface UndoHost {
	readonly grants: Grants;
	readonly queue: VideoQueue;
	currentSource: QueueItem | null;
	playbackPosition: number;
	processRequest(request: RoomRequest, context: RoomRequestContext): Promise<void>;
}

interface RecordedEvent {
	type: RoomRequestType;
	additional: RoomEventContext;
	at: number;
}

/**
 * The room's recent events that can be undone, as the server saw them happen.
 *
 * Clients refer to these by id and never send their own copy. Undoing puts videos on screen and in
 * the queue, so enacting a client's description of an event would let anyone play anything.
 */
export class UndoableEvents {
	private events = new Map<RoomEventId, RecordedEvent>();

	constructor(private room: UndoHost) {}

	/** @returns The id clients can undo this event by, if it can be undone. */
	record(request: RoomRequest, additional: RoomEventContext): RoomEventId | undefined {
		if (!permissionsToUndo(request.type)) {
			return undefined;
		}
		const id = uuidv4();
		this.events.set(id, { type: request.type, additional, at: Date.now() });
		if (this.events.size > MAX_UNDOABLE_EVENTS) {
			// A Map iterates oldest first.
			this.events.delete(this.events.keys().next().value as RoomEventId);
		}
		return id;
	}

	/**
	 * Undo an event. Everything up to the delete is synchronous, so of two people undoing the same
	 * event only one of them does anything.
	 * @param eventId Came from a client, so it could be anything.
	 * @throws EventNotUndoableException
	 * @throws PermissionDeniedException
	 */
	async undo(eventId: RoomEventId, context: RoomRequestContext): Promise<void> {
		const event = this.events.get(eventId);
		if (!event || Date.now() - event.at > UNDO_WINDOW_MS) {
			throw new EventNotUndoableException();
		}
		for (const permission of permissionsToUndo(event.type) ?? []) {
			this.room.grants.check(context.role, permission);
		}
		// Only now: someone who gets refused must not use the undo up for everyone else.
		this.events.delete(eventId);

		switch (event.type) {
			case RoomRequestType.SeekRequest:
				await this.undoSeek(event.additional, context);
				break;
			case RoomRequestType.SkipRequest:
				await this.undoSkip(event.additional);
				break;
			case RoomRequestType.AddRequest:
				await this.undoAdd(event.additional, context);
				break;
			case RoomRequestType.RemoveRequest:
				await this.undoRemove(event.additional);
				break;
		}
	}

	private async undoSeek(
		{ prevPosition }: RoomEventContext,
		context: RoomRequestContext,
	): Promise<void> {
		if (prevPosition !== undefined) {
			await this.room.processRequest(
				{ type: RoomRequestType.SeekRequest, value: prevPosition },
				context,
			);
		}
	}

	private async undoSkip({ video, prevPosition }: RoomEventContext): Promise<void> {
		if (!video || prevPosition === undefined) {
			return;
		}
		if (this.room.currentSource) {
			await this.room.queue.pushTop(this.room.currentSource);
		}
		this.room.currentSource = video;
		this.room.playbackPosition = prevPosition;
	}

	private async undoAdd(
		{ video, videos }: RoomEventContext,
		context: RoomRequestContext,
	): Promise<void> {
		for (const added of videos ?? (video ? [video] : [])) {
			const current = this.room.currentSource;
			if (this.room.queue.contains(added)) {
				await this.room.processRequest(
					{ type: RoomRequestType.RemoveRequest, video: added },
					context,
				);
			} else if (current?.service === added.service && current.id === added.id) {
				this.room.currentSource = null;
			}
		}
	}

	private async undoRemove({ video, queueIdx }: RoomEventContext): Promise<void> {
		if (!video || queueIdx === undefined || this.room.queue.contains(video)) {
			return;
		}
		// The queue may have got shorter since.
		await this.room.queue.insert(video, Math.min(queueIdx, this.room.queue.length));
	}
}

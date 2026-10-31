import type { ServerMessageVoice, ServerMessageVoiceYou } from "ott-common/models/messages.js";
import type { ClientId } from "ott-common/models/types.js";
import {
	VOICE_CHANNELS,
	VOICE_FRAME_BURST,
	VOICE_MAX_FRAMES_PER_SECOND,
	type VoiceChannelId,
	type VoiceJoinRefusal,
	type VoiceRules,
	type VoiceTalkRefusal,
	type VoiceTurnEnd,
	isValidVoiceFrame,
	isVoiceChannel,
} from "ott-common/models/voice.js";
import { Counter } from "prom-client";
import { getLogger } from "./logger.js";

const log = getLogger("voice");

/** What voice needs from the room it belongs to. */
export interface VoiceHost {
	rules(): VoiceRules;
	/** Send to everyone in the room. Only ever used for state, never audio. */
	publish(msg: ServerMessageVoice): void;
	sendTo(clientId: ClientId, msg: ServerMessageVoiceYou): void;
	/** Identifies a person across reconnects, or undefined if the client is not in the room. */
	personKey(clientId: ClientId): string | undefined;
	clientIds(): ClientId[];
}

interface Turn {
	clientId: ClientId;
	startedAt: number;
	timer: ReturnType<typeof setTimeout>;
	frameTokens: number;
	lastFrameAt: number;
}

/**
 * The voice channels of one room: who is in them, whose turn it is, and who gets each audio frame.
 *
 * All of this state lives in memory and every decision is made synchronously, so two presses that
 * arrive together are handled one after the other and exactly one of them gets the turn. Nothing
 * here keeps or logs a frame: `acceptFrame` only decides where it goes.
 */
export class VoiceChannels {
	private members = new Map<ClientId, VoiceChannelId>();
	private turns = new Map<VoiceChannelId, Turn>();
	/** When each person's slow mode wait ends. By person, so reconnecting does not skip the wait. */
	private cooldownUntil = new Map<string, number>();
	/** People removed by a mod. By person, so reconnecting does not get them back in. */
	private removedPeople = new Set<string>();

	constructor(private host: VoiceHost) {}

	join(clientId: ClientId, channel: VoiceChannelId): void {
		if (!isVoiceChannel(channel)) {
			this.refuseJoin(clientId, "invalid-channel");
			return;
		}
		if (!this.host.rules().voiceEnabled) {
			this.refuseJoin(clientId, "voice-off");
			return;
		}
		const person = this.host.personKey(clientId);
		if (person === undefined) {
			return;
		}
		if (this.removedPeople.has(person)) {
			this.refuseJoin(clientId, "removed");
			return;
		}
		if (this.members.get(clientId) === channel) {
			this.publishState();
			return;
		}
		this.leaveOtherSeatsOf(person, clientId);
		this.endTurnOf(clientId, "left");
		this.members.set(clientId, channel);
		this.publishState();
	}

	/**
	 * One seat per person. Audio goes to every member but the talking client, so a second tab on the
	 * same phone played a person's own voice back into their mic (seen on the S25).
	 */
	private leaveOtherSeatsOf(person: string, clientId: ClientId): void {
		for (const memberId of [...this.members.keys()]) {
			if (memberId !== clientId && this.host.personKey(memberId) === person) {
				this.leave(memberId);
			}
		}
	}

	/** Leave voice. Called for a Leave tap and when the client leaves the room. */
	leave(clientId: ClientId): void {
		const wasMember = this.members.has(clientId);
		this.endTurnOf(clientId, "left");
		this.members.delete(clientId);
		if (wasMember) {
			this.publishState();
		}
	}

	/** The client pressed the talk button. */
	startTalk(clientId: ClientId): void {
		const rules = this.host.rules();
		if (!rules.voiceEnabled) {
			this.refuseTalk(clientId, "voice-off");
			return;
		}
		const channel = this.members.get(clientId);
		if (channel === undefined) {
			this.refuseTalk(clientId, "not-in-channel");
			return;
		}
		const current = this.turns.get(channel);
		if (current) {
			if (current.clientId !== clientId) {
				this.refuseTalk(clientId, "busy", this.cooldownRemaining(clientId));
			}
			return;
		}
		const cooldownMs = this.cooldownRemaining(clientId);
		if (cooldownMs > 0) {
			this.refuseTalk(clientId, "cooldown", cooldownMs);
			return;
		}
		const now = Date.now();
		this.turns.set(channel, {
			clientId,
			startedAt: now,
			timer: this.startLimitTimer(channel, rules.voiceMaxTalkSeconds * 1000),
			frameTokens: VOICE_FRAME_BURST,
			lastFrameAt: now,
		});
		log.debug(`client ${clientId} started talking in ${channel}`);
		this.host.sendTo(clientId, {
			action: "voice-you",
			event: "talk-granted",
			maxTalkMs: rules.voiceMaxTalkSeconds * 1000,
		});
		this.publishState();
	}

	/** The client let go of the talk button. */
	stopTalk(clientId: ClientId): void {
		this.endTurnOf(clientId, "released");
	}

	/** Take a person out of voice, on every device they are connected with, and keep them out. */
	remove(clientId: ClientId): void {
		const person = this.host.personKey(clientId);
		if (person === undefined) {
			return;
		}
		this.removedPeople.add(person);
		for (const memberId of [...this.members.keys()]) {
			if (this.host.personKey(memberId) === person) {
				this.endTurnOf(memberId, "removed");
				this.members.delete(memberId);
			}
		}
		this.publishState();
	}

	/** Let a removed person join again. */
	allow(clientId: ClientId): void {
		const person = this.host.personKey(clientId);
		if (person !== undefined && this.removedPeople.delete(person)) {
			this.publishState();
		}
	}

	/** Apply the room's rules to whatever is going on right now. */
	onRulesChanged(): void {
		const rules = this.host.rules();
		if (!rules.voiceEnabled) {
			for (const channel of [...this.turns.keys()]) {
				this.endTurn(channel, "voice-off", false);
			}
			if (this.members.size > 0) {
				this.members.clear();
				this.publishState();
			}
			return;
		}

		const now = Date.now();
		const maxTalkMs = rules.voiceMaxTalkSeconds * 1000;
		for (const [channel, turn] of [...this.turns]) {
			clearTimeout(turn.timer);
			turn.timer = this.startLimitTimer(channel, turn.startedAt + maxTalkMs - now);
		}

		const longestWait = now + rules.voiceSlowModeSeconds * 1000;
		for (const [person, until] of this.cooldownUntil) {
			this.cooldownUntil.set(person, Math.min(until, longestWait));
		}
		for (const clientId of this.members.keys()) {
			this.host.sendTo(clientId, {
				action: "voice-you",
				event: "cooldown",
				cooldownMs: this.cooldownRemaining(clientId),
			});
		}
	}

	/**
	 * Decide what happens to an incoming audio frame. Returns who should get it, which is the other
	 * members of the speaker's channel, or null if the frame must be dropped.
	 */
	acceptFrame(clientId: ClientId, frame: Uint8Array): ClientId[] | null {
		const channel = this.members.get(clientId);
		const turn = channel === undefined ? undefined : this.turns.get(channel);
		if (turn?.clientId !== clientId) {
			counterFrames.labels({ result: "not-speaker" }).inc();
			return null;
		}
		if (!isValidVoiceFrame(frame)) {
			counterFrames.labels({ result: "malformed" }).inc();
			return null;
		}
		const now = Date.now();
		turn.frameTokens = Math.min(
			VOICE_FRAME_BURST,
			turn.frameTokens + ((now - turn.lastFrameAt) / 1000) * VOICE_MAX_FRAMES_PER_SECOND,
		);
		turn.lastFrameAt = now;
		if (turn.frameTokens < 1) {
			counterFrames.labels({ result: "over-rate" }).inc();
			return null;
		}
		turn.frameTokens -= 1;
		counterFrames.labels({ result: "relayed" }).inc();

		const recipients: ClientId[] = [];
		for (const [memberId, memberChannel] of this.members) {
			if (memberChannel === channel && memberId !== clientId) {
				recipients.push(memberId);
			}
		}
		return recipients;
	}

	state(): ServerMessageVoice {
		const removed = this.host
			.clientIds()
			.filter(id => this.removedPeople.has(this.host.personKey(id) ?? ""));
		return {
			action: "voice",
			channels: VOICE_CHANNELS.map(id => ({
				id,
				members: [...this.members]
					.filter(([, c]) => c === id)
					.map(([clientId]) => clientId),
				speaker: this.turns.get(id)?.clientId ?? null,
			})),
			removed,
		};
	}

	publishState(): void {
		this.host.publish(this.state());
	}

	/** Stop every timer. Called when the room unloads. */
	dispose(): void {
		for (const turn of this.turns.values()) {
			clearTimeout(turn.timer);
		}
		this.turns.clear();
		this.members.clear();
	}

	private startLimitTimer(channel: VoiceChannelId, ms: number): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => this.endTurn(channel, "limit"), Math.max(ms, 0));
		timer.unref?.();
		return timer;
	}

	private endTurnOf(clientId: ClientId, reason: VoiceTurnEnd): void {
		const channel = this.members.get(clientId);
		if (channel !== undefined && this.turns.get(channel)?.clientId === clientId) {
			this.endTurn(channel, reason);
		}
	}

	private endTurn(channel: VoiceChannelId, reason: VoiceTurnEnd, publish = true): void {
		const turn = this.turns.get(channel);
		if (!turn) {
			return;
		}
		clearTimeout(turn.timer);
		this.turns.delete(channel);
		log.debug(`client ${turn.clientId} stopped talking in ${channel}: ${reason}`);

		const now = Date.now();
		for (const [person, until] of this.cooldownUntil) {
			if (until <= now) {
				this.cooldownUntil.delete(person);
			}
		}
		const slowModeMs = this.host.rules().voiceSlowModeSeconds * 1000;
		const person = this.host.personKey(turn.clientId);
		if (slowModeMs > 0 && person !== undefined) {
			this.cooldownUntil.set(person, now + slowModeMs);
		}
		this.host.sendTo(turn.clientId, {
			action: "voice-you",
			event: "talk-ended",
			reason,
			cooldownMs: this.cooldownRemaining(turn.clientId),
		});
		if (publish) {
			this.publishState();
		}
	}

	private cooldownRemaining(clientId: ClientId): number {
		const person = this.host.personKey(clientId);
		const until = person === undefined ? undefined : this.cooldownUntil.get(person);
		return until === undefined ? 0 : Math.max(until - Date.now(), 0);
	}

	private refuseTalk(clientId: ClientId, reason: VoiceTalkRefusal, cooldownMs = 0): void {
		this.host.sendTo(clientId, {
			action: "voice-you",
			event: "talk-refused",
			reason,
			cooldownMs,
		});
	}

	private refuseJoin(clientId: ClientId, reason: VoiceJoinRefusal): void {
		this.host.sendTo(clientId, { action: "voice-you", event: "join-refused", reason });
	}
}

const counterFrames = new Counter({
	name: "ott_voice_frames",
	help: "Audio frames received from clients, by what happened to them. Counts only, never audio.",
	labelNames: ["result"],
});

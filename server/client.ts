import {
	type AuthToken,
	type ClientId,
	type ClientInfo,
	OttWebsocketError,
} from "ott-common/models/types.js";
import type { ClientMessage, ServerMessage } from "ott-common/models/messages.js";
import type WebSocket from "ws";
import { type SessionInfo, setSessionInfo } from "./auth/tokens.js";
import { v4 as uuidv4 } from "uuid";
import EventEmitter from "node:events";
import { getLogger } from "./logger.js";
import { getSessionInfo } from "./auth/tokens.js";
import type { BalancerConnection } from "./balancer.js";
import { replacer } from "ott-common/serialize.js";
import { Counter } from "prom-client";

const log = getLogger("client");

export type ClientEvents = "auth" | "message" | "binary" | "disconnect";
export type ClientEventHandlers<E> = E extends "auth"
	? (client: Client, token: AuthToken, session: SessionInfo) => void
	: E extends "message"
		? (client: Client, msg: ClientMessage) => void
		: E extends "binary"
			? (client: Client, data: Buffer) => void
			: E extends "disconnect"
				? (client: Client) => void
				: never;

/**
 * Stop sending audio to a socket with this much already waiting to go out, roughly a second of
 * audio. Its owner has fallen behind, and late audio is worse than a gap.
 */
const MAX_BUFFERED_BYTES_FOR_BINARY = 32 * 1024;

/** Parsed JSON can be anything, and only an object can be a message. */
function isMessageShaped(msg: unknown): msg is ClientMessage {
	return typeof msg === "object" && msg !== null;
}

export enum ClientJoinStatus {
	WaitingForAuth,
	Joined,
}

/**
 * A client that is connected to the server.
 */
export abstract class Client {
	id: ClientId;
	room: string;
	token: AuthToken | null = null;
	session?: SessionInfo;
	joinStatus: ClientJoinStatus = ClientJoinStatus.WaitingForAuth;

	private bus: EventEmitter;
	/** Set before the first await in auth, so two messages sent together can't both get through. */
	private authStarted = false;

	constructor(room: string) {
		this.id = uuidv4();
		this.room = room;
		this.bus = new EventEmitter();
	}

	abstract get clientType(): string;

	on<E extends ClientEvents>(event: E, handler: ClientEventHandlers<E>) {
		this.bus.on(event, handler);
	}

	emit<E extends ClientEvents>(event: E, ...args: Parameters<ClientEventHandlers<E>>) {
		this.bus.emit(event, ...args);
	}

	async saveSession(): Promise<void> {
		if (!this.token) {
			throw new Error("Client has not authenticated yet");
		}
		if (!this.session) {
			throw new Error("Client has no session");
		}
		await setSessionInfo(this.token, this.session);
	}

	/**
	 * Say who this client is. This happens once per connection. Another would join the room again,
	 * which duplicates the user and everything sent to them, and would change who they are.
	 */
	public async auth(token: AuthToken): Promise<void> {
		if (this.authStarted) {
			log.warn(`Client ${this.id} tried to authenticate again, ignoring`);
			return;
		}
		this.authStarted = true;
		if (!token) {
			log.warn("Client sent empty auth token, kicking");
			this.kick(OttWebsocketError.MISSING_TOKEN);
			return;
		}
		this.token = token;
		try {
			this.session = await getSessionInfo(this.token);
		} catch (err) {
			log.warn(`Client sent invalid auth token, kicking: ${err}`);
			this.kick(OttWebsocketError.MISSING_TOKEN);
			return;
		}
		this.joinStatus = ClientJoinStatus.Joined;
		this.emit("auth", this, this.token, this.session);
	}

	send(msg: ServerMessage) {
		this.sendRaw(JSON.stringify(msg, replacer));
	}

	abstract sendRaw(msg: string): void;
	abstract kick(code: number): void;

	getClientInfo(): ClientInfo {
		if (!this.session) {
			log.warn("Client has no session, client info will be incomplete");
			return {
				id: this.id,
			};
		}
		if (this.session.isLoggedIn) {
			return {
				id: this.id,
				user_id: this.session.user_id,
			};
		} else {
			return {
				id: this.id,
				username: this.session.username,
			};
		}
	}
}

/**
 * A client that is connected directly to the server.
 */
export class DirectClient extends Client {
	socket: WebSocket;

	constructor(room: string, socket: WebSocket) {
		super(room);
		this.socket = socket;

		this.socket.on("message", this.onData.bind(this));
		this.socket.on("ping", this.onPing.bind(this));
		this.socket.on("close", this.onClose.bind(this));
		this.socket.on("error", this.onError.bind(this));
	}

	get clientType() {
		return "direct";
	}

	onData(data: WebSocket.Data) {
		// Audio frames take their own path: they must never reach the JSON parser or any logging.
		// Text arrives as a string and binary as a Buffer, which is how this version of ws tells them apart.
		if (typeof data !== "string") {
			if (Buffer.isBuffer(data)) {
				this.emit("binary", this, data);
			}
			return;
		}
		let msg: unknown;
		try {
			msg = JSON.parse(data);
		} catch {
			log.warn(`Dropping a message that is not valid JSON from client ${this.id}`);
			return;
		}
		if (!isMessageShaped(msg)) {
			log.warn(`Dropping a message that is not an object from client ${this.id}`);
			return;
		}
		if (msg.action === "auth") {
			void this.authFromSocket(msg.token);
			return;
		}
		this.emit("message", this, msg);
	}

	/** Nothing waits for a socket's listeners, so a failure has to stop here. */
	private async authFromSocket(token: AuthToken): Promise<void> {
		try {
			await this.auth(token);
		} catch (err) {
			log.error(`Failed to authenticate client ${this.id}: ${err}`);
		}
	}

	onPing() {
		this.socket.pong();
	}

	onClose() {
		this.emit("disconnect", this);
	}

	onError(err: Error) {
		log.error(`Error on socket for client ${this.id}: ${err}`);
	}

	sendRaw(msg: string) {
		this.socket.send(msg);
	}

	sendBinary(data: Buffer) {
		if (this.socket.bufferedAmount <= MAX_BUFFERED_BYTES_FOR_BINARY) {
			this.socket.send(data, { binary: true });
		}
	}

	kick(code: number) {
		this.socket.close(code);
		counterWebsocketCloseCodes.inc({ code: OttWebsocketError[code] ?? String(code) });
	}

	ping() {
		this.socket.ping();
	}
}

/**
 * A client that is connected from a load balancer.
 */
export class BalancerClient extends Client {
	conn: BalancerConnection;

	constructor(room: string, clientId: ClientId, conn: BalancerConnection) {
		super(room);
		this.id = clientId;
		this.conn = conn;
	}

	get clientType() {
		return "balancer.js";
	}

	leave() {
		this.emit("disconnect", this);
	}

	receiveMessage(msg: ClientMessage) {
		if (!isMessageShaped(msg)) {
			log.warn(`Dropping a message that is not an object from client ${this.id}`);
			return;
		}
		this.emit("message", this, msg);
	}

	send(msg: ServerMessage) {
		this.conn.send({
			type: "room_msg",
			payload: {
				room: this.room,
				client_id: this.id,
				payload: msg,
			},
		});
	}

	sendRaw(msg: string) {
		throw new Error("Not implemented");
	}

	kick(code: number) {
		this.conn.send({
			type: "kick",
			payload: {
				client_id: this.id,
				reason: code,
			},
		});
		counterWebsocketCloseCodes.inc({ code: OttWebsocketError[code] ?? String(code) });
		this.leave();
	}
}

const counterWebsocketCloseCodes = new Counter({
	name: "ott_websocket_kick_close_codes",
	help: "Count of websocket close codes",
	labelNames: ["code"],
});

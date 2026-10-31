import { inject, type InjectionKey, type App, type Plugin, ref, type Ref } from "vue";
import type {
	ClientMessage,
	ClientMessageAuthenticate,
	ServerMessage,
	ServerMessageActionType,
} from "ott-common/models/messages";
import type { AuthToken, OttWebsocketError } from "ott-common/models/types";

export interface OttRoomConnection {
	active: Ref<boolean>;
	connected: Ref<boolean>;
	kickReason: Ref<OttWebsocketError | null>;

	connect(roomName: string): void;
	reconnect(): void;
	disconnect(): void;
	send(message: ClientMessage): void;
	/** Send audio. Returns false if it was dropped, because late audio is worse than a gap. */
	sendBinary(data: ArrayBuffer): boolean;
	/** Receive audio. Binary messages are never parsed or logged. */
	setBinaryHandler(handler: ((data: ArrayBuffer) => void) | null): void;
	addMessageHandler(action: ServerMessageActionType, handler: (msg: ServerMessage) => void): void;
	removeMessageHandler(
		action: ServerMessageActionType,
		handler: (msg: ServerMessage) => void,
	): void;
	clearAllMessageHandlers(): void;
}

export const connectionInjectKey: InjectionKey<OttRoomConnection> = Symbol("ott:connection");

export function useConnection(): OttRoomConnection {
	const connection = inject(connectionInjectKey);
	if (!connection) {
		throw new Error("No connection available, did you forget to install the plugin?");
	}
	return connection;
}

type ConnectionEventKind = "connected" | "disconnected" | "kicked";

export type ConnectionEvent =
	| ConnectionEventConnected
	| ConnectionEventDisconnected
	| ConnectionEventKicked;

export interface ConnectionEventConnected {
	kind: "connected";
}

export interface ConnectionEventDisconnected {
	kind: "disconnected";
}

export interface ConnectionEventKicked {
	kind: "kicked";
	reason: OttWebsocketError;
}

/** Roughly half a second of audio. Past this the network is behind and new audio is dropped. */
const MAX_BUFFERED_BYTES_FOR_BINARY = 16 * 1024;

function getReconnectDelayMs(
	reconnectAttempts: number,
	reconnectDelay: number,
	reconnectDelayIncrease: number,
	randomValue = Math.random(),
) {
	const baseDelay = reconnectDelay + reconnectDelayIncrease * reconnectAttempts;
	return Math.round(baseDelay * (0.5 + randomValue));
}

class OttRoomConnectionReal implements OttRoomConnection {
	/**
	 * Indicates if the client is actively attempting to maintain a connection. Not an indication of whether the connection is connected, see `connected`.
	 * @returns true if the client is actively attempting to maintain a connection to a room.
	 */
	active = ref(false);
	reconnecting = ref(false);
	connected = ref(false);
	roomName = ref("");
	reconnectAttempts = ref(0);
	reconnectDelay = 1000;
	reconnectDelayIncrease = 2000;
	kickReason: Ref<OttWebsocketError | null> = ref(null);

	private socket: WebSocket | null = null;
	private binaryHandler: ((data: ArrayBuffer) => void) | null = null;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private messageHandlers = new Map<ServerMessageActionType, ((msg: ServerMessage) => void)[]>();
	private eventHandlers = new Map<ConnectionEventKind, ((e: unknown) => void)[]>();

	get connectionUrl() {
		return `${window.location.protocol.startsWith("https") ? "wss" : "ws"}://${
			window.location.host
		}${(import.meta.env.OTT_BASE_URL as string | undefined) ?? ""}/api/room/${
			this.roomName.value
		}`;
	}

	connect(roomName: string) {
		if (this.active.value) {
			console.log("connect(): connection is already active, ignoring");
			return;
		}
		this.roomName.value = roomName;
		this.active.value = true;
		this.kickReason.value = null;
		this.doConnect(this.connectionUrl);
	}

	reconnect() {
		if (!this.active.value) {
			console.log("reconnect(): connection is not active, ignoring");
			return;
		}
		console.log("reconnecting...");
		this.reconnectAttempts.value += 1;
		this.doConnect(`${this.connectionUrl}?reconnect=true`);
	}

	private doConnect(url: string) {
		this.socket = new WebSocket(url);
		this.socket.binaryType = "arraybuffer";
		console.debug(`connecting to ${url}`);
		this.socket.addEventListener("open", () => this.onOpen());
		this.socket.addEventListener("close", e => this.onClose(e));
		this.socket.addEventListener("message", e => this.onMessage(e));
		this.socket.addEventListener("error", e => this.onError(e));
	}

	send(message: ClientMessage) {
		if (!this.active.value) {
			throw new Error("send(): connection is not active");
		}
		if (!this.connected.value) {
			throw new Error("send(): connection is not connected");
		}
		const text = JSON.stringify(message);
		this.socket!.send(text);
	}

	sendBinary(data: ArrayBuffer): boolean {
		const socket = this.socket;
		if (
			!socket ||
			socket.readyState !== WebSocket.OPEN ||
			socket.bufferedAmount > MAX_BUFFERED_BYTES_FOR_BINARY
		) {
			return false;
		}
		socket.send(data);
		return true;
	}

	setBinaryHandler(handler: ((data: ArrayBuffer) => void) | null): void {
		this.binaryHandler = handler;
	}

	disconnect() {
		if (!this.active.value) {
			console.log("disconnect(): connection is not active, ignoring");
			return;
		}
		this.socket!.close();
		this.socket = null;
		if (this.reconnecting && this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.roomName.value = "";
		this.active.value = false;
	}

	private onOpen() {
		this.connected.value = true;
		this.reconnecting.value = false;
		this.reconnectAttempts.value = 0;
		console.info("socket open");
		const authMsg: ClientMessageAuthenticate = {
			action: "auth",
			token: window.localStorage.getItem("token") as AuthToken,
		};
		this.send(authMsg);
	}

	private onClose(e: { code: number }) {
		console.info("socket closed", e);
		this.connected.value = false;
		this.socket = null;
		this.dispatchEvent({ kind: "disconnected" });
		if (e.code >= 4000) {
			this.kickReason.value = e.code;
			this.dispatchEvent({ kind: "kicked", reason: e.code });
			this.active.value = false;
		} else if (this.active.value) {
			this.reconnecting.value = true;
			this.reconnectTimeout = setTimeout(() => this.reconnect(), this.getReconnectDelay());
		}
	}

	private getReconnectDelay() {
		return getReconnectDelayMs(
			this.reconnectAttempts.value,
			this.reconnectDelay,
			this.reconnectDelayIncrease,
		);
	}

	private onMessage(e: { data: string | unknown }) {
		if (e.data instanceof ArrayBuffer) {
			this.binaryHandler?.(e.data);
		} else if (typeof e.data === "string") {
			try {
				const msg = JSON.parse(e.data) as ServerMessage;
				this.handleMessage(msg);
			} catch (e) {
				console.error("unable to process message: ", e.data, e);
			}
		}
	}

	private onError(e: unknown) {
		console.log("socket error", e);
	}

	addMessageHandler(action: ServerMessageActionType, handler: (msg: ServerMessage) => void) {
		const handlers = this.messageHandlers.get(action) ?? [];
		handlers.push(handler);
		this.messageHandlers.set(action, handlers);
	}

	removeMessageHandler(action: ServerMessageActionType, handler: (msg: ServerMessage) => void) {
		const handlers = this.messageHandlers.get(action) ?? [];
		const index = handlers.indexOf(handler);
		if (index >= 0) {
			handlers.splice(index, 1);
			this.messageHandlers.set(action, handlers);
		}
	}

	clearAllMessageHandlers(): void {
		this.messageHandlers.clear();
	}

	private handleMessage(msg: ServerMessage) {
		const handlers = this.messageHandlers.get(msg.action) ?? [];
		if (handlers.length === 0) {
			console.error("connection: no message handlers for message: ", msg.action);
			return;
		}
		for (const handler of handlers) {
			handler(msg);
		}
	}

	addEventHandler(event: ConnectionEventKind, handler: (e: unknown) => void) {
		const handlers = this.eventHandlers.get(event) ?? [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	removeEventHandler(event: ConnectionEventKind, handler: (e: unknown) => void) {
		const handlers = this.eventHandlers.get(event) ?? [];
		const index = handlers.indexOf(handler);
		if (index >= 0) {
			handlers.splice(index, 1);
			this.eventHandlers.set(event, handlers);
		}
	}

	dispatchEvent(e: ConnectionEvent) {
		console.info("dispatching event", e);
		const handlers = this.eventHandlers.get(e.kind) ?? [];
		for (const handler of handlers) {
			handler(e);
		}
	}
}

export const OttRoomConnectionPlugin: Plugin = (app: App, options) => {
	const connection = new OttRoomConnectionReal();
	app.provide(connectionInjectKey, connection);
};

export default OttRoomConnectionPlugin;

export class OttRoomConnectionMock implements OttRoomConnection {
	active: Ref<boolean> = ref(false);
	connected: Ref<boolean> = ref(false);
	kickReason: Ref<OttWebsocketError | null> = ref(null);

	sent: ClientMessage[] = [];
	sentBinary: ArrayBuffer[] = [];
	binaryHandler: ((data: ArrayBuffer) => void) | null = null;
	private messageHandlers = new Map<ServerMessageActionType, ((msg: ServerMessage) => void)[]>();

	public mockReset() {
		this.sent = [];
		this.sentBinary = [];
	}

	public mockReceive(msg: ServerMessage) {
		this.handleMessage(msg);
	}

	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	public connect(roomName: string) {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	public reconnect() {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	public disconnect() {}
	public send(message: ClientMessage) {
		this.sent.push(message);
	}

	public sendBinary(data: ArrayBuffer): boolean {
		this.sentBinary.push(data);
		return true;
	}

	public setBinaryHandler(handler: ((data: ArrayBuffer) => void) | null): void {
		this.binaryHandler = handler;
	}

	public addMessageHandler(
		action: ServerMessageActionType,
		handler: (msg: ServerMessage) => void,
	) {
		const handlers = this.messageHandlers.get(action) ?? [];
		handlers.push(handler);
		this.messageHandlers.set(action, handlers);
	}

	public removeMessageHandler(
		action: ServerMessageActionType,
		handler: (msg: ServerMessage) => void,
	) {
		const handlers = this.messageHandlers.get(action) ?? [];
		const index = handlers.indexOf(handler);
		if (index >= 0) {
			handlers.splice(index, 1);
			this.messageHandlers.set(action, handlers);
		}
	}

	clearAllMessageHandlers(): void {
		this.messageHandlers.clear();
	}

	private handleMessage(msg: ServerMessage) {
		const handlers = this.messageHandlers.get(msg.action) ?? [];
		if (handlers.length === 0) {
			return;
		}
		for (const handler of handlers) {
			handler(msg);
		}
	}
}

export const MockOttRoomConnectionPlugin: Plugin = (app: App, options) => {
	const connection = new OttRoomConnectionMock();
	app.provide(connectionInjectKey, connection);
};

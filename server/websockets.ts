import WebSocket from "ws";
import { getLogger } from "./logger.js";
import type { Server } from "node:http";
import type { Socket } from "node:net";

const log = getLogger("websockets");
// Clients only ever send short messages and audio frames, so nobody gets to make the server buffer
// anything big before it can look at it (the library's own limit is 100 MiB).
export const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });

/**
 * Set up the websocket server.
 */
export function setup(httpServer: Server) {
	log.debug("setting up websocket upgrader...");
	wss.on("error", e => {
		log.error(`Websocket server error: ${e}`);
	});
	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket as Socket, head, ws => {
			wss.emit("connection", ws, req);
		});
	});
}

export default {
	setup,
	wss,
};

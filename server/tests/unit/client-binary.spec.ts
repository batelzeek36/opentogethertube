import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { DirectClient } from "../../client.js";

class FakeSocket extends EventEmitter {
	bufferedAmount = 0;
	send = vi.fn();
	close = vi.fn();
}

function setup() {
	const socket = new FakeSocket();
	const client = new DirectClient("room", socket as unknown as WebSocket);
	const binary = vi.fn();
	const message = vi.fn();
	client.on("binary", binary);
	client.on("message", message);
	return { socket, client, binary, message };
}

describe("DirectClient", () => {
	it("hands binary messages over without parsing them", () => {
		const { socket, binary, message } = setup();
		const frame = Buffer.from("not json at all");
		socket.emit("message", frame);
		expect(binary).toHaveBeenCalledWith(expect.anything(), frame);
		expect(message).not.toHaveBeenCalled();
	});

	it("still handles JSON messages", () => {
		const { socket, binary, message } = setup();
		socket.emit("message", JSON.stringify({ action: "kickme" }));
		expect(message).toHaveBeenCalledWith(expect.anything(), { action: "kickme" });
		expect(binary).not.toHaveBeenCalled();
	});

	it("drops a text message that is not JSON instead of throwing", () => {
		const { socket, message } = setup();
		expect(() => socket.emit("message", "{not json")).not.toThrow();
		expect(message).not.toHaveBeenCalled();
	});

	it("sends audio as binary, and skips a socket that has fallen behind", () => {
		const { socket, client } = setup();
		const frame = Buffer.alloc(10);
		client.sendBinary(frame);
		expect(socket.send).toHaveBeenCalledWith(frame, { binary: true });
		socket.send.mockClear();
		socket.bufferedAmount = 1024 * 1024;
		client.sendBinary(frame);
		expect(socket.send).not.toHaveBeenCalled();
	});
});

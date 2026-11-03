import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import { RESPONSE_MAX_BYTES } from "../../http-limits.js";
import HlsVideoAdapter from "../../services/hls.js";
import DashVideoAdapter from "../../services/dash.js";
import DirectVideoAdapter from "../../services/direct.js";

const TOO_LONG_REGEX = /maxContentLength/;

describe("outgoing request limits", () => {
	let server: http.Server;
	let base: string;
	let bytesSent = 0;

	beforeAll(async () => {
		// Sends for as long as anyone keeps reading, like a host trying to fill the server's memory.
		server = http.createServer((req, res) => {
			res.writeHead(200);
			const chunk = Buffer.alloc(1024 * 1024, "#");
			const pump = () => {
				while (bytesSent < RESPONSE_MAX_BYTES * 4 && !res.destroyed) {
					bytesSent += chunk.length;
					if (!res.write(chunk)) {
						res.once("drain", pump);
						return;
					}
				}
				res.end();
			};
			pump();
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		server.closeAllConnections();
		server.close();
	});

	it("applies to plain requests and to adapters' own instances", () => {
		expect(axios.defaults.maxContentLength).toEqual(RESPONSE_MAX_BYTES);
		expect(axios.defaults.timeout).toBeGreaterThan(0);
		const instance = axios.create({ baseURL: "http://localhost" });
		expect(instance.defaults.maxContentLength).toEqual(RESPONSE_MAX_BYTES);
		expect(instance.defaults.timeout).toEqual(axios.defaults.timeout);
	});

	it.each([
		["hls", () => new HlsVideoAdapter(), "/playlist.m3u8"],
		["dash", () => new DashVideoAdapter(), "/manifest.mpd"],
	])("stops reading a %s manifest that never ends", async (_name, adapter, path) => {
		bytesSent = 0;
		await expect(adapter().fetchVideoInfo(`${base}${path}`)).rejects.toThrow(TOO_LONG_REGEX);
		expect(bytesSent).toBeLessThan(RESPONSE_MAX_BYTES * 2);
	});

	it("stops reading a media manifest that never ends", async () => {
		bytesSent = 0;
		await expect(
			new DirectVideoAdapter().fetchVideoInfo(`${base}/manifest.json`),
		).rejects.toThrow();
		expect(bytesSent).toBeLessThan(RESPONSE_MAX_BYTES * 2);
	});
});

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { StreamFfprobe } from "../../ffprobe.js";

describe("StreamFfprobe against a hostile file host", () => {
	let server: http.Server;
	let base: string;
	const escaped: unknown[] = [];
	const onEscaped = (err: unknown) => escaped.push(err);

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			if (req.url === "/gzip-goes-bad") {
				// Valid gzip first, so the bytes reach ffprobe, then garbage once ffprobe has gone.
				res.writeHead(200, { "Content-Encoding": "gzip" });
				res.write(zlib.gzipSync(Buffer.alloc(1024, "a")).subarray(0, 512));
				setTimeout(() => {
					res.write(Buffer.alloc(4096, 0xff));
					res.destroy();
				}, 150);
			} else if (req.url === "/reset") {
				res.writeHead(200, { "Content-Type": "video/mp4" });
				res.write(Buffer.alloc(1024));
				setTimeout(() => res.destroy(), 150);
			} else {
				res.writeHead(200, { "Content-Type": "video/mp4" });
				res.end(Buffer.alloc(1024));
			}
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		server.closeAllConnections();
		server.close();
	});

	beforeEach(() => {
		escaped.length = 0;
		process.on("uncaughtException", onEscaped);
		process.on("unhandledRejection", onEscaped);
	});

	afterEach(() => {
		process.off("uncaughtException", onEscaped);
		process.off("unhandledRejection", onEscaped);
	});

	const settle = () => new Promise(resolve => setTimeout(resolve, 400));

	function probeWith(path: string): StreamFfprobe {
		const probe = new StreamFfprobe();
		probe.ffprobePath = path;
		return probe;
	}

	it("rejects when ffprobe can't be started", async () => {
		await expect(
			probeWith("/nonexistent/ffprobe").getFileInfo(`${base}/fine.mp4`),
		).rejects.toThrow();
		await settle();
		expect(escaped).toEqual([]);
	});

	it.each(["/gzip-goes-bad", "/reset", "/fine"])(
		"lets nothing escape when ffprobe is gone before %s finishes",
		async path => {
			// exits at once and prints nothing, like ffprobe on a file it gives up on
			await expect(probeWith("/bin/true").getFileInfo(`${base}${path}`)).rejects.toThrow();
			await settle();
			expect(escaped).toEqual([]);
		},
	);
});

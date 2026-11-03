import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { lastResortErrorHandler, sendRejectionsToErrorHandlers } from "../../express-safety.js";

describe("express safety", () => {
	let app: Express;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);

	beforeEach(() => {
		sendRejectionsToErrorHandlers();
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
		app = express();
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	const settle = () => new Promise(resolve => setTimeout(resolve, 20));

	it("answers a rejected async route with a 500", async () => {
		app.get("/", async () => {
			throw new Error("secret detail");
		});
		app.use(lastResortErrorHandler);
		const resp = await request(app).get("/").expect(500);
		expect(resp.body).toEqual({
			success: false,
			error: { name: "Unknown", message: "An unknown error occurred. Try again later." },
		});
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("answers a rejected async middleware with a 500", async () => {
		app.use(async () => {
			throw new Error("nope");
		});
		app.get("/", (_req, res) => {
			res.send("should not get here");
		});
		app.use(lastResortErrorHandler);
		await request(app).get("/").expect(500);
		await settle();
		expect(unhandled).toEqual([]);
	});

	it.each([[undefined], [null], ["a string"], [5]])(
		"copes with a rejection of %j",
		async thrown => {
			app.get("/", () => Promise.reject(thrown));
			app.use(lastResortErrorHandler);
			await request(app).get("/").expect(500);
			await settle();
			expect(unhandled).toEqual([]);
		},
	);

	it("still handles a route that throws synchronously", async () => {
		app.get("/", () => {
			throw new Error("sync");
		});
		app.use(lastResortErrorHandler);
		await request(app).get("/").expect(500);
	});

	it("reaches a rejected async error handler's successor", async () => {
		app.get("/", async () => {
			throw new Error("first");
		});
		app.use(async (_err, _req, _res, _next) => {
			throw new Error("second");
		});
		app.use(lastResortErrorHandler);
		await request(app).get("/").expect(500);
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("does not answer twice when the route answered and then failed", async () => {
		app.get("/", async (_req, res) => {
			res.status(429).json({ limited: true });
			res.status(500).json({ again: true });
		});
		app.use(lastResortErrorHandler);
		const resp = await request(app).get("/").expect(429);
		expect(resp.body).toEqual({ limited: true });
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("cuts off an answer that started and can't finish", async () => {
		app.get("/", async (_req, res) => {
			res.write("partial");
			throw new Error("mid answer");
		});
		app.use(lastResortErrorHandler);
		await expect(request(app).get("/")).rejects.toThrow();
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("says a client's bad JSON is a 400 rather than a server error", async () => {
		app.use(express.json());
		app.post("/", (_req, res) => {
			res.send("should not get here");
		});
		app.use(lastResortErrorHandler);
		const resp = await request(app)
			.post("/")
			.set("Content-Type", "application/json")
			.send("not json")
			.expect(400);
		expect(resp.body.success).toEqual(false);
		expect(resp.body.error.name).toEqual("SyntaxError");
	});

	it("says a path that will not decode is a 400", async () => {
		app.get("/room/:name", (_req, res) => {
			res.send("should not get here");
		});
		app.use(lastResortErrorHandler);
		const resp = await request(app).get("/room/%E0%A4%A").expect(400);
		expect(resp.body.error.message).toEqual("Bad request.");
	});

	it("does not run a handler with the wrong number of arguments", async () => {
		const seen: string[] = [];
		app.use((_err: unknown, _req: unknown, _res: unknown, _next: unknown) => {
			seen.push("error handler on a good request");
		});
		app.get("/", (_req, res) => {
			res.send("ok");
		});
		await request(app).get("/").expect(200);
		expect(seen).toEqual([]);
	});
});

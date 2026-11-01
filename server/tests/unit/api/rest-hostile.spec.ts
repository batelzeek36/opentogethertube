import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { RateLimiterRes } from "rate-limiter-flexible";
import { main } from "../../../app.js";
import { conf } from "../../../ott-config.js";
import { rateLimiter } from "../../../rate-limit.js";
import { buildClients } from "../../../redisclient.js";
import usermanager from "../../../usermanager.js";
import type { User } from "../../../models/user.js";

interface Route {
	method: string;
	path: string;
}

/** Every route the app really has, so a route added later gets this treatment without anyone asking. */
function listRoutes(stack: any[], prefix = ""): Route[] {
	const routes: Route[] = [];
	for (const layer of stack) {
		if (layer.route) {
			for (const method of Object.keys(layer.route.methods)) {
				routes.push({ method, path: prefix + layer.route.path });
			}
		} else if (layer.name === "router" && layer.handle.stack) {
			const mount = layer.regexp.source
				.replace("^", "")
				.replace("\\/?(?=\\/|$)", "")
				.replaceAll("\\/", "/");
			routes.push(...listRoutes(layer.handle.stack, prefix + mount));
		}
	}
	return routes;
}

const JUNK_BODIES: unknown[] = [
	undefined,
	"null",
	"5",
	'"text"',
	"not json",
	"[]",
	"[null]",
	"{}",
	{ __proto__: null, constructor: {} },
	JSON.parse('{"__proto__":{"polluted":true}}'),
	{ username: {} },
	{ username: 5 },
	{ username: ["a"] },
	{ username: "a".repeat(5000), password: "b" },
	{ username: "nobody with this name" },
	{ email: "doesnot@exi.st" },
	{ email: {} },
	{ user: {}, password: {} },
	{ user: "nobody", password: 5 },
	{ email: {}, username: {}, password: "Aa1aaaaaaaaa" },
	{ email: 5, username: 5, password: ["Aa1aaaaaaaaa"] },
	{ verifyKey: {}, newPassword: {} },
	{ verifyKey: "no such key", newPassword: "Aa1aaaaaaaaa" },
	{ eventId: {} },
	{ eventId: "no such event" },
	{ service: {}, id: {} },
	{ url: {} },
	{ videos: {} },
	{ videos: [{}] },
	{ name: {} },
	{ name: "__proto__", isTemporary: true },
	{ name: "constructor", isTemporary: true },
	{ grants: "x" },
	{ grants: [[99, 99]] },
	{ title: {}, description: 5 },
	{ claim: "yes" },
	{ claim: true },
	{ text: {} },
];

/** Well formed, but naming something that can't be fetched. A 500 for these is fair, a crash is not. */
const UNREACHABLE_VIDEOS: unknown[] = [
	{ service: "direct", id: "not a url" },
	{ service: "direct", id: "http://127.0.0.1:1/video.mp4" },
	{ service: "direct", id: "x", subtitleUrl: "http://127.0.0.1:1/subs.vtt" },
	{ url: "http://127.0.0.1:1/video.mp4" },
	{ url: "not a url" },
	{ videos: [{ service: "direct", id: "http://127.0.0.1:1/video.mp4" }] },
];

const ROOM_NAMES = ["hostile", "no-such-room", "__proto__", "constructor", "%E0%A4%A", "a%00b"];

const QUERIES = ["", "input[a]=b", "input=&adapter[a]=b", "permanent=true", "redirect[a]=b"];

describe("hostile REST requests", () => {
	let app: any;
	let routes: Route[];
	let viewerToken: string;
	let loggedInToken: string;
	const username = `hostile ${Date.now()}`;
	let user: User;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);

	beforeAll(async () => {
		await buildClients();
		app = (await main()).app;
		await new Promise(resolve => setTimeout(resolve, 100));
		process.on("unhandledRejection", onUnhandled);

		routes = listRoutes(app._router.stack);

		viewerToken = (await request(app).get("/api/auth/grant")).body.token;
		loggedInToken = (await request(app).get("/api/auth/grant")).body.token;
		await request(app)
			.post("/api/user/register")
			.set("Authorization", `Bearer ${loggedInToken}`)
			.send({ username, password: "test1234" })
			.expect(201);
		user = await usermanager.getUser({ user: username });
		await request(app)
			.post("/api/room/create")
			.set("Authorization", `Bearer ${viewerToken}`)
			.send({ name: "hostile", isTemporary: true })
			.expect(201);
	});

	afterAll(async () => {
		process.off("unhandledRejection", onUnhandled);
		await user.destroy();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Logging out has to stay out of the pass, or everything after it would run logged out. */
	function targets(): Route[] {
		return routes.filter(
			route => route.path !== "/api/user/logout" && !route.path.includes("/test/"),
		);
	}

	function pathsFor(route: Route): string[] {
		const paths = route.path.includes(":name")
			? ROOM_NAMES.map(name => route.path.replace(":name", name))
			: [route.path.replace("*", "/anything")];
		return paths;
	}

	const AUTH: [string, () => string | undefined][] = [
		["no token", () => undefined],
		["a token nobody was given", () => "made up"],
		["a viewer's token", () => viewerToken],
		["a logged in user's token", () => loggedInToken],
	];

	async function hit(route: Route, path: string, token: string | undefined, body: unknown) {
		let test = (request(app) as any)[route.method](path);
		if (token) {
			test = test.set("Authorization", `Bearer ${token}`);
		}
		if (typeof body === "string") {
			test = test.set("Content-Type", "application/json").send(body);
		} else if (body !== undefined) {
			test = test.send(body);
		}
		const resp = await test.timeout(20_000);
		return resp.status as number;
	}

	it("finds the routes it is supposed to be testing", () => {
		const found = routes.map(route => `${route.method} ${route.path}`);
		expect(found).toEqual(
			expect.arrayContaining([
				"post /api/user/recover/start",
				"post /api/user/recover/verify",
				"post /api/user/login",
				"post /api/user/register",
				"post /api/user/",
				"get /api/user/account",
				"patch /api/user/account",
				"get /api/auth/grant",
				"get /api/data/previewAdd",
				"post /api/room/create",
				"post /api/room/:name/queue",
				"post /api/room/:name/undo",
				"post /api/announce/",
				"get /api/status/metrics",
			]),
		);
		expect(found.length).toBeGreaterThan(30);
	});

	it.each(AUTH)(
		"never loses a request or the process, with %s",
		async (_label, token) => {
			const failures: string[] = [];
			for (const route of targets()) {
				for (const path of pathsFor(route)) {
					for (const query of QUERIES) {
						const status = await hit(
							route,
							query ? `${path}?${query}` : path,
							token(),
							undefined,
						);
						// The fake redis in these tests can't do what the metrics need.
						if (status >= 500 && !path.endsWith("/metrics")) {
							failures.push(`${route.method} ${path}?${query} -> ${status}`);
						}
					}
					if (route.method === "get") {
						continue;
					}
					for (const body of JUNK_BODIES) {
						const status = await hit(route, path, token(), body);
						if (status >= 500) {
							failures.push(
								`${route.method} ${path} ${JSON.stringify(body)?.slice(0, 60)} -> ${status}`,
							);
						}
					}
					for (const body of UNREACHABLE_VIDEOS) {
						await hit(route, path, token(), body);
					}
				}
			}
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(unhandled).toEqual([]);
			expect(failures).toEqual([]);
		},
		300_000,
	);

	it.each(AUTH)(
		"answers once when the rate limit has run out, with %s",
		async (_label, token) => {
			conf.set("rate_limit.enabled", true);
			vi.spyOn(rateLimiter, "consume").mockRejectedValue(
				new RateLimiterRes(0, 60_000, 1001, false),
			);
			for (const route of targets()) {
				for (const path of pathsFor(route)) {
					if (route.method === "get") {
						await hit(route, path, token(), undefined);
						continue;
					}
					for (const body of JUNK_BODIES) {
						await hit(route, path, token(), body);
					}
				}
			}
			conf.set("rate_limit.enabled", false);
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(unhandled).toEqual([]);
		},
		300_000,
	);

	it.each(AUTH)(
		"survives every database and redis read failing at once, with %s",
		async (_label, token) => {
			const tokens = (await import("../../../auth/tokens.js")).default;
			const authToken = token();
			vi.spyOn(tokens, "setSessionInfo").mockRejectedValue(new Error("redis is down"));
			for (const route of targets()) {
				for (const path of pathsFor(route).slice(0, 1)) {
					await hit(route, path, authToken, { username: "another name", password: "x" });
				}
			}
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(unhandled).toEqual([]);
		},
		300_000,
	);

	it("survives logging in and out with redis failing", async () => {
		const tokens = (await import("../../../auth/tokens.js")).default;
		const token = (await request(app).get("/api/auth/grant")).body.token;
		const second = await usermanager.registerUser({
			email: null,
			username: `${username} second`,
			password: "test1234",
		});
		await request(app)
			.post("/api/user/login")
			.set("Authorization", `Bearer ${token}`)
			.send({ user: second.username, password: "test1234" })
			.expect(200);
		vi.spyOn(tokens, "setSessionInfo").mockRejectedValue(new Error("redis is down"));
		await request(app)
			.post("/api/user/logout")
			.set("Authorization", `Bearer ${token}`)
			.expect(500);
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(unhandled).toEqual([]);
		await second.destroy();
	});

	it("is still up afterwards", async () => {
		await request(app).get("/api/status").expect(200);
	});
});

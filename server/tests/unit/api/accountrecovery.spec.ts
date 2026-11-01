import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { RateLimiterRes } from "rate-limiter-flexible";
import { main } from "../../../app.js";
import usermanager from "../../../usermanager.js";
import type { User } from "../../../models/user.js";
import type { MockMailer } from "server/mailer.js";
import { conf } from "../../../ott-config.js";
import { redisClient } from "../../../redisclient.js";
import { rateLimiter } from "../../../rate-limit.js";
import type { OttApiRequestAccountRecoveryVerify } from "ott-common/models/rest-api.js";

describe("Account Recovery", () => {
	let token;
	let app;
	let emailUser: User;
	let noEmailUser: User;

	beforeAll(async () => {
		app = (await main()).app;

		emailUser = await usermanager.registerUser({
			email: "email@localhost.com",
			username: "email user",
			password: "test1234",
		});

		noEmailUser = await usermanager.registerUser({
			email: null,
			username: "no email user",
			password: "test1234",
		});

		const resp = await request(app).get("/api/auth/grant").expect(200);
		token = resp.body.token;

		conf.set("mail.enabled", true);
	});

	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	beforeEach(async () => {});

	afterEach(() => {
		const mailer: MockMailer = usermanager.mailer as MockMailer;
		mailer.clearSent();
	});

	afterAll(async () => {
		await emailUser.destroy();
		await noEmailUser.destroy();
		conf.set("mail.enabled", false);
	});

	it.each([
		["email", "email@localhost.com"],
		["username", "email user"],
	])(
		"should send a recovery email when using %s field in request",
		async (field: string, value: string) => {
			const resp = await request(app)
				.post("/api/user/recover/start")
				.set("Authorization", `Bearer ${token}`)
				.send({ [field]: value });

			expect(resp.body).toMatchObject({
				success: true,
			});

			const mailer: MockMailer = usermanager.mailer as MockMailer;
			expect(mailer.sentEmails).toHaveLength(1);
			expect(mailer.sentEmails[0]).toMatchObject({
				to: "email@localhost.com",
			});
		},
	);

	it("should not send a recovery email when there is no email", async () => {
		const resp = await request(app)
			.post("/api/user/recover/start")
			.set("Authorization", `Bearer ${token}`)
			.send({ username: "no email user" })
			.expect(400);

		expect(resp.body.success).toBe(false);
		expect(resp.body.error).toMatchObject({
			name: "NoEmail",
		});

		const mailer: MockMailer = usermanager.mailer as MockMailer;
		expect(mailer.sentEmails).toHaveLength(0);
	});

	it.each([{}, { email: "doesnot@exi.st" }])(
		"should not send a recovery email when the request is bad: %s",
		async (body: any) => {
			const resp = await request(app)
				.post("/api/user/recover/start")
				.set("Authorization", `Bearer ${token}`)
				.send(body)
				.expect(400);

			expect(resp.body.success).toBe(false);

			const mailer: MockMailer = usermanager.mailer as MockMailer;
			expect(mailer.sentEmails).toHaveLength(0);
		},
	);

	describe("when the rate limit has run out", () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);

		beforeEach(() => {
			unhandled.length = 0;
			process.on("unhandledRejection", onUnhandled);
			conf.set("rate_limit.enabled", true);
			vi.spyOn(rateLimiter, "consume").mockRejectedValue(
				new RateLimiterRes(0, 60_000, 1001, false),
			);
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			conf.set("rate_limit.enabled", false);
			process.off("unhandledRejection", onUnhandled);
		});

		// This is the request that took the server down: answered with a 429, then carried on, found
		// no such user and answered again, and that second answer threw out of an async route.
		it.each([
			[{ username: "nobody with this name" }],
			[{ email: "doesnot@exi.st" }],
			[{ username: "no email user" }],
		])("should answer once with a 429 for %j and stay up", async body => {
			const resp = await request(app)
				.post("/api/user/recover/start")
				.set("Authorization", `Bearer ${token}`)
				.send(body);
			expect(resp.status).toEqual(429);
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
		});

		it("should not send a recovery email", async () => {
			await request(app)
				.post("/api/user/recover/start")
				.set("Authorization", `Bearer ${token}`)
				.send({ email: "email@localhost.com" })
				.expect(429);
			const mailer: MockMailer = usermanager.mailer as MockMailer;
			expect(mailer.sentEmails).toHaveLength(0);
		});

		it("should not try a verify key or change the password", async () => {
			await redisClient.set("accountrecovery:limited", "email@localhost.com");
			const before = await usermanager.getUser({ user: "email@localhost.com" });
			const resp = await request(app)
				.post("/api/user/recover/verify")
				.set("Authorization", `Bearer ${token}`)
				.send({ verifyKey: "limited", newPassword: "test5678" });
			expect(resp.status).toEqual(429);
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(unhandled).toEqual([]);
			const after = await usermanager.getUser({ user: "email@localhost.com" });
			expect(after.hash).toEqual(before.hash);
			expect(await redisClient.get("accountrecovery:limited")).toEqual("email@localhost.com");
			await redisClient.del("accountrecovery:limited");
		});
	});

	it("should change the password when the verify key is valid", async () => {
		await redisClient.set("accountrecovery:foo", "email@localhost.com");

		const body: OttApiRequestAccountRecoveryVerify = {
			verifyKey: "foo",
			newPassword: "test5678",
		};

		const resp = await request(app)
			.post("/api/user/recover/verify")
			.set("Authorization", `Bearer ${token}`)
			.send(body);

		expect(resp.body).toMatchObject({
			success: true,
		});
	});

	it.each([
		{},
		{ verifyKey: "foo" },
		{ newPassword: "test5678" },
		{ verifyKey: "foo", newPassword: "asdf" },
		{ verifyKey: "bar", newPassword: "asdf1234" },
	])("should not change the password when the request is bad: %s", async (body: any) => {
		await redisClient.set("accountrecovery:foo", "email@localhost.com");

		const resp = await request(app)
			.post("/api/user/recover/verify")
			.set("Authorization", `Bearer ${token}`)
			.send(body)
			.expect(400);

		expect(resp.body.success).toBe(false);
	});
});

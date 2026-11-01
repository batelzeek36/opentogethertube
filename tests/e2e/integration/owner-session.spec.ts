import { describe, expect, it } from "../support/fixtures";

const VIDEO = process.env.OTT_VOICE_TEST_VIDEO ?? "https://vjs.zencdn.net/v/oceans.mp4";

it.use({
	permissions: ["microphone"],
	launchOptions: {
		executablePath: process.env.OTT_VOICE_TEST_CHROMIUM || undefined,
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
		],
	},
});

describe("An owner's session", () => {
	it("logs in, runs playback, joins voice and reacts in chat", async ({
		page,
		ott,
		browser,
		request,
	}) => {
		page.on("pageerror", () => {
			// Embedded player scripts can throw after load; these tests assert our UI state.
		});
		const roomState: {
			isPlaying?: boolean;
			playbackPosition?: number;
			currentSource?: { id: string } | null;
		} = {};
		page.on("websocket", socket => {
			socket.on("framereceived", ({ payload }) => {
				if (typeof payload === "string") {
					const msg = JSON.parse(payload);
					if (msg.action === "sync") {
						Object.assign(roomState, msg);
					}
				}
			});
		});

		await page.context().clearCookies();
		await ott.ensureToken();
		await ott.resetRateLimit();
		await ott.request({ method: "POST", url: "/api/dev/reset-rate-limit/user" });

		const username = `owner${Math.random().toString(36).slice(2, 10)}`;
		const password = "correct horse battery staple 9";
		await ott.createUser({ username, password });
		await ott.request({ method: "POST", url: "/api/user/logout" });
		await page.context().clearCookies();
		await ott.ensureToken();

		await page.locator('[data-cy="user-logged-out"]').click();
		await page.locator('[data-cy="login-user"]').fill(username);
		await page.locator('[data-cy="login-password"]').fill(password);
		await page.locator('[data-cy="login-button"]').click();
		await expect(page.locator('[data-cy="user-logged-in"]')).toContainText(username);

		const room = `owner${Math.random().toString(36).slice(2, 10)}`;
		await ott.request({
			method: "POST",
			url: "/api/room/create",
			body: { name: room, isTemporary: false },
		});
		await page.goto(`/room/${room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
		await expect(page.locator('.user[data-role="owner"]')).toContainText(username);

		// Playback controls
		await page.getByRole("button", { name: "Add a video" }).click();
		await page.locator('[data-cy="add-preview-input"]').fill(VIDEO);
		await page.locator(".video button").nth(1).click();
		await expect(page.locator("video")).toBeVisible();
		await expect.poll(() => roomState.currentSource?.id).toBe(VIDEO);

		await page.getByLabel("Play").first().click();
		await expect.poll(() => roomState.isPlaying).toBe(true);
		await page.getByLabel("Pause").first().click();
		await expect.poll(() => roomState.isPlaying).toBe(false);

		await page.locator('[data-cy="timestamp-display"] .editable').click();
		await page.locator('[data-cy="timestamp-display"] .editor').fill("5");
		await page.locator('[data-cy="timestamp-display"] .editor').press("Enter");
		await expect.poll(() => roomState.playbackPosition).toBe(5);

		// A second person, for voice and reactions to reach
		const grant = await request.get("/api/auth/grant");
		const context = await browser.newContext({ permissions: ["microphone"] });
		await context.addInitScript(
			token => {
				window.localStorage.setItem("token", token as string);
			},
			(await grant.json()).token,
		);
		const other = await context.newPage();
		await other.goto(`/room/${room}`);
		await expect(other.locator("#connectStatus")).toHaveText("Connected");

		try {
			// Voice
			await page.locator('[data-cy="voice-join-main"]').click();
			await expect(page.locator('[data-cy="voice-leave"]')).toBeVisible();
			await other.locator('[data-cy="voice-join-main"]').click();
			await expect(other.locator('[data-cy="voice-leave"]')).toBeVisible();
			const talk = page.locator('[data-cy="voice-talk"]').first();
			const box = await talk.boundingBox();
			expect(box).not.toBeNull();
			await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
			await page.mouse.down();
			await expect(talk).toContainText("Talking");
			await expect(other.locator('[data-speaking="true"]')).toHaveCount(1);
			await page.mouse.up();
			await expect(other.locator('[data-speaking="true"]')).toHaveCount(0);

			// Chat reactions
			await page.locator('[data-cy="chat-activate"]').click();
			await page.locator('[data-cy="chat-input"]').fill("hello");
			await page.locator('[data-cy="chat-input"]').press("Enter");
			await expect(other.locator(".message", { hasText: "hello" })).toBeVisible();
			await page.locator('[data-cy="chat-activate"]').click();
			await page.locator(".message", { hasText: "hello" }).click();
			await page.locator('[data-cy="chat-react-😂"]').click();
			const chip = other.locator('[data-cy="chat-reaction"][data-emoji="😂"]');
			await expect(chip).toContainText("1");
		} finally {
			await context.close();
		}
	});
});

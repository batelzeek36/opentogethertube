import { beforeEach, describe, expect, it } from "../support/fixtures";

describe("Room reactions", () => {
	beforeEach(async ({ page, ott }) => {
		await ott.ensureToken();
		await ott.resetRateLimit();
		const response = await ott.request({ method: "POST", url: "/api/room/generate" });
		const body = await response.json();
		await page.goto(`/room/${body.room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
	});

	it("should float a reaction for everyone in the room", async ({ browser, page, request }) => {
		const roomUrl = page.url();
		const tokenResponse = await request.get("/api/auth/grant");
		expect(tokenResponse.ok()).toBe(true);
		const tokenBody = await tokenResponse.json();

		const secondContext = await browser.newContext();
		await secondContext.addInitScript(token => {
			window.localStorage.setItem("token", token as string);
		}, tokenBody.token);
		const secondPage = await secondContext.newPage();

		try {
			await secondPage.goto(roomUrl);
			await expect(secondPage.locator("#connectStatus")).toHaveText("Connected");

			await page.locator('[data-cy="react-🎃"]').click();

			const floating = '[data-cy="floating-reaction"]';
			await expect(page.locator(floating, { hasText: "🎃" })).toBeVisible();
			await expect(secondPage.locator(floating, { hasText: "🎃" })).toBeVisible();
		} finally {
			await secondContext.close();
		}
	});
});

import { beforeEach, describe, expect, it } from "../support/fixtures";

const PHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("Device icons", () => {
	beforeEach(async ({ page, ott }) => {
		await ott.ensureToken();
		await ott.resetRateLimit();
		const response = await ott.request({ method: "POST", url: "/api/room/generate" });
		const body = await response.json();
		await page.goto(`/room/${body.room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
	});

	it("tells someone's phone and computer apart in the Users list", async ({
		browser,
		page,
		request,
	}) => {
		const grant = await (await request.get("/api/auth/grant")).json();
		const context = await browser.newContext({ userAgent: PHONE_UA });
		await context.addInitScript(token => {
			window.localStorage.setItem("token", token as string);
		}, grant.token);
		const phone = await context.newPage();

		try {
			await phone.goto(page.url());
			await expect(phone.locator("#connectStatus")).toHaveText("Connected");
			const list = page.locator(".user-list");
			await expect(list.locator('[data-device="phone"]')).toHaveCount(1);
			await expect(list.locator('[data-device="computer"]')).toHaveCount(1);
			await expect(list.locator('[data-device="phone"]')).toHaveAttribute(
				"aria-label",
				"On a phone",
			);
		} finally {
			await context.close();
		}
	});
});

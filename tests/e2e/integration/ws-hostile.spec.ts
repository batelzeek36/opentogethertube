import type { Page } from "@playwright/test";
import { RoomRequestType } from "../../../common/models/messages";
import { beforeEach, describe, expect, it } from "../support/fixtures";

/** Open a socket that is not the page's own, send these, and give the server a moment with them. */
function sendOnNewSocket(page: Page, room: string, messages: string[]) {
	return page.evaluate(
		async ({ room, messages }) => {
			const url = `${location.origin.replace("http", "ws")}/api/room/${room}`;
			const socket = new WebSocket(url);
			await new Promise(resolve => {
				socket.onopen = resolve;
			});
			for (const message of messages) {
				socket.send(message);
			}
			await new Promise(resolve => setTimeout(resolve, 300));
			socket.close();
		},
		{ room, messages },
	);
}

describe("Hostile websocket messages", () => {
	let room: string;

	beforeEach(async ({ page, ott }) => {
		await ott.ensureToken();
		await ott.resetRateLimit();
		const response = await ott.request({ method: "POST", url: "/api/room/generate" });
		room = (await response.json()).room;
		await page.goto(`/room/${room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
	});

	async function expectServerStillUp(page: Page) {
		await page.waitForTimeout(500);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
		const status = await page.evaluate(async () => (await fetch("/api/status")).status);
		expect(status).toBe(200);
	}

	it("survives a notify sent before auth", async ({ page }) => {
		await sendOnNewSocket(page, room, [
			JSON.stringify({ action: "notify", message: "usernameChanged" }),
		]);
		await expectServerStillUp(page);
	});

	it("survives messages that are not objects", async ({ page }) => {
		await sendOnNewSocket(page, room, ["null", "5", '"text"', "[]", "not json"]);
		await expectServerStillUp(page);
	});

	it("survives a remove event undone at an index past the queue", async ({ page }) => {
		const token = await page.evaluate(() => window.localStorage.getItem("token"));
		await sendOnNewSocket(page, room, [
			JSON.stringify({ action: "auth", token }),
			JSON.stringify({
				action: "req",
				request: {
					type: RoomRequestType.UndoRequest,
					event: {
						request: { type: RoomRequestType.RemoveRequest },
						additional: { video: { service: "direct", id: "x" }, queueIdx: 99 },
					},
				},
			}),
		]);
		await expectServerStillUp(page);
	});

	it("takes only the first auth on a socket", async ({ page }) => {
		const token = await page.evaluate(() => window.localStorage.getItem("token"));
		const auth = JSON.stringify({ action: "auth", token });
		await sendOnNewSocket(page, room, [auth, auth, auth]);
		await expectServerStillUp(page);
		// The page itself plus nobody: that socket has closed and took all of itself with it.
		await expect.poll(async () => await page.locator(".user").count()).toBe(1);
	});

	it("does not show a made up player status to the room", async ({ page }) => {
		const status = "<b>dancing</b>";
		const token = await page.evaluate(() => window.localStorage.getItem("token"));
		const frames: string[] = [];
		page.on("websocket", socket => {
			socket.on("framereceived", ({ payload }) => {
				if (typeof payload === "string") {
					frames.push(payload);
				}
			});
		});
		await page.reload();
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
		await sendOnNewSocket(page, room, [
			JSON.stringify({ action: "auth", token }),
			JSON.stringify({ action: "status", status }),
		]);
		expect(frames.filter(frame => frame.includes("dancing"))).toEqual([]);
	});
});

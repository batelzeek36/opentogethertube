import type { Browser, Page } from "@playwright/test";
import { beforeEach, describe, expect, it } from "../support/fixtures";

/** RoomRequestType.ChatReactionRequest. This suite runs without the workspace's build. */
const CHAT_REACTION_REQUEST = 26;

/** Keeps the page's socket reachable, to send what the page itself never would. */
function keepSocket() {
	const Real = window.WebSocket;
	window.WebSocket = class extends Real {
		constructor(url: string | URL) {
			super(url);
			(window as unknown as { __socket: WebSocket }).__socket = this;
		}
	} as typeof WebSocket;
}

function sendRaw(page: Page, request: object) {
	return page.evaluate(body => {
		(window as unknown as { __socket: WebSocket }).__socket.send(
			JSON.stringify({ action: "req", request: body }),
		);
	}, request);
}

/** Every text frame the page receives, so a test can read a message's id. */
function watchFrames(page: Page) {
	const frames: { action?: string; id?: string }[] = [];
	page.on("websocket", socket => {
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string") {
				frames.push(JSON.parse(payload));
			}
		});
	});
	return frames;
}

async function idOfChatIn(frames: { action?: string; id?: string }[]) {
	await expect.poll(() => frames.find(frame => frame.action === "chat")?.id).toBeTruthy();
	return frames.find(frame => frame.action === "chat")?.id;
}

/** A second person in the room, in a browser of their own. */
async function secondPerson(browser: Browser, roomUrl: string, token: string) {
	const context = await browser.newContext();
	await context.addInitScript(t => {
		window.localStorage.setItem("token", t as string);
	}, token);
	const page = await context.newPage();
	const frames = watchFrames(page);
	await page.goto(roomUrl);
	await expect(page.locator("#connectStatus")).toHaveText("Connected");
	return { context, page, frames };
}

async function sendChat(page: Page, text: string) {
	await page.locator('[data-cy="chat-activate"]').click();
	await page.locator('[data-cy="chat-input"]').fill(text);
	await page.locator('[data-cy="chat-input"]').press("Enter");
}

const chip = (page: Page, emoji: string) =>
	page.locator(`[data-cy="chat-reaction"][data-emoji="${emoji}"]`);

describe("Reactions on chat messages", () => {
	let roomUrl: string;

	beforeEach(async ({ page, ott }) => {
		await ott.ensureToken();
		await ott.resetRateLimit();
		const response = await ott.request({ method: "POST", url: "/api/room/generate" });
		const body = await response.json();
		await page.addInitScript(keepSocket);
		await page.goto(`/room/${body.room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
		roomUrl = page.url();
	});

	it("reaches everyone, counts per person, and comes off again", async ({
		browser,
		page,
		request,
	}) => {
		const grant = await (await request.get("/api/auth/grant")).json();
		const { context, page: other } = await secondPerson(browser, roomUrl, grant.token);

		try {
			await sendChat(page, "hello");
			await expect(other.locator(".message", { hasText: "hello" })).toBeVisible();
			await expect(other.locator('[data-cy="chat-unread"]')).toHaveText("1");

			await page.locator('[data-cy="chat-activate"]').click();
			await page.locator(".message", { hasText: "hello" }).click();
			await page.locator('[data-cy="chat-react-😂"]').click();
			await expect(chip(page, "😂")).toContainText("1");
			await expect(chip(other, "😂")).toContainText("1");

			// With the chat closed it floats over the video: counted nowhere, pressable nowhere.
			await expect(other.locator('[data-cy="chat-unread"]')).toHaveText("1");
			expect(await chip(other, "😂").evaluate(el => el.tagName)).toBe("SPAN");

			await other.locator('[data-cy="chat-activate"]').click();
			await chip(other, "😂").click();
			await expect(chip(page, "😂")).toContainText("2");
			await expect(chip(other, "😂")).toHaveAttribute("aria-pressed", "true");

			await chip(page, "😂").click();
			await expect(chip(other, "😂")).toContainText("1");
			await expect(chip(page, "😂")).toHaveAttribute("aria-pressed", "false");
			await chip(other, "😂").click();
			await expect(chip(page, "😂")).toHaveCount(0);
			await expect(chip(other, "😂")).toHaveCount(0);
		} finally {
			await context.close();
		}
	});

	it("does not stack up across a reload", async ({ browser, page, request }) => {
		const grant = await (await request.get("/api/auth/grant")).json();
		const { context, page: other, frames } = await secondPerson(browser, roomUrl, grant.token);

		try {
			await sendChat(other, "hello");
			await page.locator(".message", { hasText: "hello" }).waitFor();
			const messageId = await idOfChatIn(frames);
			const react = {
				type: CHAT_REACTION_REQUEST,
				messageId,
				emoji: "🔥",
				add: true,
			};

			await sendRaw(page, react);
			await expect(chip(other, "🔥")).toContainText("1");

			await page.reload();
			await expect(page.locator("#connectStatus")).toHaveText("Connected");
			await sendRaw(page, react);
			await sendRaw(page, { ...react, emoji: "❤️" });
			await expect(chip(other, "❤️")).toContainText("1");
			await expect(chip(other, "🔥")).toContainText("1");
		} finally {
			await context.close();
		}
	});

	it("refuses bad requests", async ({ browser, page, request }) => {
		const grant = await (await request.get("/api/auth/grant")).json();
		const { context, page: other, frames } = await secondPerson(browser, roomUrl, grant.token);

		try {
			await sendChat(other, "hello");
			await page.locator(".message", { hasText: "hello" }).waitFor();
			const messageId = await idOfChatIn(frames);
			const type = CHAT_REACTION_REQUEST;

			await sendRaw(page, { type, messageId, emoji: "<img src=x>", add: true });
			await sendRaw(page, { type, messageId: "not-a-message", emoji: "🔥", add: true });
			await sendRaw(page, { type, messageId: 7, emoji: "🔥", add: true });
			await sendRaw(page, { type, messageId, emoji: "🔥", add: "yes" });
			// Sent last, so once this shows, the bad ones above have all been handled.
			await sendRaw(page, { type, messageId, emoji: "❤️", add: true });
			await expect(chip(other, "❤️")).toContainText("1");
			await expect(other.locator('[data-cy="chat-reaction"]')).toHaveCount(1);
		} finally {
			await context.close();
		}
	});
});

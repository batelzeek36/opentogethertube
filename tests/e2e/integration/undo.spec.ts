import type { Browser, Page } from "@playwright/test";
import { RoomRequestType } from "../../../common/models/messages";
import { beforeEach, describe, expect, it } from "../support/fixtures";

const [MOVIE, NEXT] = process.env.OTT_UNDO_TEST_VIDEOS?.split(",") ?? [
	"https://vjs.zencdn.net/v/oceans.mp4",
	"https://vjs.zencdn.net/v/oceans.webm",
];
const INJECTED = `${MOVIE}?injected.mp4`;
const CHAT_ONLY = 1 << 7;

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

function api(page: Page, method: string, url: string, body?: unknown) {
	return page.evaluate(
		async ({ method, url, body }) => {
			const response = await fetch(url, {
				method,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${window.localStorage.getItem("token")}`,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: response.status, body: await response.json() };
		},
		{ method, url, body },
	);
}

/** What the server has told this page about the room, kept up to date. */
function watchRoom(page: Page) {
	const room: {
		currentSource?: { id: string } | null;
		playbackPosition?: number;
		queue?: { id: string }[];
	} = {};
	page.on("websocket", socket => {
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string") {
				const msg = JSON.parse(payload);
				if (msg.action === "sync") {
					Object.assign(room, msg);
				}
			}
		});
	});
	return room;
}

/** Every room event the page receives, so a test can read the id of one. */
function watchEvents(page: Page) {
	const events: { id?: string; request: { type: number } }[] = [];
	page.on("websocket", socket => {
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload === "string") {
				const msg = JSON.parse(payload);
				if (msg.action === "event") {
					events.push(msg);
				}
			}
		});
	});
	return events;
}

async function viewerWithFreshToken(browser: Browser, room: string, token: string) {
	const context = await browser.newContext();
	await context.addInitScript(t => {
		window.localStorage.setItem("token", t as string);
	}, token);
	await context.addInitScript(keepSocket);
	const page = await context.newPage();
	const events = watchEvents(page);
	await page.goto(`/room/${room}`);
	await expect(page.locator("#connectStatus")).toHaveText("Connected");
	return { context, page, events };
}

const undoButton = (page: Page, toastText: string) =>
	page.locator(".toast", { hasText: toastText }).getByRole("button", { name: "Undo" });

describe("Undoing a room event", () => {
	let room: string;
	let ownerEvents: ReturnType<typeof watchEvents>;

	let roomState: ReturnType<typeof watchRoom>;

	const current = () => roomState.currentSource?.id;
	const queue = () => roomState.queue?.map(video => video.id);
	const position = () => roomState.playbackPosition;

	beforeEach(async ({ page, ott }) => {
		page.on("pageerror", () => {
			// Embedded player scripts can throw after load; these tests assert our UI state.
		});
		await ott.ensureToken();
		await ott.resetRateLimit();
		await ott.request({ method: "POST", url: "/api/dev/reset-rate-limit/user" });
		await ott.createUser({
			username: `owner${Math.random().toString(36).slice(2, 10)}`,
			password: "correct horse battery staple 9",
		});
		room = `undo${Math.random().toString(36).slice(2, 10)}`;
		await ott.request({
			method: "POST",
			url: "/api/room/create",
			body: { name: room, isTemporary: false },
		});
		ownerEvents = watchEvents(page);
		roomState = watchRoom(page);
		await page.addInitScript(keepSocket);
		await page.goto(`/room/${room}`);
		await expect(page.locator("#connectStatus")).toHaveText("Connected");
		for (const url of [MOVIE, NEXT]) {
			await ott.request({
				method: "POST",
				url: `/api/room/${room}/queue`,
				body: { service: "direct", id: url },
			});
		}
		await expect.poll(current).toBe(MOVIE);
		await expect.poll(queue).toEqual([NEXT]);
	});

	it("takes a skip back from the toast's button", async ({ page }) => {
		await page.getByLabel("Next video").click();
		await expect.poll(current).toBe(NEXT);

		await undoButton(page, "skipped").click();

		await expect.poll(current).toBe(MOVIE);
		await expect.poll(queue).toEqual([NEXT]);
		await expect(page.locator(".toast", { hasText: "skipped" })).toHaveCount(0);
	});

	it("takes seeks back from the toast's button, to before the first", async ({ page }) => {
		const seekTo = async (seconds: string) => {
			await page.locator('[data-cy="timestamp-display"] .editable').click();
			await page.locator('[data-cy="timestamp-display"] .editor').fill(seconds);
			await page.locator('[data-cy="timestamp-display"] .editor').press("Enter");
			await expect.poll(position).toBe(Number(seconds));
		};
		await seekTo("10");
		await seekTo("20");
		await expect(page.locator(".toast", { hasText: "seeked" })).toHaveCount(1);

		await undoButton(page, "seeked").click();

		await expect.poll(position).toBe(0);
	});

	it("takes a remove back from the toast's button", async ({ page, ott }) => {
		await ott.request({
			method: "DELETE",
			url: `/api/room/${room}/queue`,
			body: { service: "direct", id: NEXT },
		});
		await expect.poll(queue).toEqual([]);

		await undoButton(page, "removed").click();

		await expect.poll(queue).toEqual([NEXT]);
	});

	it("refuses a chat-only viewer over the socket and over REST", async ({
		browser,
		page,
		request,
	}) => {
		const patched = await api(page, "PATCH", `/api/room/${room}`, {
			grants: [
				[0, CHAT_ONLY],
				[1, CHAT_ONLY],
			],
		});
		expect(patched.status).toBe(200);

		const grant = await (await request.get("/api/auth/grant")).json();
		const viewer = await viewerWithFreshToken(browser, room, grant.token);
		try {
			await page.getByLabel("Next video").click();
			await expect.poll(current).toBe(NEXT);
			await expect(viewer.page.locator(".toast", { hasText: "skipped" })).toBeVisible();
			await expect(undoButton(page, "skipped")).toBeVisible();
			await expect(undoButton(viewer.page, "skipped")).toHaveCount(0);

			const forged = {
				action: "event",
				request: { type: RoomRequestType.SkipRequest },
				additional: { video: { service: "direct", id: INJECTED }, prevPosition: 1234 },
			};
			const realId = ownerEvents.find(
				e => e.request.type === RoomRequestType.SkipRequest,
			)?.id;
			expect(realId).toBeTruthy();

			await sendRaw(viewer.page, { type: RoomRequestType.UndoRequest, event: forged });
			await sendRaw(viewer.page, { type: RoomRequestType.UndoRequest, eventId: realId });
			const forgedOverRest = await api(viewer.page, "POST", `/api/room/${room}/undo`, {
				data: { event: forged },
			});
			const realOverRest = await api(viewer.page, "POST", `/api/room/${room}/undo`, {
				eventId: realId,
			});

			expect(forgedOverRest.status).toBe(400);
			expect(realOverRest.status).toBe(400);
			expect(realOverRest.body.error.name).toBe("PermissionDeniedException");
			// Long enough for the socket's two to have done their damage.
			await page.waitForTimeout(500);
			expect(current()).toBe(NEXT);
			expect(queue()).toEqual([]);

			// None of that used the undo up for someone who may press it.
			await undoButton(page, "skipped").click();
			await expect.poll(current).toBe(MOVIE);
		} finally {
			await viewer.context.close();
		}
	});
});

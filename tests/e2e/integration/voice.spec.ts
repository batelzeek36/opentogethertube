import type { Browser, BrowserContext, Page } from "@playwright/test";
import { RoomRequestType } from "../../../common/models/messages";
import { describe, expect, it } from "../support/fixtures";

/*
 * Real browsers, real sockets, a fake microphone that beeps once a second. The probes below sit
 * outside the app: they watch the websocket and the audio output the way a person's device would.
 */

const VIDEO_URL = process.env.OTT_VOICE_TEST_VIDEO ?? "https://vjs.zencdn.net/v/oceans.mp4";

it.use({
	permissions: ["microphone"],
	launchOptions: {
		executablePath: process.env.OTT_VOICE_TEST_CHROMIUM || undefined,
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
		],
	},
});

function installProbes() {
	const probe = {
		framesIn: 0,
		framesOut: 0,
		messages: [] as { at: number; msg: any }[],
		socket: null as WebSocket | null,
		outputs: [] as AnalyserNode[],
		micStreams: [] as MediaStream[],
		micRequests: [] as { startedAt: number; doneAt: number }[],
		micOnsets: [] as number[],
		outOnsets: [] as number[],
		peakOut: 0,
	};
	(window as any).__probe = probe;

	const RealWebSocket = window.WebSocket;
	const realSend = RealWebSocket.prototype.send;
	RealWebSocket.prototype.send = function (data: any) {
		probe.socket = this;
		if (typeof data !== "string") {
			probe.framesOut++;
		}
		return realSend.call(this, data);
	};
	window.WebSocket = new Proxy(RealWebSocket, {
		construct(target, args) {
			const socket = new target(...(args as [string]));
			socket.addEventListener("message", e => {
				if (typeof e.data === "string") {
					const msg = JSON.parse(e.data);
					if (msg.action === "voice" || msg.action === "voice-you") {
						probe.messages.push({ at: Date.now(), msg });
					}
				} else {
					probe.framesIn++;
				}
			});
			return socket;
		},
	});

	function rmsOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
		analyser.getFloatTimeDomainData(buffer);
		let sum = 0;
		for (const v of buffer) {
			sum += v * v;
		}
		return Math.sqrt(sum / buffer.length);
	}

	/** Note when a signal rises out of silence, for measuring how long a beep takes to arrive. */
	function watchOnsets(
		analyser: AnalyserNode,
		onsets: "micOnsets" | "outOnsets",
		onLevel?: (rms: number) => void,
	) {
		const buffer = new Float32Array(analyser.fftSize);
		let quietSince = performance.now();
		let loud = false;
		setInterval(() => {
			const rms = rmsOf(analyser, buffer);
			onLevel?.(rms);
			const now = performance.now();
			if (rms > 0.003) {
				if (!loud && now - quietSince > 250) {
					probe[onsets].push(performance.timeOrigin + now);
				}
				loud = true;
				quietSince = now;
			} else {
				loud = false;
			}
		}, 2);
	}

	const realConnect = AudioNode.prototype.connect as any;
	AudioNode.prototype.connect = function (destination: any, ...rest: any[]) {
		if (destination instanceof AudioDestinationNode) {
			const analyser = this.context.createAnalyser();
			analyser.fftSize = 256;
			realConnect.call(this, analyser);
			probe.outputs.push(analyser);
			watchOnsets(analyser, "outOnsets", rms => {
				probe.peakOut = Math.max(probe.peakOut, rms);
			});
		}
		return realConnect.call(this, destination, ...rest);
	} as any;

	const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
	navigator.mediaDevices.getUserMedia = async constraints => {
		const startedAt = performance.now();
		const stream = await realGetUserMedia(constraints);
		probe.micRequests.push({ startedAt, doneAt: performance.now() });
		probe.micStreams.push(stream);
		// Hear the mic itself on a separate clone, so the app's muting does not hide the beeps.
		const context = new AudioContext();
		const analyser = context.createAnalyser();
		analyser.fftSize = 256;
		context.createMediaStreamSource(stream.clone()).connect(analyser);
		watchOnsets(analyser, "micOnsets");
		return stream;
	};
}

const probeOf = (page: Page) =>
	page.evaluate(() => {
		const p = (window as any).__probe;
		return {
			framesIn: p.framesIn,
			framesOut: p.framesOut,
			peakOut: p.peakOut,
			messages: p.messages,
			micRequests: p.micRequests,
			outOnsets: p.outOnsets,
			micOnsets: p.micOnsets,
			tracks: p.micStreams.flatMap((s: MediaStream) =>
				s.getAudioTracks().map(t => ({ enabled: t.enabled, state: t.readyState })),
			),
		};
	});

const resetProbe = (page: Page) =>
	page.evaluate(() => {
		const p = (window as any).__probe;
		p.framesIn = 0;
		p.framesOut = 0;
		p.peakOut = 0;
		p.messages = [];
		p.outOnsets = [];
		p.micOnsets = [];
	});

const sendReq = (page: Page, request: unknown) =>
	page.evaluate(req => {
		(window as any).__probe.socket.send(JSON.stringify({ action: "req", request: req }));
	}, request);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const REQ = {
	ApplySettings: RoomRequestType.ApplySettingsRequest,
	Join: RoomRequestType.VoiceJoinRequest,
	Talk: RoomRequestType.VoiceTalkRequest,
	Remove: RoomRequestType.VoiceRemoveRequest,
};

async function newUser(
	browser: Browser,
	init?: () => void,
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({ permissions: ["microphone"] });
	await ctx.addInitScript(installProbes);
	if (init) {
		await ctx.addInitScript(init);
	}
	const page = await ctx.newPage();
	return { ctx, page };
}

async function openRoom(page: Page, room: string) {
	await page.goto(`/room/${room}`);
	await expect(page.locator("#connectStatus")).toHaveText("Connected");
	await expect(page.locator('[data-cy="voice-join-main"]')).toBeVisible();
}

async function apiAs(page: Page, method: string, url: string, body?: unknown) {
	return page.evaluate(
		async ({ method, url, body }) => {
			const res = await fetch(url, {
				method,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${window.localStorage.getItem("token")}`,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: res.status, body: await res.json().catch(() => null) };
		},
		{ method, url, body },
	);
}

async function createRoom(page: Page): Promise<string> {
	await page.goto("/");
	await page.waitForFunction(() => !!window.localStorage.getItem("token"));
	const name = `voice${Math.random().toString(36).slice(2, 10)}`;
	const res = await apiAs(page, "POST", "/api/room/create", {
		name,
		isTemporary: false,
		visibility: "unlisted",
	});
	expect(res.status).toBe(201);
	return name;
}

/** Register and claim the room through the same buttons a person would press. */
async function registerAndClaim(page: Page) {
	const username = `owner${Math.random().toString(36).slice(2, 10)}`;
	await page.locator('[data-cy="user-logged-out"]').click();
	await page.getByRole("tab", { name: "Register" }).click();
	await page.locator("#reg-username").fill(username);
	await page.locator("#reg-password").fill("correct horse battery staple 9");
	await page.locator("#reg-password2").fill("correct horse battery staple 9");
	await page.locator('[data-cy="register-button"]').click();
	await expect(page.locator('[data-cy="user-logged-in"]')).toBeVisible();
	await page.keyboard.press("Escape");
	await page.getByRole("tab").nth(2).click();
	await page.locator('[data-cy="claim"]').click();
	await expect(page.locator('[data-cy="claim"]')).toHaveCount(0);
	await expect(page.locator('[data-cy="input-voice-max-talk"]')).toBeEnabled();
	return username;
}

async function join(page: Page, channel: "main" | "side" = "main") {
	await page.locator(`[data-cy="voice-join-${channel}"]`).click();
	await expect(talkButton(page)).toBeVisible();
	await expect(page.locator('[data-cy="voice-leave"]')).toBeVisible();
}

const talkButton = (page: Page) => page.locator('[data-cy="voice-talk"]').first();

async function holdTalk(page: Page) {
	const box = await talkButton(page).boundingBox();
	if (!box) {
		throw new Error("talk button has no box");
	}
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await expect(talkButton(page)).toContainText("Talking");
}

const setRules = (owner: Page, room: string, rules: Record<string, unknown>) =>
	apiAs(owner, "PATCH", `/api/room/${room}`, rules);

const speakerIn = async (page: Page, channel = "main") =>
	page.locator(`[data-cy="voice-channel-${channel}"] [data-speaking="true"]`).allInnerTexts();

describe("Voice channels", () => {
	it("delivers real audio to members only", async ({ browser }) => {
		it.setTimeout(90_000);
		const a = await newUser(browser);
		const b = await newUser(browser);
		const c = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await openRoom(c.page, room);

		await join(a.page);
		await join(b.page);
		await expect(c.page.locator('[data-cy="voice-channel-main"]')).toContainText(",");
		await sleep(500);
		for (const u of [a, b, c]) {
			await resetProbe(u.page);
		}

		await holdTalk(a.page);
		await expect(b.page.locator('[data-speaking="true"]')).toHaveCount(1);
		await expect(c.page.locator('[data-speaking="true"]')).toHaveCount(1);
		await sleep(4000);
		await a.page.mouse.up();
		await sleep(600);

		const pa = await probeOf(a.page);
		const pb = await probeOf(b.page);
		const pc = await probeOf(c.page);
		console.log(
			`[member-only] A sent ${pa.framesOut} frames. B received ${pb.framesIn}, peak output RMS ${pb.peakOut.toFixed(4)}. C received ${pc.framesIn}, peak output RMS ${pc.peakOut.toFixed(4)}.`,
		);
		expect(pa.framesOut).toBeGreaterThan(150);
		expect(pb.framesIn).toBe(pa.framesOut);
		expect(pb.peakOut).toBeGreaterThan(0.003);
		expect(pc.framesIn).toBe(0);
		expect(pc.peakOut).toBe(0);
		expect(pa.framesIn).toBe(0); // nobody hears themselves back

		// C joins a different channel: still nothing.
		await join(c.page, "side");
		await resetProbe(c.page);
		await resetProbe(b.page);
		await holdTalk(a.page);
		await sleep(1000);
		await a.page.mouse.up();
		await sleep(200);
		expect((await probeOf(c.page)).framesIn).toBe(0);
		expect((await probeOf(b.page)).framesIn).toBeGreaterThan(30);

		// Leaving stops delivery.
		await b.page.locator('[data-cy="voice-leave"]').click();
		await sleep(300);
		await resetProbe(b.page);
		await holdTalk(a.page);
		await sleep(500);
		await a.page.mouse.up();
		expect((await probeOf(b.page)).framesIn).toBe(0);
		await Promise.all([a.ctx.close(), b.ctx.close(), c.ctx.close()]);
	});

	it("gives simultaneous presses to exactly one speaker", async ({ browser }) => {
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await join(a.page);
		await join(b.page);

		const results: string[] = [];
		for (let i = 0; i < 10; i++) {
			await resetProbe(a.page);
			await resetProbe(b.page);
			// Both sockets send as close together as the two pages allow.
			const at = Date.now() + 100;
			const fire = (page: Page) =>
				page.evaluate(
					({ at, type }) => {
						const socket = (window as any).__probe.socket;
						return new Promise<void>(resolve => {
							setTimeout(() => {
								socket.send(
									JSON.stringify({
										action: "req",
										request: { type, talking: true },
									}),
								);
								resolve();
							}, at - Date.now());
						});
					},
					{ at, type: REQ.Talk },
				);
			await Promise.all([fire(a.page), fire(b.page)]);
			await sleep(150);
			const pa = await probeOf(a.page);
			const pb = await probeOf(b.page);
			const events = (p: typeof pa) =>
				p.messages.map((m: any) => m.msg.event).filter(Boolean);
			const aGranted = events(pa).includes("talk-granted");
			const bGranted = events(pb).includes("talk-granted");
			const aRefused = events(pa).includes("talk-refused");
			const bRefused = events(pb).includes("talk-refused");
			expect(aGranted !== bGranted).toBe(true);
			expect(aRefused).toBe(bGranted);
			expect(bRefused).toBe(aGranted);
			results.push(aGranted ? "A" : "B");
			const winner = aGranted ? a.page : b.page;
			await sendReq(winner, { type: REQ.Talk, talking: false });
			await sleep(50);
		}
		console.log(
			`[floor] winners of 10 simultaneous presses: ${results.join("")}, one each time`,
		);

		// And the button for the other one is disabled while the first talks.
		await holdTalk(a.page);
		await expect(talkButton(b.page)).toBeDisabled();
		await expect(talkButton(b.page)).toContainText("is talking");
		await a.page.mouse.up();
		await expect(talkButton(b.page)).toBeEnabled();
		await Promise.all([a.ctx.close(), b.ctx.close()]);
	});

	it("enforces the owner's limit, slow mode and on/off on the server", async ({ browser }) => {
		it.setTimeout(120_000);
		const owner = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(owner.page);
		await openRoom(owner.page, room);
		await openRoom(b.page, room);
		const username = await registerAndClaim(owner.page);
		console.log(`[claim] registered ${username} with no email and claimed the room`);

		// Limit: a held button is cut off at the configured time.
		expect((await setRules(owner.page, room, { voiceMaxTalkSeconds: 3 })).status).toBe(200);
		await join(owner.page);
		await join(b.page);
		await expect
			.poll(() => b.page.evaluate(() => (window as any).__probe !== undefined))
			.toBe(true);
		await resetProbe(owner.page);
		await holdTalk(owner.page);
		await expect(owner.page.locator('[data-notice="cut-off"]')).toBeVisible({ timeout: 5000 });
		const held = await probeOf(owner.page);
		const granted = held.messages.find((m: any) => m.msg.event === "talk-granted");
		const ended = held.messages.find((m: any) => m.msg.event === "talk-ended");
		const heldMs = ended.at - granted.at;
		console.log(`[limit] set 3 s, button still held, cut off after ${heldMs} ms`);
		expect(ended.msg.reason).toBe("limit");
		expect(heldMs).toBeGreaterThan(2900);
		expect(heldMs).toBeLessThan(3200);
		// The finger is still down, but no frames flow and nothing is talking.
		await resetProbe(b.page);
		await sleep(500);
		expect((await probeOf(b.page)).framesIn).toBe(0);
		expect(await speakerIn(b.page)).toEqual([]);
		await owner.page.mouse.up();
		await expect(talkButton(owner.page)).toBeEnabled();

		// Slow mode: refused early, allowed after.
		expect((await setRules(owner.page, room, { voiceSlowModeSeconds: 4 })).status).toBe(200);
		await expect.poll(() => b.page.evaluate(() => true)).toBe(true);
		await sleep(200);
		await holdTalk(b.page);
		await b.page.mouse.up();
		await expect(talkButton(b.page)).toContainText("Wait");
		await expect(talkButton(b.page)).toBeDisabled();
		await resetProbe(b.page);
		await sendReq(b.page, { type: REQ.Talk, talking: true });
		await sleep(200);
		const early = (await probeOf(b.page)).messages.map((m: any) => m.msg);
		const refusal = early.find((m: any) => m.event === "talk-refused");
		console.log(`[slow mode] retry refused with ${refusal?.cooldownMs} ms left`);
		expect(refusal.reason).toBe("cooldown");
		expect(refusal.cooldownMs).toBeGreaterThan(2000);
		await expect(talkButton(b.page)).toContainText("Hold to talk", { timeout: 6000 });
		await holdTalk(b.page);
		await b.page.mouse.up();

		// The rules were saved, including the off and zero values.
		const saved = await setRules(owner.page, room, {
			voiceSlowModeSeconds: 0,
			voiceMaxTalkSeconds: 7,
		});
		expect(saved.status).toBe(200);
		const got = await apiAs(owner.page, "GET", `/api/room/${room}`);
		expect(got.body).toMatchObject({
			voiceEnabled: true,
			voiceMaxTalkSeconds: 7,
			voiceSlowModeSeconds: 0,
		});

		// Someone without the permission is refused, by REST and by raw socket, in every field.
		for (const rules of [
			{ voiceMaxTalkSeconds: 99 },
			{ voiceSlowModeSeconds: 99 },
			{ voiceEnabled: false },
		]) {
			const refused = await setRules(b.page, room, rules);
			console.log(`[non-mod] PATCH ${JSON.stringify(rules)} -> ${refused.status}`);
			expect(refused.status).toBeGreaterThanOrEqual(400);
			await sendReq(b.page, { type: REQ.ApplySettings, settings: rules });
		}
		await sleep(300);
		const still = await apiAs(owner.page, "GET", `/api/room/${room}`);
		expect(still.body).toMatchObject({
			voiceEnabled: true,
			voiceMaxTalkSeconds: 7,
			voiceSlowModeSeconds: 0,
		});

		// Out of bounds from the owner: refused by REST and by raw socket.
		expect((await setRules(owner.page, room, { voiceMaxTalkSeconds: 1000 })).status).toBe(400);
		await sendReq(owner.page, {
			type: REQ.ApplySettings,
			settings: { voiceMaxTalkSeconds: 1000 },
		});
		await sleep(300);
		expect((await apiAs(owner.page, "GET", `/api/room/${room}`)).body.voiceMaxTalkSeconds).toBe(
			7,
		);
		await expect(owner.page.locator("#connectStatus")).toHaveText("Connected");

		// The settings form is locked for B and live for the owner.
		await b.page.getByRole("tab").nth(2).click();
		await expect(b.page.locator('[data-cy="input-voice-max-talk"]')).toBeDisabled();
		await expect(b.page.locator('[data-cy="voice-settings-locked"]')).toBeVisible();
		const field = owner.page.locator('[data-cy="input-voice-slow-mode"]');
		await owner.page.locator('[data-cy="input-voice-max-talk"]').fill("500");
		await owner.page.locator('[data-cy="input-voice-max-talk"]').blur();
		await expect(owner.page.locator('[data-cy="input-voice-max-talk"]')).toHaveValue("120");
		await field.fill("2");
		await field.blur();
		await expect
			.poll(
				async () =>
					(await apiAs(owner.page, "GET", `/api/room/${room}`)).body.voiceSlowModeSeconds,
				{
					timeout: 5000,
				},
			)
			.toBe(2);
		await setRules(owner.page, room, { voiceSlowModeSeconds: 0, voiceMaxTalkSeconds: 10 });

		// Turning voice off empties the channels and closes the way in, and is refused by the server.
		await holdTalk(b.page);
		await setRules(owner.page, room, { voiceEnabled: false });
		await expect(b.page.locator('[data-notice="off"]')).toBeVisible();
		await expect(b.page.locator('[data-cy="voice-talk"]')).toHaveCount(0);
		await b.page.mouse.up();
		await resetProbe(b.page);
		await sendReq(b.page, { type: REQ.Join, channel: "main" });
		await sleep(200);
		expect((await probeOf(b.page)).messages.map((m: any) => m.msg.reason)).toContain(
			"voice-off",
		);
		await setRules(owner.page, room, { voiceEnabled: true });
		await expect(b.page.locator('[data-cy="voice-join-main"]')).toBeVisible();

		await Promise.all([owner.ctx.close(), b.ctx.close()]);
	});

	it("lets the owner remove someone and keeps them out until allowed back", async ({
		browser,
	}) => {
		it.setTimeout(90_000);
		const owner = await newUser(browser);
		const b = await newUser(browser);
		const c = await newUser(browser);
		const room = await createRoom(owner.page);
		await openRoom(owner.page, room);
		await openRoom(b.page, room);
		await openRoom(c.page, room);
		await registerAndClaim(owner.page);

		await join(owner.page);
		await join(b.page);
		await join(c.page);

		// Someone without the permission gets nowhere, and is not offered it.
		await expect(c.page.locator('[data-cy="voice-manage"]')).toHaveCount(0);
		const bId = await b.page.evaluate(() => {
			const voice = (window as any).__probe.messages.at(-1).msg;
			return voice.channels[0].members;
		});
		await sendReq(c.page, { type: REQ.Remove, clientId: bId[0] });
		await sleep(300);
		await expect(b.page.locator('[data-cy="voice-leave"]')).toBeVisible();
		await expect(c.page.locator("#connectStatus")).toHaveText("Connected");

		// Removed while talking. The list goes in join order, so the first one is B.
		await holdTalk(b.page);
		await owner.page.locator('[data-cy="voice-manage"]').click();
		await owner.page.locator('[data-cy^="voice-remove-"]').first().click();
		const removedPage = b;
		await expect(b.page.locator('[data-notice="removed"]')).toBeVisible();
		await expect(c.page.locator('[data-speaking="true"]')).toHaveCount(0);
		await expect(c.page.locator('[data-cy="voice-leave"]')).toBeVisible();
		await b.page.mouse.up();

		await expect(removedPage.page.locator('[data-cy="voice-join-main"]')).toHaveCount(0);
		await resetProbe(removedPage.page);
		await sendReq(removedPage.page, { type: REQ.Join, channel: "main" });
		await sleep(200);
		expect((await probeOf(removedPage.page)).messages.map((m: any) => m.msg.reason)).toContain(
			"removed",
		);

		// A reload does not get around it.
		await removedPage.page.reload();
		await expect(removedPage.page.locator('[data-notice="removed"]')).toBeVisible();
		await expect(removedPage.page.locator('[data-cy="voice-join-main"]')).toHaveCount(0);
		console.log("[removal] refused on rejoin, and still refused after a reload");

		// Allowed back.
		await owner.page.locator('[data-cy^="voice-allow-"]').first().click();
		await expect(removedPage.page.locator('[data-notice="removed"]')).toHaveCount(0);
		await join(removedPage.page);
		await Promise.all([owner.ctx.close(), b.ctx.close(), c.ctx.close()]);
	});

	it("dips the movie and restores the exact volume, and mute is personal", async ({
		browser,
	}) => {
		it.setTimeout(120_000);
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await apiAs(a.page, "POST", `/api/room/${room}/queue`, { url: VIDEO_URL });
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await expect(b.page.locator("video")).toBeAttached({ timeout: 30_000 });

		// B's own volume, not a round number.
		await b.page.evaluate(() => {
			const settings = JSON.parse(localStorage.getItem("settings") ?? "{}");
			localStorage.setItem("settings", JSON.stringify({ ...settings, volume: 73 }));
		});
		await b.page.reload();
		await expect(b.page.locator("video")).toBeAttached({ timeout: 30_000 });
		await expect
			.poll(() => b.page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
			.toBe(0.73);
		const startedAt = await b.page.locator("#connectStatus").textContent();
		expect(startedAt).toBe("Connected");

		await join(a.page);
		await join(b.page);

		const volume = () => b.page.locator("video").evaluate((v: HTMLVideoElement) => v.volume);
		await holdTalk(a.page);
		await expect.poll(volume).toBeCloseTo(0.73 * 0.25, 5);
		const during = await volume();
		const stateDuring = await apiAs(b.page, "GET", `/api/room/${room}`);
		await a.page.mouse.up();
		await expect.poll(volume).toBe(0.73);
		const settings = await b.page.evaluate(() =>
			JSON.parse(localStorage.getItem("settings") ?? "{}"),
		);
		console.log(
			`[dip] B's video.volume 0.73 -> ${during} while A talks -> ${await volume()}; stored volume ${settings.volume}`,
		);
		expect(settings.volume).toBe(73);
		expect(stateDuring.status).toBe(200);
		// A's own movie dips too, and A's own volume comes back.
		await expect
			.poll(() => a.page.locator("video").evaluate((v: HTMLVideoElement) => v.volume))
			.toBe(1);

		// B's slider moved during a dip is honoured when the dip ends.
		await holdTalk(a.page);
		await expect.poll(volume).toBeCloseTo(0.73 * 0.25, 5);
		await b.page.keyboard.press("ArrowUp");
		await expect.poll(volume).toBeCloseTo(0.78 * 0.25, 5);
		await a.page.mouse.up();
		await expect.poll(volume).toBe(0.78);
		await b.page.keyboard.press("ArrowDown");
		await expect.poll(volume).toBe(0.73);

		// Personal mute: frames still arrive for B, B's output is silent, nothing dips, A unaffected.
		await b.page.locator('[data-cy="voice-mute"]').click();
		await resetProbe(b.page);
		await holdTalk(a.page);
		await sleep(2500);
		expect(await volume()).toBe(0.73);
		await a.page.mouse.up();
		const muted = await probeOf(b.page);
		console.log(
			`[mute] B received ${muted.framesIn} frames with voice output peak ${muted.peakOut}`,
		);
		expect(muted.framesIn).toBeGreaterThan(50);
		expect(muted.peakOut).toBe(0);
		await b.page.locator('[data-cy="voice-mute"]').click();
		await resetProbe(b.page);
		await holdTalk(a.page);
		await sleep(2500);
		await a.page.mouse.up();
		await sleep(300);
		expect((await probeOf(b.page)).peakOut).toBeGreaterThan(0.003);
		await Promise.all([a.ctx.close(), b.ctx.close()]);
	});

	it("drops malformed and excess frames", async ({ browser }) => {
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await join(a.page);
		await join(b.page);
		await sleep(500);
		await resetProbe(b.page);

		const sendRaw = (page: Page, kind: string) =>
			page.evaluate(kind => {
				const socket = (window as any).__probe.socket as WebSocket;
				const good = () => {
					const bytes = new Uint8Array(642);
					bytes[0] = 0x56;
					bytes[1] = 1;
					return bytes;
				};
				if (kind === "not-speaker") {
					socket.send(good());
				} else if (kind === "bad") {
					socket.send(new Uint8Array(0));
					socket.send(new Uint8Array(3));
					socket.send(new Uint8Array(642));
					socket.send(good().slice(0, 641));
					socket.send(new Uint8Array(70_000));
					socket.send("{not json");
				} else if (kind === "flood") {
					for (let i = 0; i < 1000; i++) {
						socket.send(good());
					}
				}
			}, kind);

		// Nobody has the floor yet.
		await sendRaw(a.page, "not-speaker");
		await sleep(200);
		expect((await probeOf(b.page)).framesIn).toBe(0);

		await sendReq(a.page, { type: REQ.Talk, talking: true });
		await sleep(100);
		await sendRaw(a.page, "bad");
		await sleep(300);
		expect((await probeOf(b.page)).framesIn).toBe(0);
		await expect(a.page.locator("#connectStatus")).toHaveText("Connected");

		// A frame carrying a known string, for checking afterwards that audio is stored nowhere.
		await a.page.evaluate(() => {
			const bytes = new Uint8Array(642);
			bytes[0] = 0x56;
			bytes[1] = 1;
			bytes.set(new TextEncoder().encode("OTTVOICEMARKER"), 2);
			(window as any).__probe.socket.send(bytes);
		});
		await sleep(200);
		expect((await probeOf(b.page)).framesIn).toBe(1);
		await resetProbe(b.page);

		await sendRaw(a.page, "flood");
		await sleep(500);
		const flood = (await probeOf(b.page)).framesIn;
		console.log(`[flood] 1000 frames sent at once, ${flood} reached B`);
		expect(flood).toBeGreaterThan(0);
		expect(flood).toBeLessThan(100);
		await sendReq(a.page, { type: REQ.Talk, talking: false });
		await expect(a.page.locator("#connectStatus")).toHaveText("Connected");
		await Promise.all([a.ctx.close(), b.ctx.close()]);
	});

	it("never gets stuck talking", async ({ browser }) => {
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await join(a.page);
		await join(b.page);

		const expectIdle = async () => {
			await expect(b.page.locator('[data-speaking="true"]')).toHaveCount(0);
			await expect(talkButton(a.page)).toContainText("Hold to talk");
		};

		// Mouse slides off the button and lets go elsewhere.
		await holdTalk(a.page);
		await a.page.mouse.move(5, 5);
		await sleep(200);
		await expect(b.page.locator('[data-speaking="true"]')).toHaveCount(1);
		await a.page.mouse.up();
		await expectIdle();

		// The tab loses focus.
		await holdTalk(a.page);
		await a.page.evaluate(() => window.dispatchEvent(new Event("blur")));
		await expectIdle();
		await a.page.mouse.up();

		// The tab is hidden.
		await holdTalk(a.page);
		await a.page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				configurable: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
			Object.defineProperty(document, "visibilityState", {
				value: "visible",
				configurable: true,
			});
		});
		await expectIdle();
		await a.page.mouse.up();

		// The speaker's connection dies: the floor comes free for everyone else.
		await holdTalk(a.page);
		await a.ctx.close();
		await expect(b.page.locator('[data-speaking="true"]')).toHaveCount(0);
		await holdTalk(b.page);
		await b.page.mouse.up();
		await b.ctx.close();
	});

	it("keeps the mic muted unless held, and off after a short while", async ({ browser }) => {
		it.setTimeout(60_000);
		const a = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await join(a.page);

		const track = async () => (await probeOf(a.page)).tracks.at(-1);
		await expect.poll(track).toEqual({ enabled: false, state: "live" });
		await holdTalk(a.page);
		expect(await track()).toEqual({ enabled: true, state: "live" });
		await a.page.mouse.up();
		await expect.poll(track).toEqual({ enabled: false, state: "live" });

		// After the warm window the mic is really closed, which is what clears the phone's indicator.
		await expect.poll(track, { timeout: 20_000 }).toEqual({ enabled: false, state: "ended" });
		const before = (await probeOf(a.page)).micRequests.length;
		await holdTalk(a.page);
		await a.page.mouse.up();
		const requests = (await probeOf(a.page)).micRequests;
		expect(requests.length).toBe(before + 1);
		const reopen = requests.at(-1);
		console.log(
			`[mic] reopening a released mic took ${Math.round(reopen.doneAt - reopen.startedAt)} ms (fake device)`,
		);
		await a.ctx.close();
	});

	it("handles a blocked or missing mic: listen only, with a way to retry", async ({
		browser,
	}) => {
		const a = await newUser(browser);
		const denied = await newUser(browser, () => {
			navigator.mediaDevices.getUserMedia = async () => {
				throw new DOMException("no", "NotAllowedError");
			};
		});
		const none = await newUser(browser, () => {
			navigator.mediaDevices.getUserMedia = async () => {
				throw new DOMException("no", "NotFoundError");
			};
		});
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(denied.page, room);
		await openRoom(none.page, room);
		await join(a.page);
		await join(denied.page);
		await join(none.page);

		await expect(denied.page.locator('[data-notice="mic-denied"]')).toBeVisible();
		await expect(none.page.locator('[data-notice="no-mic"]')).toBeVisible();
		await expect(talkButton(denied.page)).toBeDisabled();
		await expect(talkButton(none.page)).toBeDisabled();

		await sleep(500);
		await resetProbe(denied.page);
		await holdTalk(a.page);
		await sleep(1200);
		await a.page.mouse.up();
		expect((await probeOf(denied.page)).framesIn).toBeGreaterThan(30);

		await denied.page.evaluate(() => {
			navigator.mediaDevices.getUserMedia = async constraints =>
				MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, constraints);
		});
		await denied.page.locator('[data-cy="voice-mic-retry"]').click();
		await expect(denied.page.locator('[data-notice="mic-denied"]')).toHaveCount(0);
		await expect(talkButton(denied.page)).toBeEnabled();
		await Promise.all([a.ctx.close(), denied.ctx.close(), none.ctx.close()]);
	});

	it("rejoins after a reconnect and shows the wait while disconnected", async ({ browser }) => {
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await join(a.page);
		await join(b.page);

		await a.page.evaluate(() => (window as any).__probe.socket.close(1000));
		await expect(a.page.locator('[data-notice="disconnected"]')).toBeVisible();
		await expect(a.page.locator("#connectStatus")).toHaveText("Connected", { timeout: 15_000 });
		await expect(a.page.locator('[data-cy="voice-leave"]')).toBeVisible({ timeout: 5000 });
		await expect(a.page.locator('[data-notice="disconnected"]')).toHaveCount(0);
		await a.page.evaluate(() => {
			(window as any).__probe.framesOut = 0;
		});
		await holdTalk(a.page);
		await sleep(500);
		await a.page.mouse.up();
		expect((await probeOf(a.page)).framesOut).toBeGreaterThan(10);
		await Promise.all([a.ctx.close(), b.ctx.close()]);
	});

	it("keeps a talk button in reach in fullscreen, and out of the way", async ({ browser }) => {
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await apiAs(a.page, "POST", `/api/room/${room}/queue`, { url: VIDEO_URL });
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await join(b.page);

		const floating = a.page.locator(".voice-floating-position");
		await a.page.locator('[aria-label="Toggle fullscreen"]').first().click();
		await expect.poll(() => a.page.evaluate(() => !!document.fullscreenElement)).toBe(true);
		await expect(floating).toHaveCount(0); // not joined: nothing extra over the movie
		await a.page.keyboard.press("Escape").catch(() => undefined);
		await a.page.evaluate(() => document.exitFullscreen?.()).catch(() => undefined);
		await join(a.page);
		await a.page.locator('[aria-label="Toggle fullscreen"]').first().click();
		await expect(floating).toBeVisible();

		const reactions = await a.page.locator('[data-cy="reaction-bar"]').boundingBox();
		const box = await floating.boundingBox();
		if (!reactions || !box) {
			throw new Error("missing box");
		}
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		expect(box.y + box.height).toBeLessThanOrEqual(reactions.y);

		await a.page.mouse.move(box.x + 22, box.y + 22);
		await a.page.mouse.down();
		await expect(b.page.locator('[data-speaking="true"]')).toHaveCount(1);
		await sleep(3500); // long enough for the controls to hide
		await expect(floating).toBeVisible();
		await a.page.mouse.up();
		await expect(b.page.locator('[data-speaking="true"]')).toHaveCount(0);
		await Promise.all([a.ctx.close(), b.ctx.close()]);
	});

	it("stays out of the phone typing view", async ({ browser }) => {
		const a = await newUser(browser);
		const room = await createRoom(a.page);
		await a.ctx.close();
		const ctx = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
			permissions: ["microphone"],
		});
		await ctx.addInitScript(installProbes);
		const page = await ctx.newPage();
		await openRoom(page, room);
		await page.locator('[data-cy="voice-join-main"]').tap();
		await expect(page.locator('[data-cy="voice-leave"]')).toBeVisible();

		await page.locator('[aria-label="Open chat"]').first().tap();
		await expect(page.locator(".typing-view")).toHaveCount(1);
		const covered = await page.evaluate(() => {
			const talk = document.querySelector('[data-cy="voice-talk"]') as HTMLElement;
			const rect = talk.getBoundingClientRect();
			const top = document.elementFromPoint(
				rect.x + rect.width / 2,
				rect.y + rect.height / 2,
			);
			return !talk.contains(top);
		});
		expect(covered).toBe(true);
		await expect(page.locator(".voice-floating-position")).toHaveCount(0);
		await ctx.close();
	});

	it("measures how long a beep takes from one person's mic to another's output", async ({
		browser,
	}) => {
		it.setTimeout(60_000);
		const a = await newUser(browser);
		const b = await newUser(browser);
		const room = await createRoom(a.page);
		await openRoom(a.page, room);
		await openRoom(b.page, room);
		await join(a.page);
		await join(b.page);
		await sleep(500);
		await resetProbe(a.page);
		await resetProbe(b.page);

		await holdTalk(a.page);
		await sleep(9000);
		await a.page.mouse.up();
		await sleep(300);

		const micOnsets = (await probeOf(a.page)).micOnsets as number[];
		const outOnsets = (await probeOf(b.page)).outOnsets as number[];
		const delays: number[] = [];
		for (const at of micOnsets) {
			const heard = outOnsets.find(t => t >= at && t - at < 800);
			if (heard !== undefined) {
				delays.push(Math.round(heard - at));
			}
		}
		delays.sort((x, y) => x - y);
		const latencyInfo = await b.page.evaluate(() => {
			const ctx = (window as any).__probe.outputs.at(-1)?.context as AudioContext | undefined;
			return { base: ctx?.baseLatency, output: ctx?.outputLatency, rate: ctx?.sampleRate };
		});
		console.log(
			`[latency] ${delays.length} beeps of ${micOnsets.length}, mic node to B's output node: min ${delays[0]} ms, median ${delays[Math.floor(delays.length / 2)]} ms, max ${delays.at(-1)} ms. All: ${delays.join(",")}. B's device reports base ${latencyInfo.base}, output ${latencyInfo.output}, rate ${latencyInfo.rate}. Not included: the mic's and speaker's own hardware delay.`,
		);
		expect(delays.length).toBeGreaterThan(3);
		await Promise.all([a.ctx.close(), b.ctx.close()]);
	});
});

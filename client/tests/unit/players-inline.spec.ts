import { describe, expect, it } from "vitest";

const VIDEO_TAG = /<video\b[^>]*>/g;
const PLAYS_INLINE = /\bplaysinline\b/;

const players = import.meta.glob<string>("../../src/components/players/*.vue", {
	eager: true,
	import: "default",
	query: "?raw",
});

describe("video players", () => {
	it("found the players", () => {
		expect(Object.keys(players).length).toBeGreaterThan(0);
	});

	// Without it an iPhone hands the movie to its own player, over the room, chat and reactions.
	it.each(Object.entries(players))("%s keeps its video in the page", (_path, source) => {
		for (const [tag] of source.matchAll(VIDEO_TAG)) {
			expect(tag).toMatch(PLAYS_INLINE);
		}
	});
});

import { describe, expect, it } from "vitest";

const players = import.meta.glob("../../src/components/players/*.vue", {
	eager: true,
	import: "default",
	query: "?raw",
}) as Record<string, string>;

describe("video players", () => {
	it("found the players", () => {
		expect(Object.keys(players).length).toBeGreaterThan(0);
	});

	// Without it an iPhone hands the movie to its own player, over the room, chat and reactions.
	it.each(Object.entries(players))("%s keeps its video in the page", (_path, source) => {
		for (const [tag] of source.matchAll(/<video\b[^>]*>/g)) {
			expect(tag).toMatch(/\bplaysinline\b/);
		}
	});
});

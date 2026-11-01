import { describe, it, expect } from "vitest";
import { VideoQueue } from "../../videoqueue.js";
import type { Video } from "ott-common/models/video.js";

const video = (id: string): Video => ({
	service: "direct",
	id,
	title: id,
	description: "",
	length: 10,
});

describe("VideoQueue.move", () => {
	it("moves an item", async () => {
		const queue = new VideoQueue([video("a"), video("b"), video("c")]);
		await queue.move(0, 2);
		expect(queue.items.map(item => item.id)).toEqual(["b", "c", "a"]);
	});

	// A move with these used to get past the bounds checks. On an empty queue it put an undefined item
	// in, which every later queue operation and every client then tripped over.
	it.each([
		["junk", "other junk"],
		[{}, []],
		[null, undefined],
		[0.5, 1],
		[0, 0.5],
		["0", "1"],
	])("refuses from %j to %j and leaves the queue alone", async (from, to) => {
		for (const items of [[], [video("a"), video("b")]]) {
			const queue = new VideoQueue(items);
			const before = [...queue.items];
			await expect(queue.move(from as number, to as number)).rejects.toThrow();
			expect(queue.items).toEqual(before);
		}
	});
});

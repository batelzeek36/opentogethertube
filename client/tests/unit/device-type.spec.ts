import { describe, expect, it } from "vitest";
import { type DeviceClues, deviceTypeFrom } from "@/util/device-type";

const clues = (over: Partial<DeviceClues>): DeviceClues => ({
	userAgent: "",
	platform: "",
	maxTouchPoints: 0,
	...over,
});

describe("deviceTypeFrom", () => {
	it.each([
		[
			"iPhone Safari",
			"phone",
			{
				userAgent:
					"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
				platform: "iPhone",
				maxTouchPoints: 5,
			},
		],
		[
			"Android Chrome, by client hints",
			"phone",
			{
				userAgent:
					"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
				platform: "Linux armv81",
				maxTouchPoints: 5,
				uaData: { mobile: true, platform: "Android" },
			},
		],
		[
			"Android Firefox, no client hints",
			"phone",
			{
				userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0",
				platform: "Linux aarch64",
				maxTouchPoints: 5,
			},
		],
		[
			"Android tablet",
			"tablet",
			{
				userAgent:
					"Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
				platform: "Linux armv81",
				maxTouchPoints: 5,
				uaData: { mobile: false, platform: "Android" },
			},
		],
		[
			"iPad, which calls itself a Mac",
			"tablet",
			{
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
				platform: "MacIntel",
				maxTouchPoints: 5,
			},
		],
		[
			"older iPad",
			"tablet",
			{
				userAgent:
					"Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1",
				platform: "iPad",
				maxTouchPoints: 5,
			},
		],
		[
			"Mac",
			"computer",
			{
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
				platform: "MacIntel",
			},
		],
		[
			"Windows laptop with a touch screen",
			"computer",
			{
				userAgent:
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
				platform: "Win32",
				maxTouchPoints: 10,
				uaData: { mobile: false, platform: "Windows" },
			},
		],
		[
			"Linux",
			"computer",
			{
				userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
				platform: "Linux x86_64",
			},
		],
		[
			"Chromebook",
			"computer",
			{
				userAgent:
					"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
				platform: "Linux x86_64",
			},
		],
	] as const)("%s is a %s", (_name, expected, over) => {
		expect(deviceTypeFrom(clues(over))).toEqual(expected);
	});

	it.each([
		["Android TV", "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) Chrome/120.0.0.0 Safari/537.36"],
		["Fire TV", "Mozilla/5.0 (Linux; Android 9; AFTMM) Chrome/120.0.0.0 Safari/537.36"],
		["Samsung TV", "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36"],
		["nothing to go on", ""],
	])("%s is unknown", (_name, userAgent) => {
		expect(deviceTypeFrom(clues({ userAgent }))).toBeUndefined();
	});
});

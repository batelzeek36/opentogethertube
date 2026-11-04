import type { DeviceType } from "ott-common/models/device";

/** What is read from the browser. All of it stays here: only the resulting type is ever sent. */
export interface DeviceClues {
	userAgent: string;
	platform: string;
	maxTouchPoints: number;
	/** navigator.userAgentData, on the browsers that have it. */
	uaData?: { mobile?: boolean; platform?: string };
}

/** Big screens run Android too, and are none of the three kinds. */
const TELEVISION =
	/\b(Android TV|GoogleTV|Google TV|SmartTV|SMART-TV|BRAVIA|AFT[A-Z]+|Roku|Tizen|Web0S)\b/;
const NON_ANDROID_TABLET = /\b(iPad|Tablet|Kindle|Silk|PlayBook)\b/i;
const NON_ANDROID_PHONE = /\b(iPhone|iPod|Mobi)/i;
const COMPUTER = /\b(Windows NT|Macintosh|CrOS|X11|Linux)\b/i;
const ANDROID = /\bAndroid\b/;
const ANDROID_PHONE = /\bMobile\b/;
const MAC_PLATFORM = /Mac/;
const IOS = /\b(iPhone|iPad|iPod)\b/;

/** The coarse type of a device, or undefined when it can't be told. Unknown shows no icon. */
export function deviceTypeFrom(clues: DeviceClues): DeviceType | undefined {
	const { userAgent, platform, maxTouchPoints, uaData } = clues;
	if (TELEVISION.test(userAgent)) {
		return undefined;
	}
	// iPads have called themselves a Mac by default since iPadOS 13. No real Mac has a touch screen.
	if (MAC_PLATFORM.test(platform) && maxTouchPoints > 1) {
		return "tablet";
	}
	if (uaData?.platform === "Android" || ANDROID.test(userAgent)) {
		const mobile = uaData?.mobile ?? ANDROID_PHONE.test(userAgent);
		return mobile ? "phone" : "tablet";
	}
	if (NON_ANDROID_TABLET.test(userAgent)) {
		return "tablet";
	}
	if (NON_ANDROID_PHONE.test(userAgent) || uaData?.mobile) {
		return "phone";
	}
	if (COMPUTER.test(userAgent)) {
		return "computer";
	}
	return undefined;
}

/** An iPhone, iPad or iPod, in any browser: they all run on Apple's WebKit there. */
export function iosFrom({ userAgent, platform, maxTouchPoints }: DeviceClues): boolean {
	return IOS.test(userAgent) || (MAC_PLATFORM.test(platform) && maxTouchPoints > 1);
}

export function isIos(): boolean {
	return iosFrom(navigator);
}

export function detectDeviceType(): DeviceType | undefined {
	const nav = navigator as Navigator & { userAgentData?: DeviceClues["uaData"] };
	return deviceTypeFrom({
		userAgent: nav.userAgent,
		platform: nav.platform,
		maxTouchPoints: nav.maxTouchPoints,
		uaData: nav.userAgentData,
	});
}

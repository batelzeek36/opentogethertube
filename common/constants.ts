import type { Category } from "sponsorblock-api";

export const ANNOUNCEMENT_CHANNEL = "announcement";
export const ROOM_NAME_REGEX = /^[a-z0-9_-]+$/i;
export const USERNAME_LENGTH_MAX = 48;
export const CHAT_MESSAGE_LENGTH_MAX = 4000;
/** Every player offers speeds inside this, and every browser can play at them. */
export const PLAYBACK_SPEED_MIN = 0.25;
export const PLAYBACK_SPEED_MAX = 4;
export const ALL_VIDEO_SERVICES = [
	"youtube",
	"vimeo",
	"direct",
	"hls",
	"dash",
	"tubi",
	"reddit",
	"googledrive",
	"peertube",
	"pluto",
	"invidious",
	"odysee",
] as const;
export const ALL_SKIP_CATEGORIES: Category[] = [
	"sponsor",
	"intro",
	"outro",
	"interaction",
	"selfpromo",
	"music_offtopic",
	"preview",
] as const;

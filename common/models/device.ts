/** All anyone is told about a device. A user agent string never leaves the browser. */
export const DEVICE_TYPES = ["phone", "tablet", "computer"] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export function isDeviceType(value: unknown): value is DeviceType {
	return DEVICE_TYPES.includes(value as DeviceType);
}

import { describe, expect, it } from "vitest";
import { isClientSendableRequest } from "../../client-requests.js";
import { RoomRequestType } from "ott-common/models/messages.js";

const allTypes = Object.values(RoomRequestType).filter(
	(value): value is RoomRequestType => typeof value === "number",
);
const serverOnly = [
	RoomRequestType.JoinRequest,
	RoomRequestType.LeaveRequest,
	RoomRequestType.UpdateUser,
];

describe("isClientSendableRequest", () => {
	it("refuses only the requests that say who someone is", () => {
		expect(allTypes.filter(type => !isClientSendableRequest({ type }))).toEqual(serverOnly);
	});

	it.each(allTypes.filter(type => !serverOnly.includes(type)))(
		"accepts request type %s, which open tabs send as a number",
		type => {
			expect(isClientSendableRequest({ type })).toEqual(true);
		},
	);

	it.each([
		[String(RoomRequestType.PlaybackRequest)],
		[[RoomRequestType.PlaybackRequest]],
		[{ valueOf: RoomRequestType.PlaybackRequest }],
		[true],
		[null],
		[undefined],
		[-1],
		[1.5],
		[allTypes.length],
		["constructor"],
		["__proto__"],
	])("refuses a type of %j", type => {
		expect(isClientSendableRequest({ type })).toEqual(false);
	});

	it.each([[null], [undefined], ["request"], [2], [true]])("refuses a request of %j", request => {
		expect(isClientSendableRequest(request)).toEqual(false);
	});
});

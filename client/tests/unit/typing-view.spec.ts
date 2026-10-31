import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { chatOpen } from "@/components/chat-state";
import { useTypingView } from "@/components/composables/typing-view";

function mountWith(coarse: boolean) {
	vi.stubGlobal("matchMedia", () => ({ matches: coarse }));
	vi.stubGlobal("visualViewport", {
		offsetTop: 40,
		offsetLeft: 0,
		width: 412,
		height: 380,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	});
	let result!: ReturnType<typeof useTypingView>;
	mount(
		defineComponent({
			setup() {
				result = useTypingView();
				return () => h("div");
			},
		}),
	);
	return result;
}

describe("useTypingView", () => {
	afterEach(() => {
		chatOpen.value = false;
		vi.unstubAllGlobals();
	});

	it("fills the space above the keyboard while the chat is open on a touch screen", async () => {
		const { typingView, typingStyle } = mountWith(true);
		expect(typingView.value).toBe(false);
		expect(typingStyle.value).toBeUndefined();
		chatOpen.value = true;
		await nextTick();
		expect(typingView.value).toBe(true);
		expect(typingStyle.value).toEqual({
			top: "40px",
			left: "0px",
			width: "412px",
			height: "380px",
		});
	});

	it("leaves a mouse-driven screen as it is", async () => {
		const { typingView } = mountWith(false);
		chatOpen.value = true;
		await nextTick();
		expect(typingView.value).toBe(false);
	});
});

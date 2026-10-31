import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { chatOpen } from "@/components/chat-state";

/**
 * On a touch screen, the open chat takes over the space above the keyboard: the whole movie frame
 * on top (or to the side when the phone is sideways), the chat next to it. The browser's visual
 * viewport is the only measure of that space, because the keyboard does not resize the page.
 */
export function useTypingView() {
	const size = reactive({ top: 0, left: 0, width: 0, height: 0 });
	const isTouch = window.matchMedia?.("(pointer: coarse)").matches ?? false;

	function measure() {
		const viewport = window.visualViewport;
		size.top = viewport?.offsetTop ?? 0;
		size.left = viewport?.offsetLeft ?? 0;
		size.width = viewport?.width ?? window.innerWidth;
		size.height = viewport?.height ?? window.innerHeight;
	}

	onMounted(() => {
		measure();
		window.visualViewport?.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("scroll", measure);
	});
	onUnmounted(() => {
		window.visualViewport?.removeEventListener("resize", measure);
		window.visualViewport?.removeEventListener("scroll", measure);
	});

	const typingView = computed(() => isTouch && chatOpen.value);
	const videoAspect = ref<number | null>(null);
	watch(typingView, active => {
		if (active) {
			const video = document.querySelector("video");
			videoAspect.value = video?.videoHeight ? video.videoWidth / video.videoHeight : null;
		}
	});
	const typingStyle = computed(() =>
		typingView.value
			? {
					top: `${size.top}px`,
					left: `${size.left}px`,
					width: `${size.width}px`,
					height: `${size.height}px`,
					...(videoAspect.value ? { "--video-aspect": String(videoAspect.value) } : {}),
				}
			: undefined,
	);
	return { typingView, typingStyle };
}

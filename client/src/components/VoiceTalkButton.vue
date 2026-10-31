<template>
	<button
		type="button"
		:class="
			cn(
				'voice-talk',
				floating
					? 'voice-talk-floating'
					: buttonVariants({
							variant: voice.talking.value ? 'default' : 'marquee',
							size: 'lg',
					  }),
				props.class,
			)
		"
		:data-talking="voice.talking.value"
		:disabled="!voice.holding.value && !voice.canTalk.value"
		:aria-label="label"
		:aria-pressed="voice.holding.value"
		data-cy="voice-talk"
		@pointerdown="onPointerDown"
		@touchstart.prevent
		@lostpointercapture="onPointerUp"
		@keydown="onKeyDown"
		@keyup="onKeyUp"
		@blur="voice.release"
		@contextmenu.prevent
		@dragstart.prevent
		@selectstart.prevent
	>
		<Icon :icon="mdiMicrophone" class="size-5" />
		<span v-if="!floating" class="truncate">{{ label }}</span>
	</button>
</template>

<script lang="ts" setup>
import { computed, type HTMLAttributes, onUnmounted } from "vue";
import { mdiMicrophone } from "@mdi/js";
import { useI18n } from "vue-i18n";
import { buttonVariants } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useVoice } from "@/voice/session";

const props = defineProps<{
	/** The round version shown over the movie in fullscreen, where the panel is out of reach. */
	floating?: boolean;
	class?: HTMLAttributes["class"];
}>();

const { t } = useI18n();
const store = useStore();
const voice = useVoice();

const label = computed(() => {
	if (voice.talking.value) {
		return t("voice.talking", { seconds: voice.talkSecondsLeft.value });
	}
	if (voice.holding.value && voice.micWaiting.value) {
		return t("voice.getting-mic");
	}
	const speaker = voice.otherSpeaker.value;
	if (speaker) {
		return t("voice.someone-talking", {
			name: store.state.users.users.get(speaker)?.name ?? t("voice.someone"),
		});
	}
	if (voice.cooldownSeconds.value > 0) {
		return t("voice.wait", { seconds: voice.cooldownSeconds.value });
	}
	return t("voice.hold-to-talk");
});

/*
 * The release is listened for on the window as well as captured on the button: wherever the finger
 * or mouse ends up, and even if the button gets disabled under it, letting go is always seen.
 * Touch and mouse events are here too because Firefox on Android never sent pointerup after a long
 * press (seen on the S25), which left the mic on until the time limit. touchstart.prevent on the
 * button stops that long press from starting.
 */
const RELEASE_EVENTS = ["pointerup", "pointercancel", "touchend", "touchcancel", "mouseup"];

function onPointerUp() {
	for (const name of RELEASE_EVENTS) {
		window.removeEventListener(name, onPointerUp);
	}
	voice.release();
}

function onPointerDown(e: PointerEvent) {
	if (e.pointerType === "mouse" && e.button !== 0) {
		return;
	}
	// Stops the browser turning this press into a text selection or a focus scroll.
	e.preventDefault();
	(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	for (const name of RELEASE_EVENTS) {
		window.addEventListener(name, onPointerUp);
	}
	voice.press();
}

function isTalkKey(e: KeyboardEvent) {
	return e.code === "Space" || e.code === "Enter";
}

function onKeyDown(e: KeyboardEvent) {
	if (isTalkKey(e)) {
		// Space is also the room's play/pause shortcut.
		e.preventDefault();
		e.stopPropagation();
		if (!e.repeat) {
			voice.press();
		}
	}
}

function onKeyUp(e: KeyboardEvent) {
	if (isTalkKey(e)) {
		e.preventDefault();
		e.stopPropagation();
		voice.release();
	}
}

onUnmounted(onPointerUp);
</script>

<style scoped>
.voice-talk {
	touch-action: none;
	user-select: none;
	-webkit-user-select: none;
	-webkit-touch-callout: none;
	-webkit-tap-highlight-color: transparent;
}

.voice-talk-floating {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	border-radius: 999px;
	color: white;
	background: rgb(0 0 0 / 55%);
	backdrop-filter: blur(6px);
	cursor: pointer;
}

.voice-talk-floating[data-talking="true"] {
	color: var(--primary-foreground);
	background: var(--primary);
}

.voice-talk-floating:disabled {
	opacity: 0.4;
	cursor: default;
}

.voice-talk-floating:focus-visible {
	outline: 2px solid white;
	outline-offset: 2px;
}
</style>

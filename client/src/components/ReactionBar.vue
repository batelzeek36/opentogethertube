<template>
	<div
		v-if="canReact"
		v-show="visible"
		class="reaction-bar"
		:class="[mode, { 'chat-open': chatOpen }]"
		role="group"
		:aria-label="$t('room.reactions')"
		data-cy="reaction-bar"
	>
		<button
			v-for="emoji in REACTIONS"
			:key="emoji"
			type="button"
			class="reaction-button"
			:aria-label="$t('room.react', { emoji })"
			:data-cy="`react-${emoji}`"
			@click="roomapi.react(emoji)"
		>
			{{ emoji }}
		</button>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { REACTIONS } from "ott-common/models/reactions";
import { useConnection } from "@/plugins/connection";
import { useGrants } from "@/components/composables/grants";
import { useRoomApi } from "@/util/roomapi";
import { chatOpen } from "./chat-state";

defineProps<{
	mode: "in-video" | "outside-video";
	visible: boolean;
}>();

const roomapi = useRoomApi(useConnection());
const granted = useGrants();
const canReact = computed(() => granted("chat"));
</script>

<style scoped>
.reaction-bar {
	position: absolute;
	left: 10px;
	z-index: 40;
	display: flex;
	gap: 2px;
	max-width: calc(100% - 20px);
	padding: 3px;
	border-radius: 999px;
	background: rgb(0 0 0 / 55%);
	backdrop-filter: blur(6px);
	overflow-x: auto;
	scrollbar-width: none;
}

.reaction-bar.in-video {
	bottom: 80px;
}

.reaction-bar.outside-video {
	bottom: 10px;
}

/* The open chat's input sits at this height on narrow screens. */
@media (max-width: 1023.98px) {
	.reaction-bar.chat-open {
		display: none;
	}
}

.reaction-button {
	font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
	flex: none;
	width: 38px;
	height: 38px;
	border-radius: 999px;
	font-size: 20px;
	line-height: 1;
	cursor: pointer;
	touch-action: manipulation;
	transition: transform 120ms ease-out, background-color 120ms ease-out;
}

.reaction-button:hover {
	background: rgb(255 255 255 / 15%);
}

.reaction-button:active {
	transform: scale(0.85);
}

.reaction-button:focus-visible {
	outline: 2px solid white;
	outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
	.reaction-button {
		transition: none;
	}
}
</style>

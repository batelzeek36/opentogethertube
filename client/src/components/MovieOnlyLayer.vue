<template>
	<div
		class="movie-only-tap"
		:class="{ revealed }"
		data-movie-only-keep
		data-cy="movie-only-tap"
		@click.stop="emit('tap')"
		@pointerdown.stop
		@pointerup.stop
		@mousedown.stop
		@mouseup.stop
		@mousemove.stop
		@touchstart.stop.passive
		@touchmove.stop.passive
		@touchend.stop.passive
	></div>
	<Transition name="movie-only-show">
		<div
			v-if="revealed"
			ref="showControls"
			class="movie-only-show"
			:class="{ 'below-play': playbackBlocked }"
			data-movie-only-keep
		>
			<Button
				size="xl"
				data-cy="movie-only-show-controls"
				@click.stop="emit('show-controls')"
			>
				{{ $t("room.show-controls") }}
			</Button>
		</div>
	</Transition>
</template>

<script lang="ts" setup>
import { nextTick, useTemplateRef, watch } from "vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{
	revealed: boolean;
	/** Set when a key brought the button up, so the same keyboard can press it. */
	takeFocus: boolean;
	/** The browser's PLAY button is up in the middle of the screen, so make room for it. */
	playbackBlocked: boolean;
}>();

const emit = defineEmits<{ "tap": []; "show-controls": [] }>();

const showControls = useTemplateRef<HTMLDivElement>("showControls");

watch(
	() => props.revealed && props.takeFocus,
	async focus => {
		if (focus) {
			await nextTick();
			showControls.value?.querySelector("button")?.focus();
		}
	},
);
</script>

<style scoped>
/* Sits under the PLAY button (z-200), which has to keep working here. */
.movie-only-tap {
	position: absolute;
	inset: 0;
	z-index: 150;
	cursor: none;
	touch-action: none;
	-webkit-tap-highlight-color: transparent;
}

.movie-only-tap.revealed {
	cursor: auto;
}

/* The wrapper is only there to center the button, so a tap beside it still lands on the tap area. */
.movie-only-show {
	position: absolute;
	inset: 0;
	z-index: 250;
	display: flex;
	align-items: center;
	justify-content: center;
	pointer-events: none;
}

.movie-only-show :deep(button) {
	pointer-events: auto;
	touch-action: manipulation;
}

.movie-only-show.below-play {
	padding-top: 152px;
}

.movie-only-show-enter-active {
	transition: opacity 120ms ease-out;
}

.movie-only-show-leave-active {
	transition: opacity 500ms ease-out;
}

.movie-only-show-enter-from,
.movie-only-show-leave-to {
	opacity: 0;
}
</style>

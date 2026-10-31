<template>
	<div class="reaction-overlay" aria-hidden="true" data-cy="reaction-overlay">
		<span
			v-for="item in floating"
			:key="item.id"
			class="floating-reaction"
			:style="{ 'left': `${item.left}%`, '--drift': `${item.drift}px` }"
			data-cy="floating-reaction"
			@animationend="remove(item.id)"
		>
			{{ item.emoji }}
		</span>
	</div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from "vue";
import type { ServerMessage } from "ott-common/models/messages";
import type { Reaction } from "ott-common/models/reactions";
import { useConnection } from "@/plugins/connection";

/** Animations do not finish in a hidden tab, so this also bounds what a background tab keeps. */
const MAX_FLOATING = 30;

interface FloatingReaction {
	id: number;
	emoji: Reaction;
	left: number;
	drift: number;
}

const connection = useConnection();
const floating = ref<FloatingReaction[]>([]);
let nextId = 0;

function remove(id: number) {
	floating.value = floating.value.filter(item => item.id !== id);
}

function onReaction(msg: ServerMessage) {
	if (msg.action !== "reaction") {
		return;
	}
	floating.value = [
		...floating.value.slice(-(MAX_FLOATING - 1)),
		{
			id: nextId++,
			emoji: msg.emoji,
			// The left side, so reactions stay clear of the chat on the right.
			left: 6 + Math.random() * 52,
			drift: (Math.random() - 0.5) * 60,
		},
	];
}

onMounted(() => connection.addMessageHandler("reaction", onReaction));
onUnmounted(() => connection.removeMessageHandler("reaction", onReaction));
</script>

<style scoped>
.reaction-overlay {
	position: absolute;
	inset: 0;
	z-index: 30;
	overflow: hidden;
	pointer-events: none;
}

.floating-reaction {
	font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
	position: absolute;
	bottom: 130px;
	font-size: 34px;
	line-height: 1;
	will-change: transform, opacity;
	animation: reaction-rise 2600ms cubic-bezier(0.22, 0.8, 0.36, 1) forwards;
}

@keyframes reaction-rise {
	0% {
		opacity: 0;
		transform: translate(0, 0) scale(0.5);
	}
	12% {
		opacity: 1;
		transform: translate(0, -18px) scale(1.15);
	}
	70% {
		opacity: 1;
	}
	100% {
		opacity: 0;
		transform: translate(var(--drift), -240px) scale(1);
	}
}

@media (prefers-reduced-motion: reduce) {
	.floating-reaction {
		animation: reaction-fade 1400ms linear forwards;
	}

	@keyframes reaction-fade {
		0%,
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
}
</style>

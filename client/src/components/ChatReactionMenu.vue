<template>
	<div
		ref="menu"
		class="chat-reaction-picker"
		:class="{ stacked: placement.columns < REACTIONS.length }"
		role="toolbar"
		:aria-label="$t('room.reactions')"
		data-cy="chat-reaction-picker"
		:style="{
			'left': `${placement.left}px`,
			'top': `${placement.top}px`,
			'--slot': `${placement.slot}px`,
			'--row': `${placement.rowHeight}px`,
			'--columns': placement.columns,
		}"
		@keydown="onKeyDown"
	>
		<button
			v-for="(emoji, index) in REACTIONS"
			:key="emoji"
			type="button"
			class="pick"
			:class="{ 'top-row': index < placement.columns }"
			:aria-label="$t('room.react', { emoji })"
			:aria-pressed="isMine(emoji)"
			:data-cy="`chat-react-${emoji}`"
			@click="emit('choose', emoji, !isMine(emoji))"
		>
			{{ emoji }}
		</button>
	</div>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import { type ChatReactionCount, REACTIONS, type Reaction } from "ott-common/models/reactions";
import type { MenuPlacement } from "@/components/chat-reaction-menu-placement";

const props = defineProps<{
	placement: MenuPlacement;
	reactions?: ChatReactionCount[];
}>();

const emit = defineEmits<{
	choose: [emoji: Reaction, add: boolean];
	escape: [];
}>();

const menu = ref<HTMLElement>();

function isMine(emoji: Reaction): boolean {
	return props.reactions?.some(chip => chip.emoji === emoji && chip.mine) ?? false;
}

function buttons(): HTMLElement[] {
	return Array.from(menu.value?.querySelectorAll<HTMLElement>("button") ?? []);
}

function focusFirst() {
	buttons()[0]?.focus();
}

function onKeyDown(e: KeyboardEvent) {
	const all = buttons();
	const at = all.indexOf(document.activeElement as HTMLElement);
	const next: Record<string, number> = {
		ArrowLeft: (at - 1 + all.length) % all.length,
		ArrowRight: (at + 1) % all.length,
		Home: 0,
		End: all.length - 1,
	};
	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		emit("escape");
	} else if (e.key in next) {
		e.preventDefault();
		e.stopPropagation();
		all[next[e.key]]?.focus();
	}
}

defineExpose({ focusFirst });
</script>

<style lang="scss" scoped>
.chat-reaction-picker {
	position: absolute;
	z-index: 110;
	display: grid;
	grid-template-columns: repeat(var(--columns), var(--slot));
	padding: 1px;
	border: 1px solid var(--line-strong);
	border-radius: 18px;
	background: var(--surface-2);
	box-shadow: 0 6px 16px rgb(0 0 0 / 45%);
	pointer-events: auto;
	transform-origin: 20% 100%;
	animation: chat-reaction-menu-in 120ms cubic-bezier(0.16, 1, 0.3, 1);

	@media (prefers-reduced-motion: reduce) {
		animation: none;
	}
}

@keyframes chat-reaction-menu-in {
	from {
		opacity: 0;
		transform: scale(0.92) translateY(3px);
	}
}

.pick {
	position: relative;
	width: var(--slot);
	height: var(--row);
	border-radius: 999px;
	font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
	font-size: calc(var(--row) * 0.6);
	line-height: 1;
	cursor: pointer;
	touch-action: manipulation;
	transition: transform 120ms ease-out, background-color 120ms ease-out;

	&:hover {
		background: rgb(255 255 255 / 15%);
	}

	&[aria-pressed="true"] {
		background: color-mix(in srgb, var(--primary) 25%, var(--surface-2));
	}

	&:active {
		transform: scale(0.85);
	}

	&:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	@media (prefers-reduced-motion: reduce) {
		transition: none;
	}

	// A finger gets 44px of height from a row that looks smaller.
	@media (pointer: coarse) {
		&::after {
			content: "";
			position: absolute;
			inset: calc((var(--row) - 44px) / 2) 0;
		}

		// Two rows share an edge, so each grows away from the other and no tap lands on a neighbour.
		.stacked &.top-row::after {
			inset: calc(var(--row) - 44px) 0 0;
		}

		.stacked &:not(.top-row)::after {
			inset: 0 0 calc(var(--row) - 44px);
		}
	}
}
</style>

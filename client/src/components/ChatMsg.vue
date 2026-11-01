<template>
	<div
		:class="{
			message: true,
			recent,
			picking,
		}"
		data-chat-message
		:role="reactable ? 'group' : undefined"
		:tabindex="reactable ? 0 : undefined"
		:aria-label="reactable ? $t('chat.message-reactable') : undefined"
		@click="onClick"
		@keydown.enter.self.prevent.stop="emit('toggle-picker')"
		@keydown.space.self.prevent.stop="emit('toggle-picker')"
	>
		<div class="from" @click.stop="onClick">{{ msg.from.name }}</div>
		<div class="text" @click.stop="onClick">
			<ProcessedText :text="msg.text" @link-click="emit('link-click', $event)" />
		</div>
		<div
			v-if="reactions?.length"
			class="chips"
			role="group"
			:aria-label="$t('chat.reactions-for-message')"
		>
			<component
				:is="reactable ? 'button' : 'span'"
				v-for="chip in reactions"
				:key="chip.emoji"
				class="chip"
				:class="{ mine: chip.mine }"
				:type="reactable ? 'button' : undefined"
				:aria-pressed="reactable ? chip.mine : undefined"
				:aria-label="
					reactable
						? $t(chip.mine ? 'chat.reaction-remove' : 'chat.reaction-add', {
								emoji: chip.emoji,
								count: chip.count,
						  })
						: undefined
				"
				data-cy="chat-reaction"
				:data-emoji="chip.emoji"
				:data-mine="chip.mine"
				@click.stop="reactable && emit('set-reaction', chip.emoji, !chip.mine)"
				>{{ chip.emoji }} <span class="count">{{ $n(chip.count) }}</span></component
			>
		</div>
		<div
			v-if="picking"
			class="chat-reaction-picker"
			role="group"
			:aria-label="$t('room.reactions')"
			data-cy="chat-reaction-picker"
			@click.stop
		>
			<button
				v-for="emoji in REACTIONS"
				:key="emoji"
				type="button"
				class="pick"
				:aria-label="$t('room.react', { emoji })"
				:aria-pressed="isMine(emoji)"
				:data-cy="`chat-react-${emoji}`"
				@click="emit('set-reaction', emoji, !isMine(emoji))"
			>
				{{ emoji }}
			</button>
		</div>
	</div>
</template>

<script lang="ts" setup>
import ProcessedText from "@/components/ProcessedText.vue";
import type { ChatMessage } from "ott-common";
import { type ChatReactionCount, REACTIONS, type Reaction } from "ott-common/models/reactions";

const props = defineProps<{
	msg: ChatMessage;
	recent?: boolean;
	reactions?: ChatReactionCount[];
	/** The chat is open and this message can take reactions. Otherwise chips are only to look at. */
	reactable?: boolean;
	/** The row of emoji is showing under this message. */
	picking?: boolean;
}>();

const emit = defineEmits<{
	"link-click": [e: string];
	"toggle-picker": [];
	"set-reaction": [emoji: Reaction, add: boolean];
}>();

function isMine(emoji: Reaction): boolean {
	return props.reactions?.some(chip => chip.emoji === emoji && chip.mine) ?? false;
}

/**
 * On the name and text too, not only the message around them. A phone's browser moves a tap to the
 * nearest thing that takes taps, and with chips under the text that was a chip, even for a tap right
 * on the words. Chrome counts only the innermost elements with a click listener.
 */
function onClick(e: MouseEvent) {
	if (!props.reactable) {
		return;
	}
	// A link does its own thing, and dragging across the text to copy it ends in a click too.
	const onLink = e.target instanceof Element && e.target.closest("a");
	if (onLink || window.getSelection()?.toString()) {
		return;
	}
	emit("toggle-picker");
}
</script>

<style lang="scss" scoped>
.message {
	margin: 2px 0;
	padding: 6px 8px;
	opacity: 0;
	transition: all 1s ease;
	border-left: 2px solid transparent;

	&:first-child {
		margin-top: auto;
	}

	&.recent {
		opacity: 1;
		background: color-mix(in srgb, var(--surface-2) 60%, transparent);
		border-left-color: color-mix(in srgb, var(--signal) 60%, transparent);
		border-radius: 2px;
	}

	&[tabindex] {
		cursor: pointer;
		touch-action: manipulation;
		-webkit-tap-highlight-color: transparent;
	}

	&[tabindex]:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	&.picking {
		align-self: stretch;
		// The open chat makes recent messages transparent, and this one is being pointed at.
		background: color-mix(in srgb, var(--surface-2) 60%, transparent) !important;
	}

	.from,
	.text {
		display: inline;
		margin: 3px 5px;
		word-wrap: break-word;
		overflow-wrap: anywhere;
	}

	.text {
		color: var(--foreground);
	}

	.from {
		font-family: var(--font-mono);
		font-weight: 700;
		font-size: 0.8em;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--primary);
		margin-left: 0;
	}

	@media screen and (max-width: 600px) {
		font-size: 0.8em;
	}
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin: 4px 0 2px;
}

.chip {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 3px;
	min-width: 44px;
	height: 24px;
	padding: 0 7px;
	border: 1px solid var(--line-strong);
	border-radius: 999px;
	background: color-mix(in srgb, var(--surface-2) 85%, transparent);
	color: var(--foreground);
	font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
	font-size: 14px;
	line-height: 1;
	touch-action: manipulation;

	&.mine {
		border-color: var(--primary);
		background: color-mix(in srgb, var(--primary) 25%, var(--surface-2));
	}

	.count {
		font-family: var(--font-mono);
		font-size: 12px;
	}
}

button.chip {
	cursor: pointer;

	// Small to look at, 44px to hit. Downward, because above is the text, where a tap opens the row.
	&::after {
		content: "";
		position: absolute;
		inset: -4px 0 -16px;
	}

	&:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}
}

.chat-reaction-picker {
	display: flex;
	margin-top: 4px;
	max-width: 100%;
	border-radius: 999px;
	background: rgb(0 0 0 / 55%);
	overflow-x: auto;
	scrollbar-width: none;

	@media (pointer: fine) {
		flex-wrap: wrap;
	}
}

.pick {
	flex: none;
	width: 44px;
	height: 44px;
	border-radius: 999px;
	font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
	font-size: 20px;
	line-height: 1;
	cursor: pointer;
	touch-action: manipulation;
	transition: transform 120ms ease-out, background-color 120ms ease-out;

	&:hover,
	&[aria-pressed="true"] {
		background: rgb(255 255 255 / 15%);
	}

	&:active {
		transform: scale(0.85);
	}

	&:focus-visible {
		outline: 2px solid white;
		outline-offset: -2px;
	}

	@media (prefers-reduced-motion: reduce) {
		transition: none;
	}
}
</style>

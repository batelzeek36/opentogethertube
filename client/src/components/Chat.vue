<template>
	<div
		:class="{
			chat: true,
			activated: isActive,
		}"
	>
		<div class="chat-header" v-if="isActive">
			<Button
				v-if="!alwaysVisible"
				variant="ghost"
				size="icon-sm"
				@click="setActivated(false)"
				data-cy="chat-deactivate"
				:aria-label="$t('room.close-chat')"
			>
				<Icon :icon="mdiChevronDown" class="size-4" />
			</Button>
			<h4 class="label-mono text-primary">{{ $t("chat.title") }}</h4>
		</div>
		<div
			ref="messages"
			@scroll="onScroll"
			@mousedown="onMessagesMouseDown"
			class="messages grow"
		>
			<div class="grow"><!-- Spacer --></div>
			<transition-group name="message" @after-enter="enforceStickToBottom">
				<ChatMsg
					:msg="msg"
					:reactions="reactionsOf(msg)"
					:reactable="canReactTo(msg)"
					:picking="isPicking(msg)"
					v-for="(msg, index) in chatMessagePast"
					:key="index"
					@link-click="emit('link-click', $event)"
					@toggle-picker="togglePicker(msg)"
					@set-reaction="(emoji, add) => setReaction(msg, emoji, add)"
				/>
				<ChatMsg
					:msg="msg"
					:reactions="reactionsOf(msg)"
					:reactable="canReactTo(msg)"
					:picking="isPicking(msg)"
					recent
					v-for="(msg, index) in chatMessageRecent"
					:key="chatMessagePast.length + index"
					@link-click="emit('link-click', $event)"
					@toggle-picker="togglePicker(msg)"
					@set-reaction="(emoji, add) => setReaction(msg, emoji, add)"
				/>
			</transition-group>
		</div>
		<div v-if="!stickToBottom" class="to-bottom">
			<Button
				variant="signal"
				size="icon-sm"
				@click="forceToBottom"
				:aria-label="$t('room.scroll-chat-bottom')"
			>
				<Icon :icon="mdiChevronDoubleDown" class="size-4" />
			</Button>
		</div>
		<Transition name="input" @after-enter="enforceStickToBottom">
			<div class="input-box" v-if="isActive">
				<Input
					class="w-full font-mono"
					:placeholder="$t('chat.type-here')"
					@keydown="onInputKeyDown"
					v-model="inputValue"
					autocomplete="off"
					ref="chatInput"
					@blur="deactivateOnBlur && setActivated(false)"
					data-cy="chat-input"
				/>
			</div>
		</Transition>
		<div class="manual-activate" v-if="!isActive">
			<Button
				variant="ghost"
				size="icon"
				@click="setActivated(true, true)"
				data-cy="chat-activate"
				:class="{ 'chat-has-unread': chatUnread > 0 }"
				:aria-label="
					chatUnread > 0
						? $t('room.open-chat-unread', { count: chatUnread })
						: $t('room.open-chat')
				"
			>
				<Icon :icon="mdiCommentOutline" class="size-5" />
				<span v-if="chatUnread > 0" class="chat-unread" data-cy="chat-unread">
					{{ chatUnread > 99 ? "99+" : chatUnread }}
				</span>
			</Button>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { mdiChevronDown, mdiChevronDoubleDown, mdiCommentOutline } from "@mdi/js";
import { computed, onUpdated, ref, type Ref, nextTick, onMounted, onUnmounted, watch } from "vue";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";
import { useRoomApi } from "@/util/roomapi";
import type { ServerMessageChat, ServerMessageChatReactions } from "ott-common/models/messages";
import type { ChatMessageId, Reaction } from "ott-common/models/reactions";
import type { ChatMessage } from "ott-common/models/types";
import { useGrants } from "@/components/composables/grants";
import { useRoomKeyboardShortcuts } from "@/util/keyboard-shortcuts";
import ChatMsg from "./ChatMsg.vue";
import {
	applyChatReactions,
	chatMessagePast,
	chatMessageRecent,
	chatOpen,
	chatReactions,
	chatReactionsClosed,
	chatUnread,
} from "./chat-state";

const MSG_SHOW_TIMEOUT = 20000;
const KEYBOARD_MIN_HEIGHT = 100;
const STICK_DISTANCE_PX = 8;
/** Same test as the typing view: a finger, and so a phone keyboard that a lost focus would close. */
const isTouch = window.matchMedia?.("(pointer: coarse)").matches ?? false;

const emit = defineEmits(["link-click"]);
const props = defineProps({
	alwaysVisible: {
		type: Boolean,
		default: false,
	},
});

const connection = useConnection();
const store = useStore();
const roomapi = useRoomApi(connection);

const granted = useGrants();

const inputValue = ref("");
const stickToBottom = ref(true);
/** The message whose row of emoji is showing. */
const pickerFor = ref<ChatMessageId | null>(null);
let lastScrollTop = 0;
/**
 * When chat is activated, all messages are shown. and the
 * user can scroll through message history, type in chat, etc.
 * When chat is NOT activated, when messages are received,
 * they appear and fade away after `MSG_SHOW_TIMEOUT` ms.
 */
const activated = ref(false);
const isActive = computed(() => activated.value || props.alwaysVisible);
const deactivateOnBlur = ref(false);
const messages = ref();
watch(isActive, active => {
	if (!active) {
		pickerFor.value = null;
	}
});
const chatInput: Ref<{ $el?: HTMLInputElement } | HTMLInputElement | undefined> = ref();

/** Resolve the underlying <input> element whether chatInput holds a component instance or the DOM node. */
function getChatInputEl(): HTMLInputElement | undefined {
	const c = chatInput.value as { $el?: HTMLInputElement } | HTMLInputElement | undefined;
	if (!c) {
		return undefined;
	}
	if (c instanceof HTMLElement) {
		return c as HTMLInputElement;
	}
	return c.$el;
}

const shortcuts = useRoomKeyboardShortcuts();
onMounted(() => {
	connection.addMessageHandler("chat", onChatReceived);
	connection.addMessageHandler("chat-reactions", onChatReactions);
	window.addEventListener("pointerdown", onPointerDownAnywhere);
	window.visualViewport?.addEventListener("resize", onViewportResize);
	if (shortcuts) {
		shortcuts.bind({ code: "KeyT" }, () => setActivated(true, false));
	} else {
		console.warn("No keyboard shortcuts available");
	}
});

onUnmounted(() => {
	connection.removeMessageHandler("chat", onChatReceived);
	connection.removeMessageHandler("chat-reactions", onChatReactions);
	window.removeEventListener("pointerdown", onPointerDownAnywhere);
	window.visualViewport?.removeEventListener("resize", onViewportResize);
	chatOpen.value = false;
});

function focusChatInput() {
	getChatInputEl()?.focus();
}

/**
 * A phone's browser scrolls the page to keep the input above the keyboard and leaves it there
 * when the keyboard closes, with the top of the video stuck under the sticky header.
 */
let scrollBeforeChat: number | null = null;
function restoreScroll() {
	if (scrollBeforeChat !== null) {
		window.scrollTo({ top: scrollBeforeChat });
	}
}
let viewportHeight = window.visualViewport?.height ?? 0;
function onViewportResize() {
	const height = window.visualViewport?.height ?? 0;
	const keyboardClosed = height - viewportHeight > KEYBOARD_MIN_HEIGHT;
	viewportHeight = height;
	if (keyboardClosed && activated.value) {
		restoreScroll();
	}
}

async function setActivated(value: boolean, manual = false): Promise<void> {
	if (!value && props.alwaysVisible) {
		return;
	}
	if (value && !activated.value) {
		scrollBeforeChat = window.scrollY;
	}
	activated.value = value;
	chatOpen.value = value;
	if (value) {
		chatUnread.value = 0;
	}
	if (!value) {
		restoreScroll();
		scrollBeforeChat = null;
	}
	if (value) {
		if (manual) {
			deactivateOnBlur.value = false;
		} else {
			deactivateOnBlur.value = true;
		}
		await nextTick();
		focusChatInput();
	} else {
		getChatInputEl()?.blur();
		forceToBottom();
	}
}

function onChatReceived(msg: ServerMessageChat): void {
	chatMessageRecent.value.push(msg);
	if (!isActive.value && msg.from.id !== store.state.users.you.id) {
		chatUnread.value += 1;
	}
	setTimeout(expireChatMessage, MSG_SHOW_TIMEOUT);
	nextTick(enforceStickToBottom);
}

function onChatReactions(msg: ServerMessageChatReactions): void {
	applyChatReactions(msg);
	if (pickerFor.value !== null && chatReactionsClosed.value.has(pickerFor.value)) {
		pickerFor.value = null;
	}
	nextTick(enforceStickToBottom);
}

function reactionsOf(msg: ChatMessage) {
	return msg.id === undefined ? undefined : chatReactions.value.get(msg.id);
}

/** Only while the chat is open. A message floating over the video is just to be read. */
function canReactTo(msg: ChatMessage): boolean {
	return (
		isActive.value &&
		msg.id !== undefined &&
		!chatReactionsClosed.value.has(msg.id) &&
		granted("chat")
	);
}

function isPicking(msg: ChatMessage): boolean {
	return msg.id !== undefined && msg.id === pickerFor.value && canReactTo(msg);
}

async function togglePicker(msg: ChatMessage) {
	pickerFor.value = isPicking(msg) ? null : msg.id ?? null;
	await nextTick();
	revealPicker();
}

/** The chat can be short enough that opening the row would leave it below the fold. */
function revealPicker() {
	const list = messages.value as HTMLDivElement | undefined;
	const row = list?.querySelector<HTMLElement>("[data-cy='chat-reaction-picker']");
	// A phone's typing view takes the row out of the list and lays it over the video.
	if (!list || !row || getComputedStyle(row).position === "absolute") {
		return;
	}
	const overflow = row.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
	if (overflow > 0) {
		list.scrollTop += overflow;
	}
}

function setReaction(msg: ChatMessage, emoji: Reaction, add: boolean) {
	if (msg.id === undefined) {
		return;
	}
	roomapi.reactToChat(msg.id, emoji, add);
	pickerFor.value = null;
	// With a mouse, the click moved focus off the input, and typing should carry on regardless.
	if (!isTouch && activated.value) {
		focusChatInput();
	}
}

function onPointerDownAnywhere(e: PointerEvent) {
	if (
		pickerFor.value !== null &&
		!(e.target instanceof Element && e.target.closest("[data-chat-message]"))
	) {
		pickerFor.value = null;
	}
}

/**
 * Tapping a message must not take focus from the input: that would close a phone's keyboard, or
 * close a chat opened with the keyboard shortcut. A mouse otherwise keeps its usual way of selecting
 * text in a chat that stays open.
 */
function onMessagesMouseDown(e: MouseEvent) {
	if (isActive.value && (isTouch || deactivateOnBlur.value)) {
		e.preventDefault();
	}
}

function expireChatMessage() {
	chatMessagePast.value.push(chatMessageRecent.value.splice(0, 1)[0]);
}

/**
 * Performs the necessary actions to enact the stickToBottom behavior.
 */
function enforceStickToBottom() {
	const div = messages.value as HTMLDivElement;
	if (!div) {
		return;
	}
	if (stickToBottom.value) {
		div.scrollTop = div.scrollHeight;
	}
}

function onInputKeyDown(e: KeyboardEvent): void {
	if (e.key === "Enter") {
		e.preventDefault();
		if (inputValue.value.trim() !== "") {
			roomapi.chat(inputValue.value);
		}
		inputValue.value = "";
		stickToBottom.value = true;
		setActivated(false);
	} else if (e.key === "Escape") {
		e.preventDefault();
		setActivated(false);
	}
}

function onScroll() {
	const div = messages.value as HTMLDivElement;
	if (!div) {
		return;
	}
	const distToBottom = div.scrollHeight - div.clientHeight - div.scrollTop;
	/*
	 * Only the reader scrolling up stops the chat following. A message animating in and a phone's
	 * fractional scroll position both leave a small distance without anyone having scrolled.
	 */
	if (distToBottom <= STICK_DISTANCE_PX) {
		stickToBottom.value = true;
	} else if (div.scrollTop < lastScrollTop) {
		stickToBottom.value = false;
	}
	lastScrollTop = div.scrollTop;
}

function forceToBottom() {
	stickToBottom.value = true;
	enforceStickToBottom();
}

onUpdated(enforceStickToBottom);
</script>

<style lang="scss" scoped>
.chat {
	display: flex;
	flex-direction: column;
	margin: 4px;
	padding: 3px;
	transition: all 0.2 ease;
	pointer-events: none;
	height: 100%;

	&.activated {
		background: color-mix(in srgb, var(--background) 82%, transparent);
		backdrop-filter: blur(6px);
		border: 1px solid var(--line-strong);
		border-radius: 4px;
		pointer-events: auto;
	}
}

.activated {
	.message {
		opacity: 1;

		&.recent {
			background: transparent;
			transition-duration: 0.2s;
		}
	}

	.messages {
		overflow-y: auto;
		pointer-events: auto;
	}
}

.chat-header {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 6px;
	padding-bottom: 4px;
	border-bottom: 1px solid var(--line-strong);

	h4 {
		margin: 0;
	}
}

.input-box {
	display: flex;
	justify-self: end;
	flex-shrink: 1;
	height: 40px;
}

.grow {
	display: flex;
	flex-grow: 1;
}

.messages {
	display: flex;
	flex-direction: column;
	flex-basis: 0;

	margin-top: 8px;

	overflow: hidden;
	pointer-events: none;

	align-items: baseline;
}

.chat-has-unread {
	position: relative;
	overflow: visible;
	color: var(--primary);
	filter: drop-shadow(0 0 6px var(--primary));
	animation: chat-unread-glow 1.6s ease-in-out infinite;
}

.chat-unread {
	position: absolute;
	top: -2px;
	right: -4px;
	min-width: 18px;
	height: 18px;
	padding: 0 4px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 700;
	line-height: 18px;
	text-align: center;
	color: var(--primary-foreground);
	background: var(--primary);
}

@keyframes chat-unread-glow {
	50% {
		filter: drop-shadow(0 0 14px var(--primary));
	}
}

@media (prefers-reduced-motion: reduce) {
	.chat-has-unread {
		animation: none;
	}
}

.manual-activate {
	display: flex;
	align-self: flex-end;
	justify-self: end;
	pointer-events: auto;
}

.to-bottom {
	display: flex;
	justify-content: start;
	width: 100%;
	pointer-events: auto;
	margin: 6px 0;
	position: absolute;
	bottom: 42px;
	z-index: 100;
}

// Transition animation
.message-enter-active,
.message-leave-active {
	transition: all 0.2s;
}
.message-enter,
.message.leave-to {
	opacity: 0;
	transform: translateX(-30px) scaleY(0);
}
.message-move {
	transition: transform 0.2s;
}

.input-enter-active,
.input-leave-active {
	transition: all 0.2s ease;
}
.input-enter,
.input-leave-to {
	opacity: 0;
	transform: translateY(-30px) scaleY(0);
	height: 0;
}
</style>

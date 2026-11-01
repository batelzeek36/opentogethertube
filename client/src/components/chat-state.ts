import { ref, type Ref } from "vue";
import type { ChatMessage } from "ott-common/models/types";

/*
 * Chat can move between in-video and outside-video containers, which remounts the component.
 * Keep message history outside the component instance so it survives that move.
 */

/**
 * All past chat messages. They are are no longer
 * shown when deactivated.
 */
export const chatMessagePast: Ref<ChatMessage[]> = ref([]);

/**
 * All recent chat messages that are currently shown when deactivated.
 * They will fade away after `MSG_SHOW_TIMEOUT` ms, and moved into `chatMessagePast`.
 */
export const chatMessageRecent: Ref<ChatMessage[]> = ref([]);

/** True while the chat is open for typing, so the reaction bar can give up its space on narrow screens. */
export const chatOpen: Ref<boolean> = ref(false);

/** Messages from other people that arrived while the chat was closed. */
export const chatUnread: Ref<number> = ref(0);

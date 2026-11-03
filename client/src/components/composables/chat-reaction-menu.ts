import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { type ChatMessageId, REACTIONS } from "ott-common/models/reactions";
import {
	MOUSE_SIZING,
	placeReactionMenu,
	TOUCH_SIZING,
	type MenuPlacement,
} from "@/components/chat-reaction-menu-placement";

/** Long enough that a mouse crossing the chat on its way somewhere opens nothing. */
const HOVER_OPEN_MS = 90;
/** Long enough to cross the gap from the message to a button that is off to one side of it. */
const HOVER_CLOSE_MS = 180;

/** How far the mouse moves before it counts as having gone somewhere after a dismissal. */
const REST_DISTANCE_PX = 12;

/** What opened the menu decides what closes it: only one opened by a mouse minds the mouse. */
type MenuOpener = "mouse" | "tap" | "keyboard";

function samePlacement(a: MenuPlacement | null, b: MenuPlacement): boolean {
	return (
		a !== null &&
		a.left === b.left &&
		a.top === b.top &&
		a.slot === b.slot &&
		a.columns === b.columns &&
		a.rowHeight === b.rowHeight
	);
}

/**
 * The one reaction menu of a chat: which message it is on, and where on the screen that puts it.
 * There is a single place to hold the message, so two menus cannot be open.
 */
export function useChatReactionMenu(
	root: Ref<HTMLElement | undefined>,
	list: Ref<HTMLElement | undefined>,
) {
	const openFor = ref<ChatMessageId | null>(null);
	const openedBy = ref<MenuOpener | null>(null);
	const placement = ref<MenuPlacement | null>(null);

	let lastPointer: string | null = null;
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let mouseAt = { x: 0, y: 0 };
	/**
	 * Where the mouse was when it dismissed the menu. The browser reports the mouse entering whatever
	 * the menu leaves under it, and that is not the person pointing at it. Null once it has moved on.
	 */
	let restingAt: { x: number; y: number } | null = null;
	let resizeObserver: ResizeObserver | undefined;

	function cancelTimers() {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
	}

	function messageElement(id: ChatMessageId): HTMLElement | undefined {
		const elements = list.value?.querySelectorAll<HTMLElement>("[data-chat-message]") ?? [];
		return Array.from(elements).find(el => el.dataset.messageId === id);
	}

	const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
	function usesFinger(): boolean {
		return coarsePointer || lastPointer === "touch";
	}

	/** Measures again, and shuts the menu if its message has scrolled out of the list. */
	function reposition() {
		if (openFor.value === null) {
			return;
		}
		const message = messageElement(openFor.value)?.getBoundingClientRect();
		const listBox = list.value?.getBoundingClientRect();
		const chatBox = root.value?.getBoundingClientRect();
		if (!message || !listBox || !chatBox || !root.value) {
			close();
			return;
		}
		if (message.bottom < listBox.top || message.top > listBox.bottom) {
			close();
			return;
		}
		const visual = window.visualViewport;
		const left = visual?.offsetLeft ?? 0;
		const top = visual?.offsetTop ?? 0;
		const next = placeReactionMenu(
			REACTIONS.length,
			usesFinger() ? TOUCH_SIZING : MOUSE_SIZING,
			{
				message,
				list: listBox,
				chat: chatBox,
				viewport: {
					left,
					top,
					right: left + (visual?.width ?? window.innerWidth),
					bottom: top + (visual?.height ?? window.innerHeight),
				},
			},
		);
		// The menu is positioned inside the chat, whose border is outside that coordinate space.
		const inChat = {
			...next,
			left: next.left - chatBox.left - root.value.clientLeft,
			top: next.top - chatBox.top - root.value.clientTop,
		};
		if (!samePlacement(placement.value, inChat)) {
			placement.value = inChat;
		}
	}

	function open(id: ChatMessageId, by: MenuOpener) {
		cancelTimers();
		openFor.value = id;
		openedBy.value = by;
		reposition();
	}

	function close() {
		cancelTimers();
		openFor.value = null;
		openedBy.value = null;
		placement.value = null;
	}

	/** Shut, and it stays shut while the mouse rests where it is. */
	function dismiss() {
		if (openedBy.value === "mouse") {
			restingAt = mouseAt;
		}
		close();
	}

	function mouseEnteredMessage(id: ChatMessageId) {
		clearTimeout(openTimer);
		if (restingAt) {
			return;
		}
		lastPointer = "mouse";
		if (openFor.value === id) {
			clearTimeout(closeTimer);
		} else if (openFor.value === null) {
			openTimer = setTimeout(() => open(id, "mouse"), HOVER_OPEN_MS);
		} else if (openedBy.value === "mouse") {
			open(id, "mouse");
		}
	}

	function scheduleMouseClose() {
		if (openedBy.value === "mouse") {
			clearTimeout(closeTimer);
			closeTimer = setTimeout(close, HOVER_CLOSE_MS);
		}
	}

	function mouseLeftMessage(id: ChatMessageId) {
		clearTimeout(openTimer);
		if (openFor.value === id) {
			scheduleMouseClose();
		}
	}

	function mouseEnteredMenu() {
		clearTimeout(closeTimer);
	}

	function tapped(id: ChatMessageId) {
		if (openFor.value !== id) {
			restingAt = null;
			open(id, lastPointer === "mouse" ? "mouse" : "tap");
		} else if (openedBy.value !== "mouse") {
			close();
		}
	}

	function keyPressed(id: ChatMessageId) {
		if (openFor.value === id && openedBy.value === "keyboard") {
			close();
		} else {
			open(id, "keyboard");
		}
	}

	function onPointerDown(e: PointerEvent) {
		lastPointer = e.pointerType;
		const onMessageOrMenu =
			e.target instanceof Element &&
			e.target.closest("[data-chat-message], [data-cy='chat-reaction-picker']");
		if (openFor.value !== null && !onMessageOrMenu) {
			close();
		}
	}

	function onPointerMove(e: PointerEvent) {
		if (e.pointerType !== "mouse") {
			return;
		}
		mouseAt = { x: e.clientX, y: e.clientY };
		if (
			restingAt &&
			Math.hypot(mouseAt.x - restingAt.x, mouseAt.y - restingAt.y) >= REST_DISTANCE_PX
		) {
			restingAt = null;
		}
	}

	onMounted(() => {
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("pointermove", onPointerMove, { passive: true });
		window.addEventListener("resize", reposition);
		window.visualViewport?.addEventListener("resize", reposition);
		if (typeof ResizeObserver !== "undefined" && list.value) {
			resizeObserver = new ResizeObserver(reposition);
			resizeObserver.observe(list.value);
		}
	});

	onUnmounted(() => {
		cancelTimers();
		window.removeEventListener("pointerdown", onPointerDown);
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("resize", reposition);
		window.visualViewport?.removeEventListener("resize", reposition);
		resizeObserver?.disconnect();
	});

	return {
		openFor,
		openedBy,
		placement,
		close,
		dismiss,
		reposition,
		mouseEnteredMessage,
		mouseLeftMessage,
		mouseEnteredMenu,
		mouseLeftMenu: scheduleMouseClose,
		tapped,
		keyPressed,
	};
}

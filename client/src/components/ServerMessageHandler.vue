<template>
	<span></span>
</template>

<script lang="ts" setup>
import { onUnmounted } from "vue";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";
import { detectDeviceType } from "@/util/device-type";
import { useRoomApi } from "@/util/roomapi";

const store = useStore();
const connection = useConnection();
const roomapi = useRoomApi(connection);
const device = detectDeviceType();

connection.addMessageHandler("sync", msg => {
	store.dispatch("room/sync", msg);
});
connection.addMessageHandler("chat", msg => {
	store.dispatch("chat", msg);
});
connection.addMessageHandler("announcement", msg => {
	store.dispatch("announcement", msg);
});
connection.addMessageHandler("user", msg => {
	store.dispatch("users/user", msg);
});
connection.addMessageHandler("you", msg => {
	store.dispatch("users/you", msg);
	// "you" comes once this client is in the room, on every connect, so the server has a user to attach this to.
	if (device) {
		roomapi.reportDevice(device);
	}
});
connection.addMessageHandler("event", msg => {
	store.dispatch("event", msg);
});
connection.addMessageHandler("eventcustom", msg => {
	store.dispatch("eventcustom", msg);
});

onUnmounted(() => connection.clearAllMessageHandlers());
</script>

<template>
	<Button
		variant="ghost"
		class="movie-only-button"
		data-cy="movie-only-toggle"
		@click="emit('click')"
	>
		<Icon :icon="mdiMovieOpenOutline" class="size-4" />
		{{ $t("room.movie-only") }}
	</Button>
</template>

<script lang="ts" setup>
import { mdiMovieOpenOutline } from "@mdi/js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const emit = defineEmits<{ click: [] }>();
</script>

<style scoped>
/* Over the picture's top corner, on the same dark backing as the reaction bar. */
.movie-only-button {
	position: absolute;
	top: 10px;
	right: 10px;
	z-index: 40;
	padding-inline: 12px;
	background: rgb(0 0 0 / 55%);
	backdrop-filter: blur(6px);
	color: #fff;
	touch-action: manipulation;
}

.movie-only-button:hover {
	background: rgb(0 0 0 / 75%);
	color: #fff;
}
</style>

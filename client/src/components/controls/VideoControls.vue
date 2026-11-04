<template>
	<div class="video-controls-wrapper">
		<div
			:class="{
				'video-controls': true,
				'in-video': mode === 'in-video',
				'outside-video relative rounded-b-md': mode === 'outside-video',
				'hide': !controlsVisible,
			}"
		>
			<VideoProgressSlider :current-position="sliderPosition" />
			<div class="controls-row2" :class="{ 'pinned-fullscreen': pinFullscreen }">
				<BasicControls :current-position="truePosition" />
				<VolumeControl />
				<TimestampDisplay :current-position="truePosition" data-cy="timestamp-display" />
				<div class="grow"><!-- Spacer --></div>
				<ClosedCaptionsSwitcher />
				<PlaybackRateSwitcher />
				<VideoSettings />
				<PictureInPictureButton />
				<LayoutSwitcher />
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import BasicControls from "./BasicControls.vue";
import ClosedCaptionsSwitcher from "./ClosedCaptionsSwitcher.vue";
import LayoutSwitcher from "./LayoutSwitcher.vue";
import TimestampDisplay from "./TimestampDisplay.vue";
import VideoProgressSlider from "./VideoProgressSlider.vue";
import VolumeControl from "./VolumeControl.vue";
import PlaybackRateSwitcher from "./PlaybackRateSwitcher.vue";
import VideoSettings from "./VideoSettings.vue";
import PictureInPictureButton from "./PictureInPictureButton.vue";
import { elementFullscreenAvailable } from "@/components/composables/fullscreen";

withDefaults(
	defineProps<{
		sliderPosition: number;
		truePosition: number;
		controlsVisible: boolean;
		mode: "in-video" | "outside-video";
	}>(),
	{
		controlsVisible: false,
		mode: "in-video",
	},
);

/** Without a browser fullscreen this row's button is the only way in, so it has to stay on screen. */
const pinFullscreen = !elementFullscreenAvailable();
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "./media-controls.scss";

.grow {
	flex-grow: 1;
}

.video-controls {
	min-height: media-controls.$video-controls-height;
	transition: all 0.2s;
	z-index: 100;
	padding: 12px;
	width: 100%;

	&.in-video {
		position: absolute;
		bottom: 0;

		background: linear-gradient(
			to top,
			color-mix(in srgb, var(--ink) 78%, transparent),
			color-mix(in srgb, var(--ink) 0%, transparent)
		);
		transition: all 0.2s;

		&.hide {
			opacity: 0;
			transition: all 0.5s;
			bottom: 0;
		}
	}

	&.outside-video {
		background: var(--ink);

		&.hide {
			opacity: 0;
			transform: scaleY(0) translateY(-50%);
			transition: all 0.5s;
			height: 0;
		}
	}

	.controls-row2 {
		display: flex;
		align-items: center;
	}

	// An iPhone's row is wider than its screen: the rest scrolls sideways under the fullscreen button.
	@media (max-width: 760px) {
		.controls-row2.pinned-fullscreen {
			overflow-x: auto;
			scrollbar-width: none;

			.fullscreen-toggle {
				position: sticky;
				right: 0;
				border-radius: 999px;
				background: rgb(0 0 0 / 55%);
				backdrop-filter: blur(6px);
			}
		}
	}
}
</style>

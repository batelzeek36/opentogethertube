<template>
	<div class="direct">
		<video
			ref="videoElem"
			preload="auto"
			crossorigin="anonymous"
			@canplay="onCanPlay"
			@playing="onPlaying"
			@pause="onPaused"
			@play="onWaiting"
			@waiting="onVideoWaiting"
			@stalled="onBuffering"
			@loadstart="onBuffering"
			@progress="onProgress"
			@ended="onEnd"
			@error="onError"
		>
			<track
				v-for="track in vttSources"
				:key="track.url"
				kind="subtitles"
				:src="track.url"
				:srclang="track.srclang"
				:label="track.name"
				:default="track.default"
			/>
		</video>
		<canvas ref="subtitleCanvas" v-show="assVisible" class="jassub-canvas" />
	</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import JASSUB from "jassub";
import jassubWorkerUrl from "jassub/dist/worker/worker.js?url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import type { CustomMediaManifest } from "ott-common/models/zod-schemas.js";
import { getSubtitleFormatFromUrl, type SubtitleFormat } from "ott-common/subtitles.js";
import type {
	MediaPlayerWithAudioBoost,
	MediaPlayerWithCaptions,
	MediaPlayerWithPlaybackRate,
	MediaPlayerWithQuality,
	MediaPlayerWithSyncRate,
} from "../composables";
import { useCaptions, useMediaAudioBoost, useQualities } from "../composables";
import {
	currentDeviceInfo,
	deviceMaxQuality,
	loadQualityChoice,
	loadRecentSpeed,
	measureSpeed,
	nextLowerSource,
	pickAutoSource,
	saveQualityChoice,
	saveRecentSpeed,
	sourceForHeight,
	StallWatch,
} from "@/util/direct-quality";

interface Props {
	service: string;
	videoUrl: string;
	videoMime: string;
	thumbnail?: string;
	subtitleUrl?: string;
}

interface SubtitleSource {
	url: string;
	format: SubtitleFormat;
	name?: string;
	srclang?: string;
	default?: boolean;
}

const props = defineProps<Props>();
const { videoUrl, videoMime, thumbnail, subtitleUrl } = toRefs(props);
const videoElem = ref<HTMLVideoElement | undefined>();
const subtitleCanvas = ref<HTMLCanvasElement | undefined>();
const assVisible = ref(false);
const captions = useCaptions();
const audioBoost = useMediaAudioBoost(videoElem);
const qualities = useQualities();
const manifest = ref<CustomMediaManifest | null>(null);
/** The manifest source playing right now, also while on Auto. */
let activeSource = -1;
let measuredSpeed: number | null = null;
const stallWatch = new StallWatch();
/** Bumped by each load, so one that was waiting on the speed check knows it was replaced. */
let loadGeneration = 0;
/** Undoes the "resume here" waiting on a file that was switched away from before it loaded. */
let pendingResume: AbortController | null = null;

// kept outside subtitleSources's computed() factory to dodge a noVueRefAsOperand false
// positive: biome's nursery rule flags property access on nested callback params when the
// callback lives directly inside a computed(), mistaking plain manifest data for a ref
function textTracksToSubtitleSources(
	tracks: NonNullable<CustomMediaManifest["textTracks"]>,
): SubtitleSource[] {
	return tracks.map(track => ({
		url: track.url,
		format: track.contentType === "text/x-ssa" ? "ass" : "vtt",
		name: track.name,
		srclang: track.srclang,
		default: track.default,
	}));
}

function isVttSource(track: SubtitleSource): boolean {
	return track.format === "vtt";
}

// unifies manifest text tracks and the single legacy subtitleUrl prop into one indexable list,
// used to render native <track> elements (vtt) and to drive the jassub renderer (ass)
const subtitleSources = computed<SubtitleSource[]>(() => {
	if (videoMime.value === "application/json") {
		return textTracksToSubtitleSources(manifest.value?.textTracks ?? []);
	}
	if (!subtitleUrl.value) {
		return [];
	}
	return [
		{
			url: subtitleUrl.value,
			format: getSubtitleFormatFromUrl(subtitleUrl.value) ?? "vtt",
			default: true,
		},
	];
});
const vttSources = computed(() => subtitleSources.value.filter(isVttSource));

// maps an index into subtitleSources to the corresponding index in videoElem.textTracks,
// counting only the vtt entries that precede it (ass tracks don't get a native <track>)
function nativeTrackIndex(sourceIndex: number): number {
	let count = 0;
	for (let i = 0; i < sourceIndex; i++) {
		if (subtitleSources.value[i]?.format === "vtt") {
			count++;
		}
	}
	return count;
}

// created lazily on first ASS use, then kept alive for the component's lifetime: its canvas
// can only be transferred to the worker once, so VTT<->ASS toggles and ASS->ASS track changes
// reuse this instance instead of tearing it down and rebuilding a new worker
let jassubInstance: JASSUB | null = null;

function destroyJassub() {
	const inst = jassubInstance;
	jassubInstance = null;
	assVisible.value = false;
	if (inst) {
		inst.destroy().catch(e => {
			console.error("DirectPlayer: error destroying jassub:", e);
		});
	}
}

// every track change is chained onto this promise, so switches always run in the order they
// were requested and the last one wins, instead of racing on the async jassub calls below
let trackQueue: Promise<void> = Promise.resolve();

function applyActiveTrack(idx: number, enabled: boolean): Promise<void> {
	// caught here (not left to the caller) so a failed switch doesn't reject the shared chain
	// and skip every switch queued after it
	trackQueue = trackQueue
		.then(() => doApplyTrack(idx, enabled))
		.catch(e => {
			console.error("DirectPlayer: failed to apply subtitle track:", e);
		});
	return trackQueue;
}

async function doApplyTrack(idx: number, enabled: boolean) {
	const source = idx >= 0 ? subtitleSources.value[idx] : undefined;

	if (videoElem.value) {
		for (let i = 0; i < videoElem.value.textTracks.length; i++) {
			videoElem.value.textTracks[i].mode = "hidden";
		}
	}

	if (source?.format === "ass" && enabled) {
		if (!videoElem.value || !subtitleCanvas.value) {
			return;
		}
		if (!jassubInstance) {
			jassubInstance = new JASSUB({
				video: videoElem.value,
				canvas: subtitleCanvas.value,
				subUrl: source.url,
				workerUrl: jassubWorkerUrl,
				wasmUrl: jassubWasmUrl,
				modernWasmUrl: jassubModernWasmUrl,
				// fall back to remote font queries so styles using fonts not installed
				// locally (e.g. CJK/decorative fonts) still render instead of falling
				// back to the default font
				queryFonts: "localandremote",
			});
			await jassubInstance.ready;
		} else {
			await jassubInstance.ready;
			await jassubInstance.renderer.setTrackByUrl(source.url);
		}
		assVisible.value = true;
		return;
	}

	assVisible.value = false;
	if (jassubInstance) {
		await jassubInstance.ready;
		jassubInstance.renderer.freeTrack();
	}
	if (source?.format === "vtt" && enabled && videoElem.value) {
		const track = videoElem.value.textTracks[nativeTrackIndex(idx)];
		if (track) {
			track.mode = "showing";
		}
	}
}

const emit = defineEmits<{
	"apiready": [];
	"ready": [];
	"playing": [];
	"paused": [];
	"waiting": [];
	"buffering": [];
	"error": [];
	"end": [];
	"buffer-progress": [progress: number];
	"buffer-spans": [spans: TimeRanges];
}>();

function play() {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	return videoElem.value.play();
}

function pause() {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	videoElem.value.pause();
}

function setVolume(volume: number) {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	videoElem.value.volume = volume / 100;
}

function getPosition() {
	if (!videoElem.value) {
		console.error("player not ready");
		return 0;
	}
	return videoElem.value.currentTime;
}

function setPosition(position: number) {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	videoElem.value.currentTime = position;
}

function isCaptionsSupported(): boolean {
	return true;
}

function setCaptionsEnabled(enabled: boolean): void {
	if (!videoElem.value || captions.currentTrack.value === null) {
		return;
	}
	if (subtitleSources.value.length === 0) {
		return;
	}
	let idx = captions.currentTrack.value;
	if (idx === -1) {
		if (!enabled) {
			return;
		}
		idx = 0;
		captions.currentTrack.value = 0;
	}
	if (idx >= subtitleSources.value.length) {
		console.warn("DirectPlayer: invalid captions track index:", idx);
		return;
	}
	applyActiveTrack(idx, enabled);
}

function isCaptionsEnabled(): boolean {
	if (!videoElem.value) {
		return false;
	}
	if (assVisible.value) {
		return true;
	}
	return Array.from(videoElem.value.textTracks).find(t => t.mode === "showing") !== undefined;
}

function getCaptionsTracks(): CaptionTrack[] {
	return subtitleSources.value.map(track => ({
		kind: "subtitles",
		label: track.name,
		srclang: track.srclang,
		default: track.default,
	}));
}

function setCaptionsTrack(track: number): void {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	console.log("DirectPlayer: setCaptionsTrack:", track);
	captions.currentTrack.value = track;
	applyActiveTrack(track, true);
}

function isQualitySupported(): boolean {
	return manifest.value !== null && manifest.value.sources.length > 1;
}

function getVideoTracks(): VideoTrack[] {
	if (!manifest.value) {
		return [];
	}
	return manifest.value.sources.map(s => ({
		label: s.quality,
		width: 0,
		height: s.quality,
	}));
}

function setVideoTrack(idx: number): void {
	if (!manifest.value || !videoElem.value) {
		return;
	}
	if (idx === -1) {
		saveQualityChoice(null);
		switchToSource(autoSource());
		return;
	}
	const source = manifest.value.sources[idx];
	if (!source) {
		return;
	}
	saveQualityChoice(source.quality);
	switchToSource(idx);
	qualities.currentVideoTrack.value = idx;
}

function autoSource(): number {
	return pickAutoSource(
		manifest.value?.sources ?? [],
		measuredSpeed,
		deviceMaxQuality(currentDeviceInfo()),
	);
}

/** Starts a source playing from the file's beginning, for a new video. */
function startSource(idx: number): void {
	const source = manifest.value?.sources[idx];
	if (!source || !videoElem.value) {
		return;
	}
	activeSource = idx;
	qualities.currentActiveQuality.value = idx;
	stallWatch.loaded(performance.now());
	videoElem.value.src = source.url;
}

/** Moves to another size of the same video, carrying on from the same spot. */
function switchToSource(idx: number): void {
	const video = videoElem.value;
	if (!video || idx === activeSource) {
		return;
	}
	const resumeAt = video.currentTime;
	const wasPlaying = !video.paused;
	startSource(idx);
	video.load();
	pendingResume?.abort();
	pendingResume = new AbortController();
	// Until the new file's metadata is in, a browser may drop a new position. The room's sync then
	// fine-tunes from here, since time has passed while this file loaded.
	video.addEventListener(
		"loadedmetadata",
		() => {
			video.currentTime = resumeAt;
			if (wasPlaying) {
				video.play().catch(e => {
					console.error("DirectPlayer: error resuming after quality switch:", e);
				});
			}
		},
		{ once: true, signal: pendingResume.signal },
	);
}

/** Moves to the next size down if this viewer is on Auto and there is one. */
function stepDownIfOnAuto(): boolean {
	if (!manifest.value || qualities.currentVideoTrack.value !== -1) {
		return false;
	}
	const lower = nextLowerSource(manifest.value.sources, activeSource);
	if (lower === null) {
		return false;
	}
	console.log("DirectPlayer: moving down to source", lower);
	switchToSource(lower);
	return true;
}

/** A video that keeps running out of data while playing is too big for this connection. */
function stepDownIfStruggling(): void {
	const video = videoElem.value;
	// A seek waits for data whatever the size, so that wait says nothing about the connection.
	if (!video || video.paused || video.seeking) {
		return;
	}
	if (stallWatch.stalled(performance.now())) {
		stepDownIfOnAuto();
	}
}

/** The speed to judge Auto by: a recent reading if this device has one, otherwise a new one. */
async function findSpeed(url: string): Promise<number | null> {
	const recent = loadRecentSpeed(Date.now());
	if (recent !== null) {
		return recent;
	}
	const speed = await measureSpeed(url);
	if (speed !== null) {
		saveRecentSpeed(speed, Date.now());
	}
	return speed;
}

function isAutoQualitySupported(): boolean {
	return isQualitySupported();
}

function getCurrentActiveQuality(): number | null {
	if (!videoElem.value || !manifest.value) {
		return null;
	}
	return manifest.value.sources.findIndex(s => s.url === videoElem.value?.src) ?? -1;
}

function getAvailablePlaybackRates(): number[] {
	return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
}

function getPlaybackRate(): number {
	if (!videoElem.value) {
		console.error("player not ready");
		return 1;
	}
	return videoElem.value.playbackRate;
}

async function setPlaybackRate(rate: number): Promise<void> {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	videoElem.value.playbackRate = rate;
}

/** Written only when it changes: every write makes a browser re-time its audio. */
function setSyncRate(rate: number): void {
	const video = videoElem.value;
	if (!video || video.playbackRate === rate) {
		return;
	}
	// So nobody sounds different for the few seconds this lasts. On by default in browsers today.
	video.preservesPitch = true;
	(video as HTMLVideoElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
	video.playbackRate = rate;
}

function isSettled(): boolean {
	const video = videoElem.value;
	return !!video && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

function canAdjustRate(): boolean {
	const video = videoElem.value;
	return !!video && !video.paused && !video.ended && isSettled();
}

function noteSyncTrouble(): void {
	stepDownIfOnAuto();
}

function setAudioBoost(boost: number): void {
	audioBoost.setBoost(boost);
}

async function loadVideoSource() {
	console.log("DirectPlayer: loading video source:", videoUrl.value, videoMime.value);
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	// Fix for captions from previous video still showing after source change; queued so it
	// runs after any switch already in flight, and blocks the new default track below from
	// jumping ahead of it
	await applyActiveTrack(-1, false);
	audioBoost.resetFailedSetup();
	manifest.value = null;
	activeSource = -1;
	pendingResume?.abort();
	loadGeneration += 1;
	const generation = loadGeneration;

	if (videoMime.value === "application/json") {
		try {
			const response = await fetch(videoUrl.value);
			if (!response.ok) {
				console.error("DirectPlayer: failed to fetch manifest:", response.status);
				emit("error");
				return;
			}
			manifest.value = (await response.json()) as CustomMediaManifest;
		} catch (e) {
			console.error("DirectPlayer: failed to fetch manifest:", e);
			emit("error");
			return;
		}
		const sources = manifest.value.sources;
		if (!sources[0]) {
			console.error("DirectPlayer: manifest has no sources");
			emit("error");
			return;
		}
		const chosenHeight = sources.length > 1 ? loadQualityChoice() : null;
		const onAuto = chosenHeight === null;
		if (onAuto && sources.length > 1) {
			measuredSpeed = await findSpeed(sources[0].url);
		}
		if (generation !== loadGeneration || !videoElem.value) {
			return;
		}
		const start = onAuto ? autoSource() : sourceForHeight(sources, chosenHeight);
		startSource(start);

		qualities.videoTracks.value = getVideoTracks();
		qualities.currentVideoTrack.value = onAuto ? -1 : start;
	} else {
		videoElem.value.src = videoUrl.value;

		qualities.videoTracks.value = [];
		qualities.currentVideoTrack.value = -1;
		qualities.currentActiveQuality.value = null;
	}

	if (subtitleSources.value.length > 0) {
		// Wait for all vtt <track> elements to be inserted
		await nextTick();
	}
	captions.captionsTracks.value = getCaptionsTracks();
	const defaultTrackIdx = subtitleSources.value.findIndex(t => t.default);
	captions.currentTrack.value = defaultTrackIdx;
	captions.isCaptionsEnabled.value = defaultTrackIdx !== -1;
	if (defaultTrackIdx !== -1) {
		await applyActiveTrack(defaultTrackIdx, true);
	}

	videoElem.value.poster = thumbnail.value ?? "";
	videoElem.value.load();
	// this is needed to get the player to keep playing after the previous video has ended
	videoElem.value.play();

	console.log("DirectPlayer: current subtitle track:", captions.currentTrack.value);
	console.log("DirectPlayer: current video track:", qualities.currentVideoTrack.value);

	emit("apiready");
}

function onCanPlay() {
	if (videoElem.value?.videoWidth === 0) {
		// A browser that can't decode a file's picture may still play its sound, with no error.
		stepDownIfOnAuto();
	}
	emit("ready");
}

function onPlaying() {
	emit("playing");
}

function onPaused() {
	emit("paused");
}

function onWaiting() {
	emit("waiting");
}

function onVideoWaiting() {
	onWaiting();
	stepDownIfStruggling();
}

function onBuffering() {
	emit("buffering");
}

function onProgress() {
	if (videoElem.value) {
		const buffered = videoElem.value.buffered;
		emit("buffer-spans", buffered);
		const duration = videoElem.value.duration;
		let bufferedTotal = 0;
		for (let i = 0; i < buffered.length; i++) {
			bufferedTotal += buffered.end(i) - buffered.start(i);
		}
		const bufferedPercentage = duration > 0 ? bufferedTotal / duration : 0;
		emit("buffer-progress", bufferedPercentage);
	}
}

function onEnd() {
	emit("end");
}

function onError(err: Event) {
	console.error("DirectPlayer: error:", err);
	if (!stepDownIfOnAuto()) {
		emit("error");
	}
}

onMounted(() => {
	loadVideoSource();
});

onBeforeUnmount(() => {
	destroyJassub();
	loadGeneration += 1;
	pendingResume?.abort();
});

watch([videoUrl, subtitleUrl], () => {
	console.log("DirectPlayer: videoUrl or subtitleUrl changed");
	loadVideoSource();
});

defineExpose({
	play,
	pause,
	setVolume,
	getPosition,
	setPosition,
	isCaptionsSupported,
	setCaptionsEnabled,
	isCaptionsEnabled,
	getCaptionsTracks,
	setCaptionsTrack,
	isQualitySupported,
	getVideoTracks,
	setVideoTrack,
	isAutoQualitySupported,
	getCurrentActiveQuality,
	getAvailablePlaybackRates,
	getPlaybackRate,
	setPlaybackRate,
	setSyncRate,
	isSettled,
	canAdjustRate,
	noteSyncTrouble,
	setAudioBoost,
} satisfies MediaPlayerWithCaptions & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost & MediaPlayerWithQuality & MediaPlayerWithSyncRate);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.direct {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	max-width: 100%;
	max-height: 100%;
	width: 100%;
	height: 100%;
}

.direct video {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: 50% 50%;
}

.direct .jassub-canvas {
	position: absolute;
	pointer-events: none;
}
</style>

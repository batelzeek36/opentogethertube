<template>
	<div>
		<!-- HACK: For some reason, safari really doesn't like typescript enums. As a result, we are forced to not use the enums, and use their literal values instead. -->
		<div
			class="group/room p-4 max-xl:p-0 data-[fullscreen=true]:p-0 data-[layout=theater]:p-0"
			:data-fullscreen="store.state.fullscreen"
			:data-layout="store.state.settings.roomLayout"
			v-if="!showDisconnectedOverlay"
		>
			<div class="mx-2.5 flex flex-row items-center gap-2" v-if="!store.state.fullscreen">
				<h1
					class="relative pl-4 font-display text-foreground text-2xl before:absolute before:left-0 before:inset-y-[0.1em] before:w-1 before:bg-primary before:shadow-[0_0_12px_var(--primary)] before:content-['']"
				>
					{{
						store.state.room.title !== ""
							? store.state.room.title
							: store.state.room.isTemporary
							? $t("room.title-temp")
							: store.state.room.name
					}}
				</h1>
				<ClientSettingsDialog />
				<div class="flex items-center text-sm font-medium uppercase ml-auto">
					<Tooltip>
						<TooltipTrigger as-child>
							<Button
								data-cy="room-visibility"
								variant="ghost"
								size="sm"
								@click="onVisibilityClick"
							>
								<Icon :icon="roomVisibilityIcon" class="size-4" />
								{{ roomVisibilityLabel }}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">
							{{ $t("room.visibility-badge-label") }}
						</TooltipContent>
					</Tooltip>
					<Icon
						:icon="mdiCircle"
						class="ml-2 size-3"
						:class="
							connectionStatusColor === 'success' ? 'text-success' : 'text-warning'
						"
					/>
					<span id="connectStatus" class="ml-1 label-mono">{{ connectionStatus }}</span>
				</div>
			</div>
			<div
				class="fullscreen-frame grid w-full grid-cols-[1fr_auto] grid-rows-[minmax(400px,70vh)] max-lg:grid-cols-1 group-data-[fullscreen=true]/room:m-0 group-data-[fullscreen=true]/room:block group-data-[fullscreen=true]/room:h-screen group-data-[fullscreen=true]/room:max-h-screen group-data-[fullscreen=true]/room:w-screen group-data-[fullscreen=true]/room:aspect-[inherit] group-data-[layout=theater]/room:grid-rows-[minmax(400px,85vh)]"
			>
				<div
					class="relative z-31 flex h-full flex-col group-data-[fullscreen=true]/room:max-h-screen group-data-[fullscreen=true]/room:w-full! group-data-[fullscreen=true]/room:p-0 group-data-[layout=default]/room:w-4/5 group-data-[layout=default]/room:justify-self-center group-data-[layout=default]/room:max-xl:w-full"
					:class="{ 'typing-view': typingView, 'movie-only-stage': movieOnly }"
					:style="typingStyle"
				>
					<div
						class="movie-only-player fullscreen-player size-full group-data-[fullscreen=true]/room:h-screen"
						ref="playerContainer"
					>
						<OmniPlayer
							:source="store.state.room.currentSource"
							@apiready="onPlayerApiReady"
							@playing="onPlaybackChange(true)"
							@paused="onPlaybackChange(false)"
							@ready="onPlayerReady"
						/>
						<div
							id="mouse-event-swallower"
							class="absolute top-0 size-full"
							:class="{ hidden: controlsVisible }"
						></div>
						<div
							class="typing-chat pointer-events-none absolute bottom-20 right-0 h-[70%] min-h-17.5 w-100 px-2.5 py-1.25 max-lg:w-62.5"
							v-if="controlsMode === 'in-video' || (pageFullscreen && !movieOnly)"
						>
							<Chat ref="chat" @link-click="setAddPreviewText" />
						</div>
						<MovieOnlyButton v-show="controlsVisible" @click="enterMovieOnly" />
						<MovieOnlyLayer
							v-if="movieOnly"
							:revealed="movieOnlyRevealed"
							:take-focus="movieOnlyRevealedByKey"
							:playback-blocked="mediaPlaybackBlocked"
							@tap="onMovieOnlyTap"
							@show-controls="onShowControlsPressed"
						/>
						<ReactionOverlay />
						<ReactionBar :mode="controlsMode" :visible="controlsVisible" />
						<VoiceTalkButton
							v-if="store.state.fullscreen && voice.myChannel.value"
							v-show="controlsVisible || voice.holding.value"
							floating
							class="voice-floating-position"
						/>
						<div
							class="movie-only-play pointer-events-none absolute inset-0 z-200 flex items-center justify-center"
							data-movie-only-keep
							v-if="mediaPlaybackBlocked"
						>
							<Button
								class="pointer-events-auto"
								size="xl"
								variant="default"
								@click="onClickUnblockPlayback"
							>
								<Icon :icon="mdiPlay" class="size-5" />
								{{ $t("common.play") }}
							</Button>
						</div>
					</div>
					<VideoControls
						:slider-position="sliderPosition"
						:true-position="truePosition"
						:controls-visible="controlsVisible"
						:key="currentSource?.id"
						:mode="controlsMode"
					/>
				</div>
				<div
					class="pointer-events-none h-75 min-h-25 w-100 px-2.5 py-1.25 max-lg:w-full"
					v-if="
						controlsMode === 'outside-video' && (!store.state.fullscreen || movieOnly)
					"
				>
					<Chat ref="chat" always-visible @link-click="setAddPreviewText" />
				</div>
			</div>
			<div class="my-2.5">
				<VoicePanel />
				<RestoreQueue />
				<VoteSkip />
			</div>
			<div class="flex w-full max-lg:flex-col">
				<div class="w-3/5 grow max-lg:w-full">
					<Tabs v-model="queueTab" class="overflow-visible">
						<TabsList class="w-full">
							<TabsTrigger value="queue" class="flex-1 gap-2">
								<Icon :icon="mdiFormatListBulleted" class="size-4" />
								<span class="mx-2 max-lg:hidden">{{ $t("room.tabs.queue") }}</span>
								<Badge variant="secondary" class="ml-1">
									{{
										store.state.room.queue.length <= 99
											? $n(store.state.room.queue.length)
											: "99+"
									}}
								</Badge>
							</TabsTrigger>
							<TabsTrigger value="add" class="flex-1 gap-2">
								<Icon :icon="mdiPlus" class="size-4" />
								<span class="mx-2 max-lg:hidden">{{ $t("common.add") }}</span>
							</TabsTrigger>
							<TabsTrigger value="settings" class="flex-1 gap-2">
								<Icon :icon="mdiWrench" class="size-4" />
								<span class="mx-2 max-lg:hidden">{{
									$t("room.tabs.settings")
								}}</span>
							</TabsTrigger>
						</TabsList>

						<TabsContentAnimatedGroup>
							<TabsContentAnimated value="queue">
								<VideoQueue @switchtab="queueTab = 'add'" />
							</TabsContentAnimated>
							<TabsContentAnimated value="add">
								<AddPreview ref="addpreview" />
							</TabsContentAnimated>
							<TabsContentAnimated value="settings">
								<RoomSettingsForm ref="settings" />
							</TabsContentAnimated>
						</TabsContentAnimatedGroup>
					</Tabs>
				</div>
				<div class="flex min-h-125 flex-col gap-2.5 px-2.5">
					<div v-if="debugMode">
						<Card>
							<CardHeader>
								<CardTitle>Debug (prod: {{ production }})</CardTitle>
							</CardHeader>
							<CardContent
								class="flex flex-col gap-1 font-mono text-xs text-muted-foreground"
							>
								<div>Player status: {{ store.state.playerStatus }}</div>
								<div v-if="store.state.playerBufferPercent">
									Buffered:
									{{ Math.round(store.state.playerBufferPercent * 10000) / 100 }}%
								</div>
								<div
									v-if="
										store.state.playerBufferSpans &&
										store.state.playerBufferSpans.length > 0
									"
								>
									Buffered spans:
									{{ store.state.playerBufferSpans.length }}
									{{
										Array.from(
											{ length: store.state.playerBufferSpans.length },
											(v, k) => k++,
										)
											.map(
												i =>
													`${i}: [${secondsToTimestamp(
														store.state.playerBufferSpans?.start(i) ??
															0,
													)} => ${secondsToTimestamp(
														store.state.playerBufferSpans?.end(i) ?? 0,
													)}]`,
											)
											.join(" ")
									}}
								</div>
								<div>Is Mobile: {{ isMobile }}</div>
								<div>Device Orientation: {{ orientation }}</div>
								<div>
									Video controls: timeoutId:
									{{ videoControlsHideTimeout }} visible:
									{{ controlsVisible }}
								</div>
								<div class="mt-2 flex gap-2">
									<Button
										size="sm"
										variant="outline"
										@click="roomapi.kickMe()"
										:disabled="!isConnected"
									>
										{{ $t("room.kick-me") }}
									</Button>
									<Button
										size="sm"
										variant="outline"
										@click="roomapi.kickMe(1000)"
										:disabled="!isConnected"
									>
										Disconnect Me
									</Button>
								</div>
							</CardContent>
						</Card>
					</div>
					<UserList :users="Array.from(store.state.users.users.values())" />
					<ShareInvite />
				</div>
			</div>
		</div>
		<footer class="border-t px-4 py-6 text-center" v-if="!store.state.fullscreen">
			<p class="label-mono text-muted-foreground" v-if="isOfficialSite()">
				<router-link to="/privacypolicy">{{ $t("footer.privacy-policy") }}</router-link>
			</p>
			<p class="mt-2 font-mono text-xs text-dim">{{ gitCommit }}</p>
		</footer>
		<Transition name="ott-overlay">
			<div
				v-if="showDisconnectedOverlay"
				class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-sm"
			>
				<RoomDisconnected />
			</div>
		</Transition>
		<ServerMessageHandler />
		<WorkaroundPlaybackStatusUpdater />
		<WorkaroundUserStateNotifier />
	</div>
</template>

<script lang="ts">
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import {
	Tabs,
	TabsContentAnimated,
	TabsContentAnimatedGroup,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	mdiPlay,
	mdiFormatListBulleted,
	mdiPlus,
	mdiWrench,
	mdiEarth,
	mdiEyeOff,
	mdiLock,
	mdiCircle,
} from "@mdi/js";
import {
	defineComponent,
	ref,
	type Ref,
	unref,
	computed,
	watch,
	onMounted,
	onUnmounted,
	nextTick,
	provide,
	useTemplateRef,
} from "vue";
import AddPreview from "@/components/AddPreview.vue";
import { calculateCurrentPosition } from "ott-common/timestamp";
import _ from "lodash";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import Chat from "@/components/Chat.vue";
import ReactionBar from "@/components/ReactionBar.vue";
import { useTypingView } from "@/components/composables/typing-view";
import { useMovieOnly } from "@/components/composables/movie-only";
import {
	elementFullscreenAvailable,
	exitPageFullscreen,
	pageFullscreenActive,
	useFullscreen,
} from "@/components/composables/fullscreen";
import MovieOnlyButton from "@/components/MovieOnlyButton.vue";
import MovieOnlyLayer from "@/components/MovieOnlyLayer.vue";
import ReactionOverlay from "@/components/ReactionOverlay.vue";
import VoicePanel from "@/components/VoicePanel.vue";
import VoiceTalkButton from "@/components/VoiceTalkButton.vue";
import { provideVoice } from "@/voice/session";
import UserList from "@/components/UserList.vue";
import VideoQueue from "@/components/VideoQueue.vue";
import RoomSettingsForm from "@/components/RoomSettingsForm.vue";
import ShareInvite from "@/components/ShareInvite.vue";
import ClientSettingsDialog from "@/components/ClientSettingsDialog.vue";
import RoomDisconnected from "../components/RoomDisconnected.vue";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import ServerMessageHandler from "@/components/ServerMessageHandler.vue";
import WorkaroundPlaybackStatusUpdater from "@/components/WorkaroundPlaybackStatusUpdater.vue";
import WorkaroundUserStateNotifier from "@/components/WorkaroundUserStateNotifier.vue";
import { useStore } from "@/store";
import { useI18n } from "vue-i18n";
import { useRouter, useRoute } from "vue-router";
import type { ServerMessageSync } from "ott-common/models/messages";
import { useScreenOrientation, useMouseInElement } from "@vueuse/core";
import { KeyboardShortcuts, RoomKeyboardShortcutsKey } from "@/util/keyboard-shortcuts";
import VideoControls from "@/components/controls/VideoControls.vue";
import RestoreQueue from "@/components/RestoreQueue.vue";
import VoteSkip from "@/components/VoteSkip.vue";
import { waitForToken } from "@/util/token";
import { useSfx } from "@/plugins/sfx";
import { secondsToTimestamp } from "@/util/timestamp";
import { useCaptions, useMediaPlayer, useVolume } from "@/components/composables";
import { useGrants } from "@/components/composables/grants";
import { isOfficialSite } from "@/util/misc";
import { DriftCorrector } from "@/util/drift-correction";
import { Visibility } from "ott-common/models/types";

const VIDEO_CONTROLS_HIDE_TIMEOUT = 3000;
const QUEUE_TABS = ["queue", "add", "settings"] as const;

type QueueTab = (typeof QUEUE_TABS)[number];

// biome-ignore lint/style/noVueOptionsApi: TODO: convert to setup
export default defineComponent({
	name: "room",
	components: {
		VideoControls,
		MovieOnlyButton,
		MovieOnlyLayer,
		VideoQueue,
		OmniPlayer,
		Chat,
		ReactionBar,
		ReactionOverlay,
		VoicePanel,
		VoiceTalkButton,
		AddPreview,
		UserList,
		RoomSettingsForm,
		ShareInvite,
		ClientSettingsDialog,
		RoomDisconnected,
		ServerMessageHandler,
		WorkaroundPlaybackStatusUpdater,
		WorkaroundUserStateNotifier,
		RestoreQueue,
		VoteSkip,
		Badge,
		Button,
		Card,
		CardHeader,
		CardTitle,
		CardContent,
		Icon,
		Tabs,
		TabsContentAnimated,
		TabsContentAnimatedGroup,
		TabsList,
		TabsTrigger,
		Tooltip,
		TooltipContent,
		TooltipTrigger,
	},
	setup() {
		const store = useStore();
		const connection = useConnection();
		const roomapi = useRoomApi(connection);
		const voice = provideVoice();
		const { t } = useI18n();
		const router = useRouter();
		const route = useRoute();

		// video control visibility
		const { typingView, typingStyle } = useTypingView();
		const controlsVisible = ref(true);
		const videoControlsHideTimeout = ref<ReturnType<typeof setTimeout> | null>(null);
		const playerContainer = useTemplateRef<HTMLDivElement>("playerContainer");
		const mouse = useMouseInElement(playerContainer);
		const isIframeBasedPlayer = ref(false);

		function setVideoControlsVisibility(visible: boolean) {
			controlsVisible.value = visible;
			if (videoControlsHideTimeout.value) {
				clearTimeout(videoControlsHideTimeout.value);
				videoControlsHideTimeout.value = null;
			}
		}
		/**
		 * Show the video controls, then hide them after `VIDEO_CONTROLS_HIDE_TIMEOUT` milliseconds.
		 */
		function activateVideoControls() {
			setVideoControlsVisibility(true);
			if (controlsMode.value !== "outside-video") {
				videoControlsHideTimeout.value = setTimeout(() => {
					setVideoControlsVisibility(false);
				}, VIDEO_CONTROLS_HIDE_TIMEOUT);
			}
		}

		watch([mouse.x, mouse.y], () => {
			if (!store.state.room.isPlaying) {
				setVideoControlsVisibility(true);
				return;
			}

			// For non-iframe players, only show controls when mouse is inside the player
			if (!isIframeBasedPlayer.value && mouse.isOutside.value) {
				return;
			}

			activateVideoControls();
		});

		const controlsMode = computed(() =>
			currentSource.value?.service === "youtube" ? "outside-video" : "in-video",
		);

		// actively calculate the current position of the video
		const truePosition = ref(0);
		const sliderPosition = ref(0);
		const iTimestampUpdater: Ref<ReturnType<typeof setInterval> | null> = ref(null);

		function timestampUpdate() {
			if (!store.state.room.currentSource) {
				truePosition.value = 0;
				sliderPosition.value = 0;
				return;
			}
			truePosition.value = store.state.room.isPlaying
				? calculateCurrentPosition(
						store.state.room.playbackStartTime,
						new Date(),
						store.state.room.playbackPosition,
						store.state.room.playbackSpeed,
				  )
				: store.state.room.playbackPosition;
			sliderPosition.value = _.clamp(
				truePosition.value,
				0,
				store.state.room.currentSource?.length ?? 0,
			);
		}

		onMounted(() => {
			iTimestampUpdater.value = setInterval(timestampUpdate, 250);
		});

		onUnmounted(() => {
			if (iTimestampUpdater.value) {
				clearInterval(iTimestampUpdater.value);
			}
		});

		const driftCorrector = new DriftCorrector();

		async function followRoomPosition(newPosition: number) {
			if (!player.isPlayerPresent()) {
				return;
			}
			const currentTime = await player.getPosition();

			const drift = newPosition - currentTime;
			if (isNaN(drift)) {
				console.error("player diff is NaN, this is a bug", newPosition, currentTime);
				return;
			}
			const syncRatePlayer = player.getSyncRatePlayer();
			if (!syncRatePlayer) {
				if (Math.abs(drift) > 1 && !mediaPlaybackBlocked.value) {
					player.setPosition(newPosition);
				}
				return;
			}
			const { seek, rate } = driftCorrector.step({
				drift,
				roomSpeed: store.state.room.playbackSpeed,
				roomPlaying: store.state.room.isPlaying,
				blocked: mediaPlaybackBlocked.value,
				settled: syncRatePlayer.isSettled(),
				canAdjustRate: syncRatePlayer.canAdjustRate(),
				now: performance.now(),
			});
			syncRatePlayer.setSyncRate(rate);
			if (seek) {
				player.setPosition(newPosition);
			}
		}

		watch(truePosition, followRoomPosition);
		watch(
			() => store.state.room.currentSource,
			() => driftCorrector.reset(),
		);

		// connection status
		const isConnected = computed(() => connection.connected);
		const connectionStatus = computed(() => {
			return connection.connected.value
				? t("room.con-status.connected")
				: t("room.con-status.connecting");
		});
		const connectionStatusColor = computed(() =>
			connection.connected.value ? "success" : "warning",
		);
		const showDisconnectedOverlay = computed(() => !!connection.kickReason.value);

		function rewriteUrlToRoomName() {
			if (store.state.room.name.length === 0) {
				return;
			}
			if (route.params.roomId !== store.state.room.name) {
				console.debug(
					`room name does not match URL, rewriting to "${store.state.room.name}"`,
				);
				router.replace({
					name: "room",
					params: { roomId: store.state.room.name },
				});
			}
		}

		async function waitForPlayer() {
			if (!player.isPlayerPresent()) {
				console.debug("waiting for player", player);
				await new Promise(resolve => {
					const stop = watch(player.player, async newPlayer => {
						if (newPlayer) {
							stop();
							resolve(true);
						}
					});
					// const interval = setInterval(() => {
					// 	if (player.isPlayerPresent()) {
					// 		clearInterval(interval);
					// 		resolve(true);
					// 	}
					// }, 100);
				});
			}
			if (!player.isPlayerPresent()) {
				return Promise.reject("Can't wait for player api ready: player not present");
			}
			if (player.apiReady.value) {
				return;
			}
			console.debug("detected player, waiting for api ready");
			await new Promise(resolve => {
				// const stop = watch(player.apiReady, async newReady => {
				// 	if (newReady) {
				// 		stop();
				// 		resolve(true);
				// 	}
				// });
				const interval = setInterval(() => {
					if (player.apiReady.value) {
						clearInterval(interval);
						resolve(true);
					}
				}, 100);
			});
		}

		async function onSyncMsg(msg: ServerMessageSync) {
			rewriteUrlToRoomName();
			if (msg.isPlaying !== undefined && !mediaPlaybackBlocked.value) {
				await applyIsPlaying(msg.isPlaying);
			}
		}

		function onRoomCreated() {
			if (connection.active.value) {
				connection.disconnect();
			}
			setTimeout(() => {
				if (!connection.active.value) {
					connection.connect(route.params.roomId as string);
				}
			}, 100);
		}

		let roomCreatedUnsub: (() => void) | null = null;
		onMounted(async () => {
			await waitForToken(store);

			connection.addMessageHandler("sync", onSyncMsg);
			if (!connection.active.value) {
				connection.connect(route.params.roomId as string);
			}

			roomCreatedUnsub = store.subscribe(mutation => {
				if (mutation.type === "misc/ROOM_CREATED") {
					onRoomCreated();
				}
			});
		});

		onUnmounted(() => {
			connection.removeMessageHandler("sync", onSyncMsg);
			connection.disconnect();

			if (roomCreatedUnsub) {
				roomCreatedUnsub();
			}
		});

		// player management
		const player = useMediaPlayer();
		const volume = useVolume();

		function togglePlayback() {
			if (store.state.room.isPlaying) {
				roomapi.pause();
			} else {
				roomapi.play();
			}
		}

		function seekDelta(delta: number) {
			roomapi.seek(
				_.clamp(truePosition.value + delta, 0, store.state.room.currentSource?.length ?? 0),
			);
		}

		// Indicates that starting playback is blocked by the browser. This usually means that the user needs
		// to interact with the page before playback can start. This is because browsers block autoplaying videos.
		const mediaPlaybackBlocked = ref(false);

		// The position stops changing when the room pauses, and the player must not stay off speed.
		watch(
			() => [store.state.room.isPlaying, mediaPlaybackBlocked.value],
			() => followRoomPosition(truePosition.value),
		);

		async function applyIsPlaying(playing: boolean): Promise<void> {
			await waitForPlayer();
			if (!player.isPlayerPresent()) {
				return Promise.reject("Can't apply IsPlaying: player not present");
			}
			try {
				if (playing) {
					await player.play();
				} else {
					await player.pause();
				}
				mediaPlaybackBlocked.value = false;
				return;
			} catch (e) {
				if (e instanceof DOMException && e.name === "NotAllowedError") {
					mediaPlaybackBlocked.value = true;
				} else {
					console.error("Can't apply IsPlaying: ", e.name, e);
				}
			}
		}

		function onClickUnblockPlayback(): void {
			player?.setPosition(truePosition.value);
			applyIsPlaying(store.state.room.isPlaying);
		}

		function onPlayerApiReady() {
			console.debug("internal player API is now ready");
		}

		async function onPlaybackChange(changeTo: boolean) {
			console.debug(`onPlaybackChange: ${changeTo}`);
			if (!changeTo) {
				setVideoControlsVisibility(true);
			} else {
				activateVideoControls();
			}
			if (changeTo === store.state.room.isPlaying) {
				return;
			}

			await applyIsPlaying(store.state.room.isPlaying);
		}
		function onPlayerReady() {
			if (
				currentSource.value?.service === "vimeo" ||
				currentSource.value?.service === "youtube"
			) {
				onPlayerReadyApplyRoomState();
			}
			isIframeBasedPlayer.value = !!playerContainer.value?.querySelector("iframe");
			console.log("isIframeBasedPlayer:", isIframeBasedPlayer.value);
		}
		// Iframe-based players can (re)enter the ready state without having the room's current
		// position/play state applied yet (e.g. YouTube's native-controls toggle remounts the
		// player, landing it cued at position 0). Re-apply both here rather than waiting for the
		// timestamp watcher, which never fires while the room is paused.
		async function onPlayerReadyApplyRoomState() {
			player?.setPosition(truePosition.value);
			await applyIsPlaying(store.state.room.isPlaying);
		}

		const captions = useCaptions();
		function isCaptionsSupported() {
			return captions.isCaptionsSupported.value;
		}
		function getCaptionsTracks() {
			return captions.captionsTracks.value;
		}

		// misc UI stuff
		const isMobile = computed(
			() => window.matchMedia("only screen and (max-width: 760px)").matches,
		);
		const orientation = useScreenOrientation();
		const fullscreen = useFullscreen(store);
		const movieOnly = useMovieOnly({ followsRotation: () => isMobile.value });
		// Being kicked replaces the room with a message that has to be read.
		watch(showDisconnectedOverlay, disconnected => {
			if (disconnected) {
				movieOnly.exit();
			}
		});
		// The button she pressed says "Show controls".
		watch(movieOnly.active, active => {
			if (active) {
				return;
			}
			// Movie only leaves the browser's fullscreen matching how the phone is held now, so the
			// room's stand-in for it on an iPhone does the same. Rotation is ignored until here.
			if (isMobile.value && !elementFullscreenAvailable() && orientation.orientation.value) {
				if (orientation.orientation.value.startsWith("landscape")) {
					fullscreen.enterPage();
				} else {
					fullscreen.exit();
				}
			}
			if (store.state.room.isPlaying) {
				activateVideoControls();
			} else {
				setVideoControlsVisibility(true);
			}
		});
		const queueTab = ref<QueueTab>("queue");
		const roomSettingsForm = ref<typeof RoomSettingsForm | null>(null);

		onMounted(() => {
			if (!orientation.isSupported.value) {
				return;
			}

			watch(orientation.orientation, async newOrientation => {
				if (!newOrientation || movieOnly.active.value) {
					return;
				}
				if (isMobile.value) {
					if (newOrientation.startsWith("landscape")) {
						if (!elementFullscreenAvailable()) {
							// An iPhone has no fullscreen for a page: the room fills it instead.
							fullscreen.enterPage();
							return;
						}
						// this promise is rejected if the fullscreen request is denied
						await document.documentElement.requestFullscreen();
						window.scrollTo({ top: 0, behavior: "smooth" });
					} else {
						fullscreen.exit();
					}
				}
			});
		});

		// The header and footer come back with the rest of the site.
		onUnmounted(() => exitPageFullscreen());

		watch(queueTab, async newTab => {
			if (roomSettingsForm.value && newTab === "settings") {
				await roomSettingsForm.value.loadRoomSettings();
			}
		});

		const granted = useGrants();

		const addpreview = ref<typeof AddPreview | null>(null);
		async function setAddPreviewText(text: string) {
			queueTab.value = "add";
			await nextTick();
			if (!addpreview.value) {
				// HACK: the tab is not yet mounted, so we need to wait for it to be mounted
				// this will be more elegant when we have a new vue 3 style global event bus.
				await nextTick();
			}
			if (addpreview.value) {
				addpreview.value.setAddPreviewText(text);
			} else {
				console.error("addpreview is not mounted, can't set text");
			}
		}

		// keyboard shortcuts
		const shortcuts = new KeyboardShortcuts();
		shortcuts.bind([{ code: "Space" }, { code: "KeyK" }], () => {
			if (granted("playback.play-pause")) {
				togglePlayback();
			}
		});
		shortcuts.bind(
			[{ code: "ArrowLeft" }, { code: "ArrowRight" }, { code: "KeyJ" }, { code: "KeyL" }],
			(e: KeyboardEvent) => {
				if (granted("playback.seek")) {
					let seekIncrement = 5;
					if (e.ctrlKey || e.code === "KeyJ" || e.code === "KeyL") {
						seekIncrement = 10;
					}
					if (e.code === "ArrowLeft" || e.code === "KeyJ") {
						seekIncrement *= -1;
					}

					seekDelta(seekIncrement);
				}
			},
		);
		shortcuts.bind({ code: "Home" }, () => {
			if (granted("playback.seek")) {
				roomapi.seek(0);
			}
		});
		shortcuts.bind({ code: "End" }, () => {
			if (granted("playback.skip")) {
				roomapi.skip();
			}
		});
		shortcuts.bind([{ code: "ArrowUp" }, { code: "ArrowDown" }], (e: KeyboardEvent) => {
			volume.volume.value = _.clamp(
				volume.volume.value + 5 * (e.code === "ArrowDown" ? -1 : 1),
				0,
				100,
			);
		});
		shortcuts.bind({ code: "F12", ctrlKey: true, shiftKey: true }, () => {
			debugMode.value = !debugMode.value;
		});
		function onKeyDown(e: KeyboardEvent) {
			shortcuts.handleKeyDown(e);
		}
		provide(RoomKeyboardShortcutsKey, shortcuts);

		onMounted(() => {
			window.addEventListener("keydown", onKeyDown);
		});

		onUnmounted(() => {
			window.removeEventListener("keydown", onKeyDown);
		});

		const roomVisibility = computed(() => store.state.room.visibility);

		const roomVisibilityIcon = computed(() => {
			switch (roomVisibility.value) {
				case Visibility.Public:
					return mdiEarth;
				case Visibility.Unlisted:
					return mdiEyeOff;
				case Visibility.Private:
					return mdiLock;
				default:
					return mdiEyeOff;
			}
		});

		const roomVisibilityLabel = computed(() => {
			switch (roomVisibility.value) {
				case Visibility.Public:
					return t("room-settings.public");
				case Visibility.Unlisted:
					return t("room-settings.unlisted");
				case Visibility.Private:
					return t("room-settings.private");
				default:
					return "This is a bug";
			}
		});

		async function onVisibilityClick() {
			queueTab.value = "settings";
			await nextTick();
			if (roomSettingsForm.value) {
				await roomSettingsForm.value.loadRoomSettings();
				await nextTick();
				roomSettingsForm.value.openVisibilityMenu();
				roomSettingsForm.value.$el?.scrollIntoView({ behavior: "smooth" });
			}
		}

		// small helper aliases
		const currentSource = computed(() => store.state.room.currentSource);
		const production = computed(() => store.state.production);

		// debug mode
		const debugMode = ref(!unref(production));
		provide("debugMode", debugMode);

		const sfx = useSfx();
		onMounted(async () => {
			await sfx.loadSfx();
		});

		const gitCommit = __COMMIT_HASH__;

		return {
			store,
			roomapi,
			voice,
			granted,
			isOfficialSite,

			controlsVisible,
			typingView,
			typingStyle,
			pageFullscreen: pageFullscreenActive,
			movieOnly: movieOnly.active,
			movieOnlyRevealed: movieOnly.revealed,
			movieOnlyRevealedByKey: movieOnly.revealedByKey,
			enterMovieOnly: movieOnly.enter,
			onMovieOnlyTap: movieOnly.onTap,
			onShowControlsPressed: movieOnly.onShowControlsPressed,
			videoControlsHideTimeout,
			controlsMode,

			truePosition,
			sliderPosition,

			isConnected,
			connectionStatus,
			connectionStatusColor,
			showDisconnectedOverlay,

			player,
			volume,
			togglePlayback,
			onPlayerApiReady,
			onPlayerReady,
			onPlaybackChange,
			isCaptionsSupported,
			getCaptionsTracks,

			isMobile,
			queueTab,
			settings: roomSettingsForm,
			addpreview,
			setAddPreviewText,

			currentSource,
			production,
			debugMode,
			orientation: orientation.orientation,
			gitCommit,

			mediaPlaybackBlocked,
			onClickUnblockPlayback,
			secondsToTimestamp,

			roomVisibilityIcon,
			roomVisibilityLabel,
			onVisibilityClick,

			// MDI Icons
			mdiPlay,
			mdiFormatListBulleted,
			mdiPlus,
			mdiWrench,
			mdiCircle,
		};
	},
});
</script>

<style>
/* In fullscreen the voice panel is out of reach, so talk sits right above the reaction bar. */
.voice-floating-position {
	position: absolute;
	left: 10px;
	bottom: 130px;
	z-index: 40;
}

/*
 * Page fullscreen: where the browser has no fullscreen for a page (iPhone), the room's fullscreen
 * layout fills the visible screen itself. 100vh would reach under the browser's bars, so the frame
 * is pinned to what is visible, inside the notch and the home bar. See useFullscreen.
 */
html.page-fullscreen,
html.page-fullscreen body {
	overflow: hidden !important;
	overscroll-behavior: none;
	background: #000 !important;
}

html.page-fullscreen .fullscreen-frame {
	position: fixed;
	inset: 0;
	z-index: 45;
	width: auto;
	height: auto;
	max-height: none;
	padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
		env(safe-area-inset-left);
	background: #000;
}

html.page-fullscreen .fullscreen-player {
	height: 100%;
}

/* The whole movie frame and the chat, in the space above a phone's keyboard. See useTypingView. */
.typing-view {
	--typing-chat-height: 112px;
	--typing-chat-width: 42%;

	position: fixed !important;
	z-index: 60;
	max-height: none !important;
	background: #000;
}

.typing-view .video-controls-wrapper,
.typing-view .reaction-bar,
.typing-view .voice-floating-position,
.typing-view #mouse-event-swallower {
	display: none;
}

/*
 * Portrait: the chat sits right under the frame rather than at the bottom of the space, because a
 * phone's browser can report more room above the keyboard than it has (seen on the S25).
 */
.typing-view .player {
	position: relative;
	inset: auto;
	flex: none;
	width: 100%;
	height: auto;
	max-height: calc(100% - var(--typing-chat-height));
	aspect-ratio: var(--video-aspect, 4 / 3);
}

/* OmniPlayer nests a second .player inside its root: only the root takes the sizes above. */
.typing-view .player .player {
	position: static;
	inset: auto;
	width: 100%;
	height: 100%;
	max-height: none;
	aspect-ratio: auto;
}

.typing-view video {
	width: 100%;
	height: 100%;
	object-fit: contain;
}

.typing-view .typing-chat {
	position: relative;
	inset: auto;
	width: 100%;
	height: var(--typing-chat-height);
	min-height: 0;
	padding: 0;
	pointer-events: auto;
}

.typing-view .chat.activated {
	position: relative;
	margin: 0;
	border: 0;
	border-radius: 0;
	background: #000;
	backdrop-filter: none;
}

.typing-view .chat-header {
	position: absolute;
	top: 10px;
	right: 2px;
	z-index: 1;
	padding: 0;
	border: 0;
}

.typing-view .chat-header h4 {
	display: none;
}

.typing-view .input-box {
	order: -1;
	flex: none;
	padding-right: 34px;
}

@media (orientation: portrait) {
	.typing-view > div:first-child {
		display: flex;
		flex-direction: column;
	}
}

@media (orientation: landscape) {
	.typing-view .player {
		position: absolute;
		inset: 0 var(--typing-chat-width) 0 0;
		width: auto;
		max-height: none;
		aspect-ratio: auto;
	}

	.typing-view .player .player {
		position: static;
		inset: auto;
		width: 100%;
		height: 100%;
	}

	.typing-view .typing-chat {
		position: absolute;
		inset: 0 0 0 auto;
		width: var(--typing-chat-width);
		height: 100%;
	}

	.typing-view .input-box {
		order: 0;
		padding-right: 0;
	}

	.typing-view .chat-header {
		top: 2px;
	}
}

/*
 * Movie only: the page hides everything, whatever it holds now or later, and only the picture and
 * what has to be pressed on this screen opt back in. See useMovieOnly.
 */
html.movie-only,
html.movie-only body {
	overflow: hidden !important;
	overscroll-behavior: none;
	scrollbar-width: none;
	background: #000 !important;
}

html.movie-only::-webkit-scrollbar,
html.movie-only body::-webkit-scrollbar {
	display: none;
}

html.movie-only body * {
	visibility: hidden !important;
}

/* A hard cut: chat messages transition "all" over a second, visibility included. */
html.movie-only body *:not([data-movie-only-keep]) {
	transition: none !important;
}

html.movie-only .player video,
html.movie-only .player iframe,
html.movie-only .player canvas,
html.movie-only [data-movie-only-keep],
html.movie-only [data-movie-only-keep] * {
	visibility: visible !important;
}

html.movie-only .movie-only-stage {
	position: fixed !important;
	inset: 0 !important;
	z-index: 2147483000;
	/* Sized outright: the default layout justify-self would shrink an auto width to nothing. */
	width: 100% !important;
	height: 100% !important;
	max-height: none !important;
}

html.movie-only .movie-only-player {
	position: absolute;
	inset: 0;
	width: 100% !important;
	height: 100% !important;
}

/* PLAY covers the screen to center itself, but only the button should catch a tap. */
html.movie-only .movie-only-play {
	pointer-events: none;
}

html.movie-only .movie-only-play button {
	pointer-events: auto;
}

.typing-view .movie-only-button {
	display: none;
}
</style>

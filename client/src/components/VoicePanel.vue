<template>
	<section
		class="mx-2.5 mb-2.5 flex flex-col gap-2"
		data-cy="voice-panel"
		:aria-label="$t('voice.title')"
	>
		<div v-if="canJoin && !voice.myChannel.value" class="flex items-center gap-2">
			<span class="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
				<Icon :icon="mdiMicrophone" class="size-4" />
				{{ $t("voice.join") }}
			</span>
			<Button
				v-for="channel in channels"
				:key="channel.id"
				variant="outline"
				size="lg"
				class="min-w-0 flex-1 px-2"
				:aria-label="
					$t('voice.join-channel', { channel: $t(`voice.channels.${channel.id}`) })
				"
				:data-cy="`voice-join-${channel.id}`"
				@click="voice.join(channel.id)"
			>
				{{ $t(`voice.channels.${channel.id}`) }}
				<Badge v-if="channel.members.length > 0" variant="secondary">
					{{ $n(channel.members.length) }}
				</Badge>
			</Button>
		</div>

		<div v-if="voice.myChannel.value" class="flex items-center gap-2">
			<VoiceTalkButton class="h-14 min-w-0 flex-1 px-3" />
			<Button
				variant="outline"
				size="icon-lg"
				:aria-label="voice.muted.value ? $t('voice.unmute') : $t('voice.mute')"
				:aria-pressed="voice.muted.value"
				data-cy="voice-mute"
				@click="voice.toggleMuted"
			>
				<Icon :icon="voice.muted.value ? mdiVolumeOff : mdiVolumeHigh" class="size-5" />
			</Button>
			<Button
				variant="outline"
				size="lg"
				class="px-3"
				data-cy="voice-leave"
				@click="voice.leave"
			>
				{{ $t("voice.leave") }}
			</Button>
		</div>

		<ul v-if="showRoster" class="flex flex-col gap-1 text-sm" data-cy="voice-roster">
			<li
				v-for="channel in channels"
				:key="channel.id"
				class="flex min-h-11 items-center gap-2"
				:data-cy="`voice-channel-${channel.id}`"
			>
				<span class="w-10 shrink-0 text-muted-foreground">
					{{ $t(`voice.channels.${channel.id}`) }}
				</span>
				<span class="min-w-0 flex-1 break-words">
					<template v-if="channel.members.length === 0">
						<span class="text-muted-foreground">{{ $t("voice.empty") }}</span>
					</template>
					<span v-for="(member, i) in channel.members" :key="member"
						><component
							:is="member === voice.myId.value ? 'span' : 'button'"
							:type="member === voice.myId.value ? undefined : 'button'"
							:class="[
								member === channel.speaker ? 'font-bold text-primary' : '',
								member !== voice.myId.value ? 'voice-person' : '',
								voice.isSilenced(member) ? 'voice-person-silenced' : '',
							]"
							:aria-pressed="
								member === voice.myId.value ? undefined : voice.isSilenced(member)
							"
							:aria-label="
								member === voice.myId.value
									? undefined
									: $t(
											voice.isSilenced(member)
												? 'voice.unsilence-person'
												: 'voice.silence-person',
											{
												name: nameOf(member),
											},
									  )
							"
							:data-speaking="member === channel.speaker"
							:data-cy="member === voice.myId.value ? undefined : 'voice-person'"
							@click="
								member === voice.myId.value
									? undefined
									: voice.toggleSilenced(member)
							"
							>{{
								member === channel.speaker
									? $t("voice.name-talking", { name: nameOf(member) })
									: nameOf(member)
							}}</component
						><DeviceIcon
							:device="deviceOf(member)"
							class="ml-1 align-text-bottom"
						/><template v-if="i < channel.members.length - 1">, </template></span
					>
				</span>
				<Button
					v-if="voice.myChannel.value && voice.myChannel.value !== channel.id"
					variant="ghost"
					size="lg"
					class="px-2"
					:aria-label="
						$t('voice.switch-to', { channel: $t(`voice.channels.${channel.id}`) })
					"
					:data-cy="`voice-switch-${channel.id}`"
					@click="voice.join(channel.id)"
				>
					{{ $t("voice.switch") }}
				</Button>
			</li>
		</ul>

		<p
			v-if="voice.myChannel.value && hasOtherMembers"
			class="text-xs text-muted-foreground"
			data-cy="voice-person-hint"
		>
			{{ $t("voice.person-hint") }}
		</p>

		<p
			v-if="voice.notice.value"
			class="flex min-h-11 items-center gap-2 text-sm text-muted-foreground"
			role="status"
			data-cy="voice-notice"
			:data-notice="voice.notice.value"
		>
			<span class="min-w-0 flex-1">{{ $t(`voice.notices.${voice.notice.value}`) }}</span>
			<Button
				v-if="voice.notice.value === 'mic-denied' || voice.notice.value === 'no-mic'"
				variant="outline"
				size="lg"
				class="px-3"
				data-cy="voice-mic-retry"
				@click="voice.prepareMic"
			>
				{{ $t("voice.try-again") }}
			</Button>
		</p>

		<template v-if="canManage">
			<Button
				v-if="hasPeopleToManage"
				variant="ghost"
				size="lg"
				class="self-start px-2"
				:aria-expanded="managing"
				data-cy="voice-manage"
				@click="managing = !managing"
			>
				{{ $t("voice.manage") }}
			</Button>
			<ul v-if="managing && hasPeopleToManage" class="flex flex-col gap-1 text-sm">
				<li
					v-for="member in removableMembers"
					:key="member"
					class="flex min-h-11 items-center gap-2"
				>
					<span class="min-w-0 flex-1 truncate">{{ nameOf(member) }}</span>
					<Button
						variant="destructive"
						size="lg"
						class="px-3"
						:data-cy="`voice-remove-${nameOf(member)}`"
						@click="voice.removeFromVoice(member)"
					>
						{{ $t("voice.remove") }}
					</Button>
				</li>
				<li
					v-for="person in voice.removedIds.value"
					:key="person"
					class="flex min-h-11 items-center gap-2"
				>
					<span class="min-w-0 flex-1 truncate text-muted-foreground">
						{{ nameOf(person) }}
					</span>
					<Button
						variant="outline"
						size="lg"
						class="px-3"
						:data-cy="`voice-allow-${nameOf(person)}`"
						@click="voice.allowBack(person)"
					>
						{{ $t("voice.allow-back") }}
					</Button>
				</li>
			</ul>
		</template>
	</section>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import { mdiMicrophone, mdiVolumeHigh, mdiVolumeOff } from "@mdi/js";
import { useI18n } from "vue-i18n";
import { Role } from "ott-common/models/types";
import { canKickUser } from "ott-common/userutils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useGrants } from "@/components/composables/grants";
import DeviceIcon from "@/components/DeviceIcon.vue";
import VoiceTalkButton from "@/components/VoiceTalkButton.vue";
import { useStore } from "@/store";
import { useVoice } from "@/voice/session";

const { t } = useI18n();
const store = useStore();
const voice = useVoice();
const granted = useGrants();

const channels = computed(() => voice.channels.value);
const managing = ref(false);

const canJoin = computed(
	() =>
		voice.notice.value !== "off" &&
		voice.notice.value !== "disconnected" &&
		voice.notice.value !== "removed" &&
		voice.notice.value !== "unavailable" &&
		voice.notice.value !== "unsupported",
);

const showRoster = computed(
	() =>
		voice.myChannel.value !== null ||
		channels.value.some(channel => channel.members.length > 0),
);

const hasOtherMembers = computed(() =>
	channels.value.some(channel => channel.members.some(member => member !== voice.myId.value)),
);

function nameOf(clientId: string): string {
	return store.state.users.users.get(clientId)?.name ?? t("voice.someone");
}

function deviceOf(clientId: string) {
	return store.state.users.users.get(clientId)?.device;
}

const myRole = computed(() => store.getters["users/self"]?.role ?? Role.UnregisteredUser);
const canManage = computed(() => granted("manage-users.voice-remove"));
const removableMembers = computed(() =>
	channels.value
		.flatMap(channel => channel.members)
		.filter(member => {
			const role = store.state.users.users.get(member)?.role ?? Role.UnregisteredUser;
			return member !== voice.myId.value && canKickUser(myRole.value, role);
		}),
);
const hasPeopleToManage = computed(
	() => removableMembers.value.length > 0 || voice.removedIds.value.length > 0,
);
</script>

<style scoped>
.voice-person {
	min-height: 28px;
	cursor: pointer;
	text-align: left;
	text-decoration: underline dotted;
	text-underline-offset: 3px;
	touch-action: manipulation;
}

.voice-person-silenced {
	text-decoration: line-through;
	opacity: 0.6;
}
</style>

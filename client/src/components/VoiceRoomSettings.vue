<template>
	<div class="flex items-center gap-2">
		<Checkbox
			id="rs-voice-enabled"
			v-model="enabled"
			:disabled="disabled"
			data-cy="input-voice-enabled"
		/>
		<Label for="rs-voice-enabled" class="cursor-pointer">
			{{ $t("room-settings.voice-enabled") }}
		</Label>
	</div>
	<Field>
		<FieldLabel for="rs-voice-max-talk">{{ $t("room-settings.voice-max-talk") }}</FieldLabel>
		<Input
			id="rs-voice-max-talk"
			type="number"
			inputmode="numeric"
			:min="VOICE_MAX_TALK_SECONDS_MIN"
			:max="VOICE_MAX_TALK_SECONDS_MAX"
			:model-value="maxTalk"
			:disabled="disabled"
			data-cy="input-voice-max-talk"
			@change="commitMaxTalk"
		/>
	</Field>
	<Field>
		<FieldLabel for="rs-voice-slow-mode">{{ $t("room-settings.voice-slow-mode") }}</FieldLabel>
		<Input
			id="rs-voice-slow-mode"
			type="number"
			inputmode="numeric"
			:min="VOICE_SLOW_MODE_SECONDS_MIN"
			:max="VOICE_SLOW_MODE_SECONDS_MAX"
			:model-value="slowMode"
			:disabled="disabled"
			data-cy="input-voice-slow-mode"
			@change="commitSlowMode"
		/>
		<p class="text-xs text-muted-foreground">{{ $t("room-settings.voice-slow-mode-hint") }}</p>
	</Field>
	<p v-if="disabled" class="text-sm text-muted-foreground" data-cy="voice-settings-locked">
		{{ $t("room-settings.voice-owner-only") }}
	</p>
</template>

<script lang="ts" setup>
import {
	VOICE_MAX_TALK_SECONDS_MAX,
	VOICE_MAX_TALK_SECONDS_MIN,
	VOICE_SLOW_MODE_SECONDS_MAX,
	VOICE_SLOW_MODE_SECONDS_MIN,
} from "ott-common/models/voice";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

defineProps<{ disabled: boolean }>();

const enabled = defineModel<boolean>("enabled", { required: true });
const maxTalk = defineModel<number>("maxTalk", { required: true });
const slowMode = defineModel<number>("slowMode", { required: true });

/**
 * Whole seconds within the server's bounds, or the current value if the field is empty. Applied when
 * the person finishes typing: typing 15 goes through 1, which is under the minimum.
 */
function parseSeconds(e: Event, min: number, max: number, current: number): number {
	const input = e.target as HTMLInputElement;
	const parsed = Number.parseInt(input.value, 10);
	const value = Number.isNaN(parsed) ? current : Math.min(max, Math.max(min, parsed));
	input.value = String(value);
	return value;
}

function commitMaxTalk(e: Event) {
	maxTalk.value = parseSeconds(
		e,
		VOICE_MAX_TALK_SECONDS_MIN,
		VOICE_MAX_TALK_SECONDS_MAX,
		maxTalk.value,
	);
}

function commitSlowMode(e: Event) {
	slowMode.value = parseSeconds(
		e,
		VOICE_SLOW_MODE_SECONDS_MIN,
		VOICE_SLOW_MODE_SECONDS_MAX,
		slowMode.value,
	);
}
</script>

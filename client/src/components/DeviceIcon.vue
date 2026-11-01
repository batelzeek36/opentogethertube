<template>
	<span
		v-if="icon"
		class="inline-flex text-muted-foreground"
		role="img"
		:aria-label="label"
		:title="label"
		data-cy="device-icon"
		:data-device="device"
	>
		<Icon :icon="icon" class="size-3.5" />
	</span>
</template>

<script lang="ts" setup>
import { mdiCellphone, mdiMonitor, mdiTablet } from "@mdi/js";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Icon } from "@/components/ui/icon";
import { type DeviceType, isDeviceType } from "ott-common/models/device";

const props = defineProps<{
	device?: DeviceType;
}>();

const { t } = useI18n();

const ICONS: Record<DeviceType, string> = {
	phone: mdiCellphone,
	tablet: mdiTablet,
	computer: mdiMonitor,
};

const known = computed(() => (isDeviceType(props.device) ? props.device : undefined));
const icon = computed(() => (known.value ? ICONS[known.value] : undefined));
const label = computed(() => (known.value ? t(`device.${known.value}`) : undefined));
</script>

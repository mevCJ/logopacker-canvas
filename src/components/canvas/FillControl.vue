<template>
  <div class="fc">
    <div class="fc-mode">
      <button
        v-for="m in FILL_MODES"
        :key="m.id"
        type="button"
        class="fc-btn"
        :class="{ active: mode === m.id }"
        :title="m.label"
        @click="setMode(m.id)"
      >
        <span class="fc-icon" :class="`is-${m.id}`" />
        {{ m.label }}
      </button>
    </div>
    <ColorPicker
      v-if="mode === 'solid'"
      :model-value="target.fill"
      :swatches="swatches"
      :default-open="defaultOpen"
      @picked="emit('picked')"
      @begin="store.snapshot('Recolor')"
      @update:model-value="store.setFill(target.id, $event)"
    />
    <GradientEditor
      v-else-if="target.fillGradient"
      :model-value="target.fillGradient"
      :swatches="swatches"
      @begin="store.snapshot('Gradient')"
      @update:model-value="store.setFillGradient(target.id, $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ColorPicker from './ColorPicker.vue'
import GradientEditor from './GradientEditor.vue'
import { useCanvasStore, type PathObject, type TextObject } from '@/stores/canvas'
import { defaultGradient } from '@/services/canvas/gradient'

// Fill editor for one path/text object: solid color, or a linear/radial
// gradient. Switching to solid keeps the gradient's first color.
const props = withDefaults(
  defineProps<{ target: PathObject | TextObject; swatches?: string[]; defaultOpen?: boolean }>(),
  { swatches: () => [], defaultOpen: false },
)

const store = useCanvasStore()
const emit = defineEmits<{ (e: 'picked'): void }>()

type FillMode = 'solid' | 'linear' | 'radial'
const FILL_MODES: { id: FillMode; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'linear', label: 'Linear' },
  { id: 'radial', label: 'Radial' },
]

const mode = computed<FillMode>(() => props.target.fillGradient?.type ?? 'solid')

function setMode(next: FillMode) {
  const o = props.target
  if (next === mode.value) return
  store.snapshot(next === 'solid' ? 'Solid fill' : 'Gradient')
  if (next === 'solid') {
    store.setFill(o.id, o.fillGradient?.stops[0]?.color ?? o.fill)
    return
  }
  const g = o.fillGradient
  store.setFillGradient(o.id, g ? { ...defaultGradient(o.fill, next), stops: g.stops } : defaultGradient(o.fill, next))
}
</script>

<style scoped>
.fc-mode {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.fc-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 4px;
  border: 1px solid #e4e4e7;
  border-radius: 7px;
  background: #fff;
  font-size: 11px;
  color: #211a43;
  cursor: pointer;
}
.fc-btn.active {
  border-color: #211a43;
  background: #f4f4f5;
}
.fc-icon {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  background: #211a43;
}
.fc-icon.is-linear {
  background: linear-gradient(to right, #211a43, #fff);
}
.fc-icon.is-radial {
  border-radius: 50%;
  background: radial-gradient(circle, #fff, #211a43);
}
</style>

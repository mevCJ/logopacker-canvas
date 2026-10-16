<template>
  <div ref="root" class="tool-sidebar" @mouseleave="cancelHold">
    <template v-for="(section, si) in SECTIONS" :key="si">
      <span v-if="si > 0" class="tool-divider" />
      <div v-for="group in section" :key="group.id" class="tool-group">
        <button
          class="tool-btn"
          :class="{ active: groupActive(group) }"
          :data-group="group.id"
          :title="tooltip(current(group))"
          @mousedown="startHold(group)"
          @mouseup="cancelHold"
          @click="onGroupClick(group, $event)"
          @contextmenu.prevent="openFlyout(group.id)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" v-html="current(group).icon" />
          <span
            v-if="group.tools.length > 1"
            class="tool-caret"
            title="More tools"
            @click.stop="toggleFlyout(group.id)"
            @mousedown.stop
          />
        </button>

        <Transition name="flyout">
          <div v-if="flyout === group.id" class="tool-flyout" @mouseleave="flyout = null">
            <div class="flyout-title">{{ group.label }}</div>
            <button
              v-for="t in group.tools"
              :key="t.id"
              class="flyout-btn"
              :class="{ active: activeTool === t.id }"
              :data-tool="t.id"
              @click="pickFromFlyout(group, t)"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" v-html="t.icon" />
              <span class="flyout-name">{{ t.label }}</span>
              <span v-if="t.key" class="flyout-key">{{ t.key }}</span>
            </button>
          </div>
        </Transition>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore, type ToolId } from '@/stores/canvas'

const emit = defineEmits<{ (e: 'open-image-picker', el: HTMLElement | null): void }>()

const store = useCanvasStore()
const { activeTool } = storeToRefs(store)

interface ToolDef {
  id: ToolId
  label: string
  key?: string
  icon: string
}
interface ToolGroup {
  id: string
  label: string
  tools: ToolDef[]
}

const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'

// Illustrator-style toolbox: tools of one kind share a slot; the slot shows
// the last tool used from its group. Sections are separated by dividers.
const SECTIONS: ToolGroup[][] = [
  [
    {
      id: 'selection',
      label: 'Selection',
      tools: [
        { id: 'select', label: 'Selection', key: 'V', icon: '<path d="M5 3l6 16 2.2-6.2L19 10z" fill="currentColor"/>' },
        { id: 'node', label: 'Direct Selection', key: 'A', icon: '<path d="M5 3l6 16 2.2-6.2L19 10z" fill="#fff" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' },
      ],
    },
  ],
  [
    {
      id: 'pen',
      label: 'Pen',
      tools: [
        { id: 'pen', label: 'Pen', key: 'P', icon: `<path d="M4 20l3.5-9L15 3.5a2 2 0 012.8 0l.7.7a2 2 0 010 2.8L11 15z" ${S}/><path d="M7.5 11L11 15M4 20l3-1" ${S}/>` },
      ],
    },
    {
      id: 'type',
      label: 'Type',
      tools: [
        { id: 'text', label: 'Type', key: 'T', icon: `<path d="M5 5h14v3M12 5v14M9 19h6" ${S}/>` },
        { id: 'textPath', label: 'Type on a Path', icon: '<path d="M3 19c4-6 12-6 18 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 3"/><path d="M8 5h8M12 5v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
      ],
    },
    {
      id: 'shape',
      label: 'Shapes',
      tools: [
        { id: 'rect', label: 'Rectangle', key: 'M', icon: '<rect x="4" y="6" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>' },
        { id: 'ellipse', label: 'Ellipse', key: 'L', icon: '<ellipse cx="12" cy="12" rx="8" ry="6" fill="none" stroke="currentColor" stroke-width="2"/>' },
        { id: 'line', label: 'Line Segment', key: '\\', icon: '<line x1="5" y1="18" x2="19" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
      ],
    },
  ],
  [
    {
      id: 'build',
      label: 'Shape Builder',
      tools: [
        { id: 'shapeBuilder', label: 'Shape Builder', key: '⇧M', icon: '<circle cx="9" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="14" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9.5a6 6 0 013 4.5 6 6 0 01-3 .5 6 6 0 01-3-4.5 6 6 0 013-.5z" fill="currentColor"/>' },
      ],
    },
    {
      id: 'gradient',
      label: 'Gradient',
      tools: [
        { id: 'gradient', label: 'Gradient', key: 'G', icon: '<defs><linearGradient id="tb-grad" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0.05"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><rect x="4" y="5" width="16" height="14" rx="2" fill="url(#tb-grad)" stroke="currentColor" stroke-width="2"/>' },
      ],
    },
  ],
  [
    {
      id: 'image',
      label: 'Place',
      tools: [
        { id: 'image', label: 'Place Image', icon: '<rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M5 17l4.5-4 3 2.5L16 11l3 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' },
      ],
    },
  ],
]

const GROUPS = SECTIONS.flat()

const flyout = ref<string | null>(null)

// Last-used tool per group (what the slot shows and arms on click).
const lastUsed = reactive<Record<string, ToolId>>(Object.fromEntries(GROUPS.map((g) => [g.id, g.tools[0]!.id])))

function groupOf(tool: ToolId): ToolGroup | undefined {
  return GROUPS.find((g) => g.tools.some((t) => t.id === tool))
}
function current(group: ToolGroup): ToolDef {
  return group.tools.find((t) => t.id === lastUsed[group.id]) ?? group.tools[0]!
}
function groupActive(group: ToolGroup): boolean {
  return group.tools.some((t) => t.id === activeTool.value)
}
function tooltip(t: ToolDef): string {
  return t.key ? `${t.label} (${t.key})` : t.label
}

// Keep each slot in sync when a tool is armed elsewhere (hotkeys, agent).
watch(
  activeTool,
  (tool) => {
    const g = groupOf(tool)
    if (g) lastUsed[g.id] = tool
    flyout.value = null
  },
  { immediate: true },
)

const root = ref<HTMLElement | null>(null)

// Close the flyout on any outside press or Escape (tool changes close it too,
// via pickFromFlyout / onGroupClick).
function onDocDown(e: MouseEvent) {
  if (flyout.value && !root.value?.contains(e.target as Node)) flyout.value = null
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') flyout.value = null
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  window.addEventListener('keydown', onKey)
})

function arm(tool: ToolId, el?: HTMLElement | null) {
  store.setActiveTool(tool)
  if (tool === 'image') emit('open-image-picker', el ?? document.querySelector('[data-group="image"]'))
}

// Click arms the slot's tool; press-and-hold (as in Illustrator) opens the
// group's flyout instead.
let holdTimer: ReturnType<typeof setTimeout> | null = null
let heldOpen = false
function startHold(group: ToolGroup) {
  cancelHold()
  heldOpen = false
  if (group.tools.length < 2) return
  holdTimer = setTimeout(() => {
    heldOpen = true
    flyout.value = group.id
  }, 350)
}
function cancelHold() {
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = null
}
function onGroupClick(group: ToolGroup, e: MouseEvent) {
  cancelHold()
  if (heldOpen) {
    heldOpen = false
    return
  }
  flyout.value = null
  arm(current(group).id, e.currentTarget as HTMLElement)
}
function openFlyout(id: string) {
  if ((GROUPS.find((g) => g.id === id)?.tools.length ?? 0) > 1) flyout.value = id
}
function toggleFlyout(id: string) {
  flyout.value = flyout.value === id ? null : id
}
function pickFromFlyout(group: ToolGroup, t: ToolDef) {
  lastUsed[group.id] = t.id
  flyout.value = null
  arm(t.id)
}

onBeforeUnmount(() => {
  cancelHold()
  document.removeEventListener('mousedown', onDocDown)
  window.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
.tool-sidebar {
  position: absolute;
  top: 50%;
  left: 16px;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(24, 24, 27, 0.12);
  z-index: 20;
  font-family: Inter, sans-serif;
}
.tool-divider {
  width: 28px;
  height: 1px;
  background: #e4e4e7;
  margin: 3px 0;
}
.tool-group {
  position: relative;
}
.tool-btn {
  position: relative;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.tool-btn:hover {
  background: #f4f4f5;
}
.tool-btn.active {
  background: #211a43;
  border-color: #211a43;
  color: #fff;
}
/* Corner triangle: this slot holds more tools (click it or press-and-hold). */
.tool-caret {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-bottom: 5px solid currentColor;
  cursor: pointer;
}
.tool-caret::after {
  /* Bigger invisible hit area. */
  content: '';
  position: absolute;
  right: -3px;
  bottom: -8px;
  width: 12px;
  height: 12px;
}
.tool-flyout {
  position: absolute;
  top: -6px;
  left: calc(100% + 10px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  min-width: 190px;
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(24, 24, 27, 0.12);
  white-space: nowrap;
  z-index: 30;
}
.flyout-title {
  font-size: 11px;
  color: #a1a1aa;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px 4px;
}
.flyout-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: #fff;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.flyout-name {
  flex: 1;
}
.flyout-key {
  font-size: 11px;
  color: #a1a1aa;
}
.flyout-btn:hover {
  background: #f4f4f5;
}
.flyout-btn.active {
  background: #211a43;
  color: #fff;
}
.flyout-btn.active .flyout-key {
  color: #c7c4d8;
}
.flyout-enter-active,
.flyout-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.flyout-enter-from,
.flyout-leave-to {
  opacity: 0;
  transform: translateX(-4px);
}
</style>

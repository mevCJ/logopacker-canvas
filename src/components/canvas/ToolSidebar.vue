<template>
  <div class="tool-sidebar">
    <button
      class="tool-btn"
      :class="{ active: activeTool === 'select' }"
      title="Select (V)"
      @click="pick('select')"
    >
      <!-- cursor arrow -->
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M5 3l6 16 2.2-6.2L19 10z" fill="currentColor" />
      </svg>
    </button>

    <button
      class="tool-btn"
      :class="{ active: activeTool === 'node' }"
      title="Edit nodes (A)"
      @click="pick('node')"
    >
      <!-- node/anchor editor: a path segment with anchor squares -->
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M5 17c4 0 6-10 14-10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        <rect x="3" y="15" width="4" height="4" fill="#fff" stroke="currentColor" stroke-width="1.6" />
        <rect x="17" y="5" width="4" height="4" fill="#fff" stroke="currentColor" stroke-width="1.6" />
      </svg>
    </button>

    <button
      class="tool-btn"
      :class="{ active: activeTool === 'text' }"
      title="Text (T)"
      @click="pick('text')"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M5 5h14v3M12 5v14M9 19h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button
      class="tool-btn"
      :class="{ active: activeTool === 'pen' }"
      title="Pen (P)"
      @click="pick('pen')"
    >
      <!-- fountain-pen nib -->
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M4 20l3.5-9L15 3.5a2 2 0 012.8 0l.7.7a2 2 0 010 2.8L11 15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
        <path d="M7.5 11L11 15M4 20l3-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>

    <!-- Shapes: button + flyout -->
    <div class="tool-shape-wrap">
      <button
        class="tool-btn"
        :class="{ active: isShapeTool }"
        title="Shapes"
        @click="toggleShapeFlyout"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <component :is="shapeIcon" />
        </svg>
        <span class="tool-caret" />
      </button>

      <Transition name="flyout">
        <div v-if="shapeFlyoutOpen" class="tool-flyout" @mouseleave="shapeFlyoutOpen = false">
          <button class="flyout-btn" :class="{ active: activeTool === 'rect' }" @click="pickShape('rect')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <rect x="4" y="6" width="16" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2" />
            </svg>
            <span>Rectangle</span>
          </button>
          <button class="flyout-btn" :class="{ active: activeTool === 'ellipse' }" @click="pickShape('ellipse')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <ellipse cx="12" cy="12" rx="8" ry="6" fill="none" stroke="currentColor" stroke-width="2" />
            </svg>
            <span>Ellipse</span>
          </button>
          <button class="flyout-btn" :class="{ active: activeTool === 'line' }" @click="pickShape('line')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <line x1="5" y1="18" x2="19" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
            <span>Line</span>
          </button>
        </div>
      </Transition>
    </div>

    <button
      ref="imageBtn"
      class="tool-btn"
      :class="{ active: activeTool === 'image' }"
      title="Image"
      @click="pick('image')"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
        <circle cx="9" cy="10" r="1.6" fill="currentColor" />
        <path d="M5 17l4.5-4 3 2.5L16 11l3 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore, type ToolId } from '@/stores/canvas'

const emit = defineEmits<{ (e: 'open-image-picker', el: HTMLElement | null): void }>()

const store = useCanvasStore()
const { activeTool } = storeToRefs(store)

const shapeFlyoutOpen = ref(false)
const imageBtn = ref<HTMLElement | null>(null)

const SHAPE_TOOLS: ToolId[] = ['rect', 'ellipse', 'line']
const isShapeTool = computed(() => SHAPE_TOOLS.includes(activeTool.value))

// The shapes button icon reflects the currently-armed shape (or rectangle).
const shapeIcon = computed(() => {
  const t = activeTool.value
  if (t === 'ellipse') {
    return () => h('ellipse', { cx: 12, cy: 12, rx: 8, ry: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 })
  }
  if (t === 'line') {
    return () => h('line', { x1: 5, y1: 18, x2: 19, y2: 6, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
  }
  return () => h('rect', { x: 4, y: 6, width: 16, height: 12, rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 })
})

function pick(tool: ToolId) {
  store.setActiveTool(tool)
  shapeFlyoutOpen.value = false
  if (tool === 'image') emit('open-image-picker', imageBtn.value)
}

function toggleShapeFlyout() {
  shapeFlyoutOpen.value = !shapeFlyoutOpen.value
}

function pickShape(tool: ToolId) {
  store.setActiveTool(tool)
  shapeFlyoutOpen.value = false
}

// Close the flyout whenever the tool changes to a non-shape tool elsewhere.
watch(activeTool, (t) => {
  if (!SHAPE_TOOLS.includes(t)) shapeFlyoutOpen.value = false
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
  gap: 6px;
  padding: 6px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(24, 24, 27, 0.12);
  z-index: 20;
  font-family: Inter, sans-serif;
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
.tool-caret {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-bottom: 4px solid currentColor;
}
.tool-shape-wrap {
  position: relative;
}
.tool-flyout {
  position: absolute;
  top: 0;
  left: calc(100% + 8px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(24, 24, 27, 0.12);
  white-space: nowrap;
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
.flyout-btn:hover {
  background: #f4f4f5;
}
.flyout-btn.active {
  background: #211a43;
  color: #fff;
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

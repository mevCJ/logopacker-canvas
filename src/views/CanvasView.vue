<template>
  <div class="canvas-page">
    <Toolbar @fit-view="fitView" />
    <div class="canvas-body">
      <CanvasStage ref="stage" class="canvas-stage-host" />
      <PropertyPanel />
      <AgentActivityLog />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useCanvasStore } from '@/stores/canvas'
import { seedNova } from '@/services/canvas/novaSeed'
import { registerCanvasTools } from '@/services/canvas/tools'
import { buildImageTextTools } from '@/services/canvas/imageTextTools'
import CanvasStage from '@/components/canvas/CanvasStage.vue'
import Toolbar from '@/components/canvas/Toolbar.vue'
import PropertyPanel from '@/components/canvas/PropertyPanel.vue'
import AgentActivityLog from '@/components/canvas/AgentActivityLog.vue'

const store = useCanvasStore()
const stage = ref<{ fitViewBox: () => void } | null>(null)
let unregisterTools: (() => void) | null = null

function fitView() {
  stage.value?.fitViewBox()
}

onMounted(() => {
  // Seed the NOVA primary logo (imports + tags src/assets/logoipsum.svg).
  if (store.artboards.length === 0) {
    seedNova(store)
  }
  // Register WebMCP tools so an external agent can operate the canvas.
  unregisterTools = registerCanvasTools(store, {
    extraTools: (s, logger) => buildImageTextTools(s, logger),
  })
})

onBeforeUnmount(() => {
  if (unregisterTools) unregisterTools()
  unregisterTools = null
})
</script>

<style scoped>
.canvas-page {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  background: #ececed;
  overflow: hidden;
  font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
}
.canvas-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}
.canvas-stage-host {
  flex: 1;
  min-width: 0;
  height: 100%;
  background-color: #ececed;
  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.06) 1px, transparent 1px);
  background-size: 22px 22px;
}
</style>

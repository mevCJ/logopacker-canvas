<template>
  <aside class="agent-log">
    <header class="al-header">
      <div class="al-title">
        <span class="al-dot" :class="{ active: isWorking }" />
        {{ isWorking ? 'Agent is working' : 'Agent activity' }}
      </div>
      <button v-if="activityLog.length" class="al-clear" title="Clear activity" @click="store.clearActivityLog()">
        Clear
      </button>
    </header>

    <div ref="scroller" class="al-scroll">
      <div v-if="!activityLog.length" class="al-empty">
        <p class="al-empty-title">Waiting for the agent</p>
        <p class="al-empty-sub">
          Ask your agent to operate the canvas — for example,
          <em>“Create a complete logo handoff package.”</em>
        </p>
        <ul class="al-prompts">
          <li v-for="p in examplePrompts" :key="p">{{ p }}</li>
        </ul>
      </div>

      <div v-for="group in activityLog" :key="group.id" class="al-group">
        <div class="al-group-head">
          <span class="al-status" :class="group.status">
            <template v-if="group.status === 'running'">⋯</template>
            <template v-else-if="group.status === 'error'">!</template>
            <template v-else>✓</template>
          </span>
          <span class="al-group-title">{{ group.title }}</span>
        </div>
        <ul class="al-steps">
          <li v-for="step in group.steps" :key="step.id" class="al-step" :class="step.status">
            <span class="al-check">
              <template v-if="step.status === 'running'">⋯</template>
              <template v-else-if="step.status === 'error'">✕</template>
              <template v-else>✓</template>
            </span>
            <span class="al-step-label">{{ step.label }}</span>
          </li>
        </ul>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'

const store = useCanvasStore()
const { activityLog, currentGroup } = storeToRefs(store)

const scroller = ref<HTMLElement | null>(null)

const isWorking = computed(() => !!currentGroup.value)

const examplePrompts = [
  'Make the logo monochrome.',
  'Create a symbol-only version of this logo.',
  'Add the tagline “Built for what’s next” below the logo.',
  'Find a minimal architecture image and make a social card.',
  'Move the wordmark below the symbol and center it.',
]

const totalSteps = computed(() =>
  activityLog.value.reduce((n, g) => n + 1 + (g.steps?.length || 0), 0),
)

watch(totalSteps, async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
})
</script>

<style scoped>
.agent-log {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fbfbfc;
  border-left: 1px solid #e4e4e7;
  font-family: Inter, sans-serif;
}
.al-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #ececee;
}
.al-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #211a43;
  font-size: 14px;
}
.al-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d4d4d8;
}
.al-dot.active {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
.al-clear {
  font-size: 12px;
  color: #a1a1aa;
  background: none;
  border: none;
  cursor: pointer;
}
.al-clear:hover {
  color: #71717a;
}
.al-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.al-empty {
  color: #a1a1aa;
  padding-top: 12px;
}
.al-empty-title {
  font-weight: 600;
  color: #71717a;
  margin-bottom: 4px;
}
.al-empty-sub {
  font-size: 12px;
  line-height: 1.5;
  margin-bottom: 12px;
}
.al-prompts {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.al-prompts li {
  font-size: 12px;
  color: #52525b;
  background: #fff;
  border: 1px solid #ececee;
  border-radius: 8px;
  padding: 7px 10px;
}
.al-group {
  margin-bottom: 16px;
}
.al-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.al-group-title {
  font-weight: 600;
  font-size: 13px;
  color: #211a43;
}
.al-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  color: #fff;
  background: #22c55e;
}
.al-status.running {
  background: #6366f1;
}
.al-status.error {
  background: #ef4444;
}
.al-steps {
  list-style: none;
  padding: 0 0 0 4px;
  margin: 0;
  border-left: 2px solid #ececee;
}
.al-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0 4px 12px;
  font-size: 13px;
  color: #3f3f46;
}
.al-check {
  color: #22c55e;
  font-weight: 700;
  line-height: 1.4;
}
.al-step.running .al-check {
  color: #6366f1;
}
.al-step.error .al-check {
  color: #ef4444;
}
.al-step-label {
  line-height: 1.4;
}
</style>

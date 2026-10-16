<template>
  <div class="fp" :class="{ compact }">
    <button ref="trigger" type="button" class="fp-trigger" :title="currentLabel" @click="toggle">
      <span class="fp-current" :style="{ fontFamily: cssFontFamily(modelValue) }">{{ currentLabel }}</span>
      <span class="fp-caret">▾</span>
    </button>

    <div v-if="open" ref="pop" class="fp-pop" :style="popStyle">
      <input ref="search" v-model="query" class="fp-search" placeholder="Search fonts" @keydown.escape.stop="open = false" />
      <div class="fp-list">
        <template v-for="g in groups" :key="g.label">
          <div v-if="g.items.length" class="fp-group">{{ g.label }}</div>
          <button
            v-for="f in g.items"
            :key="f.family"
            type="button"
            class="fp-item"
            :class="{ active: familyKey(f.family) === familyKey(modelValue) }"
            @click="pick(f.family)"
          >
            <span class="fp-name" :style="{ fontFamily: cssFontFamily(f.family) }">{{ f.label }}</span>
            <span class="fp-count">{{ f.faces.length > 1 ? `${f.faces.length} styles` : '' }}</span>
          </button>
        </template>
        <p v-if="!total" class="fp-empty">No fonts match “{{ query }}”.</p>
        <p v-if="hidden" class="fp-empty">{{ hidden }} more — refine the search.</p>
      </div>
      <div class="fp-foot">
        <button
          v-if="fontLibrary.localStatus !== 'granted' && fontLibrary.localStatus !== 'unsupported'"
          type="button"
          class="fp-action"
          :disabled="fontLibrary.localStatus === 'loading'"
          @click="useLocal"
        >
          {{ fontLibrary.localStatus === 'loading' ? 'Reading fonts…' : 'Use installed fonts' }}
        </button>
        <label class="fp-action">
          <input type="file" accept=".ttf,.otf,.woff,.woff2,font/*" multiple @change="onFiles" />
          Add font file…
        </label>
      </div>
      <p v-if="message" class="fp-msg">{{ message }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { addFontFiles, familyKey, findFont, fontLibrary, loadLocalFonts, type FontEntry } from '@/services/canvas/fontLibrary'
import { cssFontFamily } from '@/services/canvas/textLayout'

const props = withDefaults(defineProps<{ modelValue: string; compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ (e: 'update:modelValue', family: string): void }>()

const LIMIT = 300
const open = ref(false)
const query = ref('')
const message = ref('')
const trigger = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const search = ref<HTMLInputElement | null>(null)
const popStyle = ref<Record<string, string>>({})

const currentLabel = computed(() => findFont(props.modelValue)?.label ?? familyKey(props.modelValue))

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return fontLibrary.fonts.filter((f) => !q || f.label.toLowerCase().includes(q))
})
const groups = computed(() => {
  let budget = LIMIT
  const take = (list: FontEntry[]) => {
    const out = list.slice(0, Math.max(0, budget))
    budget -= out.length
    return out
  }
  return [
    { label: 'Built-in', items: take(filtered.value.filter((f) => f.source === 'builtin')) },
    { label: 'Added', items: take(filtered.value.filter((f) => f.source === 'uploaded')) },
    { label: 'On this computer', items: take(filtered.value.filter((f) => f.source === 'local')) },
  ]
})
const total = computed(() => filtered.value.length)
const hidden = computed(() => Math.max(0, total.value - LIMIT))

function toggle() {
  open.value = !open.value
  message.value = ''
  if (!open.value) return
  // Fixed popover under the trigger (hosts may clip overflow).
  const r = trigger.value!.getBoundingClientRect()
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 268))
  popStyle.value = { left: `${left}px`, top: `${r.bottom + 6}px` }
  nextTick(() => search.value?.focus())
}

function pick(family: string) {
  emit('update:modelValue', family)
  open.value = false
  query.value = ''
}

async function useLocal() {
  message.value = ''
  try {
    const n = await loadLocalFonts()
    message.value = `${n} installed font families available.`
  } catch (err) {
    message.value = (err as Error).message
  }
}

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  message.value = ''
  try {
    const added = await addFontFiles(files)
    if (added.length === 1) pick(added[0]!.family)
    else message.value = `Added ${added.length} fonts (this session).`
  } catch (err) {
    message.value = `Couldn’t load that font: ${(err as Error).message}`
  }
}

function onDocDown(e: MouseEvent) {
  const t = e.target as Node
  if (open.value && !pop.value?.contains(t) && !trigger.value?.contains(t)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocDown))
</script>

<style scoped>
.fp {
  position: relative;
  min-width: 0;
}
.fp-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.fp.compact .fp-trigger {
  height: 26px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 12px;
  width: 150px;
}
.fp-current {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-caret {
  color: #a1a1aa;
  font-size: 10px;
}
.fp-pop {
  position: fixed;
  width: 260px;
  max-height: min(440px, calc(100vh - 140px));
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(24, 24, 27, 0.18);
  z-index: 70;
  overflow: hidden;
  font-family: Inter, sans-serif;
}
.fp-search {
  margin: 8px;
  padding: 7px 9px;
  border: 1px solid #e4e4e7;
  border-radius: 7px;
  font-size: 13px;
}
.fp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px 6px;
}
.fp-group {
  font-size: 11px;
  color: #a1a1aa;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 8px 6px 4px;
}
.fp-item {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #211a43;
  cursor: pointer;
  text-align: left;
}
.fp-item:hover {
  background: #f4f4f5;
}
.fp-item.active {
  background: #e0e7ff;
}
.fp-name {
  flex: 1;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-count {
  font-size: 11px;
  color: #a1a1aa;
  font-family: Inter, sans-serif;
}
.fp-empty {
  font-size: 12px;
  color: #a1a1aa;
  padding: 8px;
  margin: 0;
}
.fp-foot {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid #f0f0f2;
}
.fp-action {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #e4e4e7;
  border-radius: 7px;
  background: #fff;
  color: #211a43;
  font-size: 12px;
  text-align: center;
  cursor: pointer;
}
.fp-action input {
  display: none;
}
.fp-action:disabled {
  opacity: 0.5;
}
.fp-msg {
  margin: 0;
  padding: 0 10px 8px;
  font-size: 11px;
  color: #71717a;
}
</style>

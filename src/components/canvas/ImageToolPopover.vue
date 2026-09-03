<template>
  <div class="image-popover" :style="anchorStyle" @mousedown.stop @wheel.stop>
    <header class="ip-header">
      <span class="ip-title">Add image</span>
      <button class="ip-close" title="Close" @click="emit('close')">×</button>
    </header>

    <p v-if="staged" class="ip-staged">
      Ready to place — click on the canvas.
      <button class="ip-link" @click="clearStaged">Clear</button>
    </p>

    <!-- Upload -->
    <section class="ip-section">
      <label class="ip-upload">
        <input type="file" accept="image/*" class="ip-file" @change="onFile" />
        <span>Upload from device</span>
      </label>
    </section>

    <div class="ip-divider"><span>or</span></div>

    <!-- Pexels search -->
    <section class="ip-section">
      <form class="ip-search" @submit.prevent="search">
        <input
          v-model="query"
          type="text"
          class="ip-input"
          placeholder="Search Pexels…"
          @keydown.stop
        />
        <button class="ip-btn" type="submit" :disabled="loading || !query.trim()">
          {{ loading ? '…' : 'Search' }}
        </button>
      </form>

      <p v-if="error" class="ip-error">{{ error }}</p>

      <div v-if="results.length" class="ip-grid">
        <button
          v-for="r in results"
          :key="r.id"
          class="ip-thumb"
          :class="{ selected: staged && staged.href === r.src }"
          :title="r.alt || `Photo by ${r.photographer || 'Pexels'}`"
          @click="pick(r)"
        >
          <img :src="r.thumb" :alt="r.alt" loading="lazy" />
        </button>
      </div>
      <p v-else-if="searched && !loading && !error" class="ip-empty">No results.</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useCanvasStore } from '@/stores/canvas'
import {
  readFileAsDataUrl,
  probeImageSize,
  pexelsResultToPending,
  type PexelsResult,
} from '@/services/canvas/userTools'

const props = defineProps<{ anchor?: { left: number; top: number } | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const store = useCanvasStore()
const { pendingImage } = storeToRefs(store)

const query = ref('')
const results = ref<PexelsResult[]>([])
const loading = ref(false)
const error = ref('')
const searched = ref(false)

const staged = computed(() => pendingImage.value)

const anchorStyle = computed(() => {
  const a = props.anchor
  if (!a) return {}
  return { left: `${a.left}px`, top: `${a.top}px` }
})

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files && input.files[0]
  if (!file) return
  error.value = ''
  try {
    const href = await readFileAsDataUrl(file)
    const size = await probeImageSize(href)
    store.setPendingImage({
      href,
      sourceUrl: file.name,
      alt: file.name,
      width: size.width,
      height: size.height,
    })
    emit('close')
  } catch (err) {
    error.value = (err as Error)?.message || 'Could not read that file.'
  } finally {
    input.value = ''
  }
}

async function search() {
  const q = query.value.trim()
  if (!q) return
  loading.value = true
  error.value = ''
  searched.value = true
  try {
    const params = new URLSearchParams({ query: q, perPage: '12' })
    const res = await fetch(`/api/pexels/search?${params.toString()}`)
    if (!res.ok) throw new Error(`Search failed (${res.status})`)
    const data = await res.json()
    results.value = (data && data.results) || []
  } catch (err) {
    error.value = (err as Error)?.message || 'Search failed.'
    results.value = []
  } finally {
    loading.value = false
  }
}

function pick(r: PexelsResult) {
  store.setPendingImage(pexelsResultToPending(r))
  emit('close')
}

function clearStaged() {
  store.setPendingImage(null)
}
</script>

<style scoped>
.image-popover {
  position: absolute;
  z-index: 25;
  width: 300px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 14px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(24, 24, 27, 0.16);
  font-family: Inter, sans-serif;
}
.ip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.ip-title {
  font-weight: 600;
  color: #211a43;
  font-size: 14px;
}
.ip-close {
  border: none;
  background: none;
  font-size: 20px;
  line-height: 1;
  color: #a1a1aa;
  cursor: pointer;
}
.ip-close:hover {
  color: #211a43;
}
.ip-staged {
  font-size: 12px;
  color: #16a34a;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  padding: 6px 8px;
  margin: 0 0 10px;
}
.ip-link {
  border: none;
  background: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 12px;
  padding: 0 0 0 4px;
}
.ip-section {
  margin-bottom: 10px;
}
.ip-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  border: 1px dashed #d4d4d8;
  border-radius: 8px;
  font-size: 13px;
  color: #211a43;
  cursor: pointer;
}
.ip-upload:hover {
  background: #f4f4f5;
}
.ip-file {
  display: none;
}
.ip-divider {
  display: flex;
  align-items: center;
  color: #a1a1aa;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 6px 0;
}
.ip-divider::before,
.ip-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e4e4e7;
}
.ip-divider span {
  padding: 0 8px;
}
.ip-search {
  display: flex;
  gap: 6px;
}
.ip-input {
  flex: 1;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 13px;
  color: #211a43;
}
.ip-btn {
  padding: 7px 12px;
  border: 1px solid #211a43;
  border-radius: 8px;
  background: #211a43;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.ip-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ip-error {
  color: #dc2626;
  font-size: 12px;
  margin: 8px 0 0;
}
.ip-empty {
  color: #a1a1aa;
  font-size: 12px;
  margin: 8px 0 0;
}
.ip-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 10px;
}
.ip-thumb {
  padding: 0;
  border: 2px solid transparent;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  background: #f4f4f5;
  aspect-ratio: 1;
}
.ip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ip-thumb.selected {
  border-color: #2563eb;
}
</style>

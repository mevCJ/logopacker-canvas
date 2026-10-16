<template>
  <div class="sd-overlay" @mousedown.self="close">
    <div class="sd" role="dialog" aria-label="Capture sketch">
      <header class="sd-head">
        <div>
          <h2 class="sd-title">{{ phase === 'source' ? 'Capture a sketch' : 'Clean up sketch' }}</h2>
          <p class="sd-sub">
            {{
              phase === 'source'
                ? 'Photograph a paper sketch with your phone, or use a photo on this computer.'
                : 'Straighten, clean and binarize, then place it — traced to vectors or as an image.'
            }}
          </p>
        </div>
        <button type="button" class="sd-x" title="Close (Esc)" @click="close">✕</button>
      </header>

      <!-- Phase 1: pick a source -->
      <section v-if="phase === 'source'" class="sd-source">
        <div class="sd-card sd-qr-card">
          <div class="sd-qr" v-html="qrSvg" />
          <div class="sd-qr-info">
            <p class="sd-step"><b>1.</b> Scan with your phone camera</p>
            <p class="sd-step"><b>2.</b> Take a photo of your sketch</p>
            <p class="sd-step"><b>3.</b> It appears here, ready to clean up</p>
            <div class="sd-link-status" :class="`is-${linkStatus}`">
              <span class="sd-dot" />{{ linkStatusText }}
            </div>
            <div v-if="receiving" class="sd-progress"><div class="sd-bar" :style="{ width: `${receiving}%` }" /></div>
            <p class="sd-private">The photo goes straight from your phone to this browser over an encrypted peer-to-peer link — it isn't uploaded to a server.</p>
            <p v-if="lanNote" class="sd-note">{{ lanNote }}</p>
            <a class="sd-url" :href="phoneUrl" target="_blank" rel="noopener">{{ phoneUrl }}</a>
          </div>
        </div>

        <label
          class="sd-card sd-drop"
          :class="{ over: dragOver }"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <input type="file" accept="image/*" @change="onFile" />
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
            <circle cx="9" cy="10" r="1.6" fill="currentColor" />
            <path d="M5 17l4.5-4 3 2.5L16 11l3 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          </svg>
          <span class="sd-drop-title">Use a photo on this computer</span>
          <span class="sd-drop-sub">Drop an image here or click to choose</span>
        </label>
      </section>

      <!-- Phase 2: cleanup studio -->
      <section v-else class="sd-studio">
        <div class="sd-panes">
          <figure class="sd-pane">
            <figcaption>
              Original
              <span class="sd-cap-hint">{{ straighten ? 'drag the corners onto the paper' : '' }}</span>
            </figcaption>
            <div class="sd-stage">
              <img v-if="originalUrl" :src="originalUrl" alt="Original photo" class="sd-img" />
              <svg
                v-if="original && straighten && corners"
                ref="cornerSvg"
                class="sd-corners"
                :viewBox="`0 0 ${original.width} ${original.height}`"
                preserveAspectRatio="xMidYMid meet"
              >
                <polygon :points="corners.map((p) => `${p.x},${p.y}`).join(' ')" class="sd-quad" :style="{ strokeWidth: handleR / 3 }" />
                <circle
                  v-for="(p, i) in corners"
                  :key="i"
                  :cx="p.x"
                  :cy="p.y"
                  :r="handleR"
                  class="sd-handle"
                  :style="{ strokeWidth: handleR / 3 }"
                  @pointerdown.prevent="startCornerDrag(i, $event)"
                />
              </svg>
            </div>
          </figure>
          <figure class="sd-pane">
            <figcaption>
              Cleaned
              <span class="sd-cap-hint">{{ processing ? 'processing…' : resultMs !== null ? `${resultMs} ms` : '' }}</span>
            </figcaption>
            <div class="sd-stage sd-stage-result">
              <canvas ref="resultCanvas" class="sd-img" />
            </div>
          </figure>
        </div>

        <aside class="sd-controls">
          <div class="sd-group">
            <label class="sd-check">
              <input v-model="straighten" type="checkbox" />
              <span>Straighten paper</span>
            </label>
            <div class="sd-inline">
              <button type="button" class="sd-mini" :disabled="!straighten" @click="autoDetect">Auto-detect</button>
              <button type="button" class="sd-mini" :disabled="!straighten" @click="resetCorners">Whole photo</button>
            </div>
          </div>

          <div class="sd-group">
            <label class="sd-check">
              <input v-model="opts.removeShadows" type="checkbox" />
              <span>Shadow &amp; glare removal</span>
            </label>
            <label class="sd-check">
              <input v-model="opts.moire" type="checkbox" />
              <span>Screen moiré removal <em>(photos of screens)</em></span>
            </label>
          </div>

          <div class="sd-group">
            <label class="sd-label">Texture &amp; wrinkle smoothing <span>{{ pct(opts.smoothing) }}</span></label>
            <input v-model.number="opts.smoothing" type="range" min="0" max="1" step="0.05" />
          </div>

          <div class="sd-group">
            <label class="sd-label">Ink color filter</label>
            <select v-model="opts.colorFilter" class="sd-select">
              <option value="none">Keep all marks</option>
              <option value="darkInk">Dark ink only (drop colored marks)</option>
              <option value="removeBlue">Remove blue lines / blue pencil</option>
              <option value="removeRed">Remove red lines / margins</option>
            </select>
          </div>

          <div class="sd-group">
            <label class="sd-label">Line sensitivity <span>{{ pct(opts.sensitivity) }}</span></label>
            <input v-model.number="opts.sensitivity" type="range" min="0" max="1" step="0.05" />
            <label class="sd-label">Speck removal <span>{{ pct(opts.despeckle) }}</span></label>
            <input v-model.number="opts.despeckle" type="range" min="0" max="1" step="0.05" />
            <label class="sd-label">Stroke weight <span>{{ opts.strokeAdjust > 0 ? `+${opts.strokeAdjust}` : opts.strokeAdjust }}</span></label>
            <input v-model.number="opts.strokeAdjust" type="range" min="-2" max="2" step="1" />
          </div>

          <p v-if="error" class="sd-error">{{ error }}</p>
        </aside>
      </section>

      <footer class="sd-foot">
        <template v-if="phase === 'cleanup'">
          <button v-if="!props.sourceImageId" type="button" class="sd-btn" @click="backToSource">← Another photo</button>
          <span class="sd-foot-hint">{{ linkStatus === 'paired' ? 'Phone connected — new photos replace this one.' : '' }}</span>
          <button type="button" class="sd-btn" :disabled="!result || placing" @click="place(false)">Place as image</button>
          <button type="button" class="sd-btn sd-btn-primary" :disabled="!result || placing" @click="place(true)">
            {{ placing ? 'Tracing…' : 'Place & vectorize' }}
          </button>
        </template>
        <template v-else>
          <span class="sd-foot-hint">Tip: shoot in daylight, straight above the paper.</span>
          <button type="button" class="sd-btn" @click="close">Cancel</button>
        </template>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { useCanvasStore } from '@/stores/canvas'
import { CaptureReceiver, captureUrl, newRoomId, type LinkStatus } from '@/services/capture/captureLink'
import { CleanupSession, decodePhoto } from '@/services/capture/cleanupClient'
import { CLEANUP_DEFAULTS, type CleanupOptions, type Pt, type Rgba } from '@/services/capture/sketchCleanup'
import { placeSketch } from '@/services/capture/placeSketch'

const props = defineProps<{ sourceImageId?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const store = useCanvasStore()

const phase = ref<'source' | 'cleanup'>(props.sourceImageId ? 'cleanup' : 'source')
const error = ref('')

// ---------------------------------------------------------------------------
// Phone link (desktop end)
// ---------------------------------------------------------------------------
const roomId = newRoomId()
const linkStatus = ref<LinkStatus>('connecting')
const linkDetail = ref('')
const receiving = ref(0)
let link: CaptureReceiver | null = null

// A phone can't reach this machine's "localhost"; in dev, point the QR code
// at the LAN address instead (served by `npm run dev:lan`).
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
const devLan = typeof __DEV_LAN_HOST__ !== 'undefined' ? __DEV_LAN_HOST__ : ''
const phoneOrigin = isLocalHost && devLan ? `${location.protocol}//${devLan}${location.port ? `:${location.port}` : ''}` : location.origin
const phoneUrl = captureUrl(phoneOrigin, roomId)
const lanNote = isLocalHost
  ? devLan
    ? 'Dev mode: the code points at this computer’s network address. Run "npm run dev:lan" and keep both devices on the same Wi-Fi.'
    : 'This page is on localhost, which your phone can’t open. Serve it on your network or use the deployed app.'
  : ''
const qrSvg = ref('')

const linkStatusText = computed(() => {
  switch (linkStatus.value) {
    case 'connecting':
      return 'Starting…'
    case 'waiting':
      return 'Waiting for your phone'
    case 'pairing':
      return 'Linking with your phone…'
    case 'paired':
      return receiving.value ? `Receiving photo… ${receiving.value}%` : 'Phone connected — take a photo'
    case 'error':
      return linkDetail.value || 'Connection problem'
    default:
      return 'Closed'
  }
})

function startLink() {
  link = new CaptureReceiver(roomId, {
    onStatus: (s, d) => {
      linkStatus.value = s
      linkDetail.value = d || ''
    },
    onProgress: (meta, got) => (receiving.value = Math.round((got / meta.size) * 100)),
    onPhoto: (blob) => {
      receiving.value = 0
      loadBlob(blob)
    },
  })
  link.start()
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
const dragOver = ref(false)
function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) loadBlob(f)
}
function onDrop(e: DragEvent) {
  dragOver.value = false
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'))
  if (f) loadBlob(f)
}

// ---------------------------------------------------------------------------
// Cleanup studio
// ---------------------------------------------------------------------------
let session: CleanupSession | null = null
const original = ref<Rgba | null>(null)
const originalUrl = ref<string | null>(null)
const corners = ref<[Pt, Pt, Pt, Pt] | null>(null)
const autoCorners = ref<[Pt, Pt, Pt, Pt] | null>(null)
const straighten = ref(true)
const opts = reactive<Omit<CleanupOptions, 'corners' | 'maxSize'>>({
  colorFilter: CLEANUP_DEFAULTS.colorFilter,
  moire: CLEANUP_DEFAULTS.moire,
  removeShadows: CLEANUP_DEFAULTS.removeShadows,
  smoothing: CLEANUP_DEFAULTS.smoothing,
  sensitivity: CLEANUP_DEFAULTS.sensitivity,
  despeckle: CLEANUP_DEFAULTS.despeckle,
  strokeAdjust: CLEANUP_DEFAULTS.strokeAdjust,
})
const result = ref<Rgba | null>(null)
const resultMs = ref<number | null>(null)
const processing = ref(false)
const resultCanvas = ref<HTMLCanvasElement | null>(null)
const placing = ref(false)

const pct = (v: number) => `${Math.round(v * 100)}%`
const wholePhoto = (): [Pt, Pt, Pt, Pt] | null => {
  const o = original.value
  if (!o) return null
  return [
    { x: 0, y: 0 },
    { x: o.width, y: 0 },
    { x: o.width, y: o.height },
    { x: 0, y: o.height },
  ]
}
// Corner handle radius in source pixels (~9 screen px on a typical pane).
const handleR = computed(() => (original.value ? Math.max(original.value.width, original.value.height) / 60 : 10))

async function loadBlob(blob: Blob) {
  error.value = ''
  try {
    const img = await decodePhoto(blob)
    await loadImage(img, URL.createObjectURL(blob))
  } catch (err) {
    error.value = (err as Error).message || 'Could not read that image.'
    phase.value = 'cleanup'
  }
}

async function loadImage(img: Rgba, url: string) {
  if (originalUrl.value?.startsWith('blob:')) URL.revokeObjectURL(originalUrl.value)
  original.value = img
  originalUrl.value = url
  phase.value = 'cleanup'
  result.value = null
  session ??= new CleanupSession()
  const detected = await session.load(img)
  autoCorners.value = detected
  corners.value = detected ?? wholePhoto()
  await reprocess()
}

async function reprocess() {
  if (!session || !original.value) return
  processing.value = true
  error.value = ''
  try {
    const r = await session.process({ ...opts, corners: straighten.value ? corners.value : null })
    if (!r) return // superseded by a newer request
    result.value = r.image
    resultMs.value = r.ms
    await nextTick()
    drawResult()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    processing.value = false
  }
}

function drawResult() {
  const cv = resultCanvas.value
  const r = result.value
  if (!cv || !r) return
  cv.width = r.width
  cv.height = r.height
  cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0)
}

let debounce: ReturnType<typeof setTimeout> | null = null
watch([opts, straighten], () => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(reprocess, 150)
})

function autoDetect() {
  corners.value = autoCorners.value ?? wholePhoto()
  reprocess()
}
function resetCorners() {
  corners.value = wholePhoto()
  reprocess()
}

// --- Corner dragging --------------------------------------------------------
const cornerSvg = ref<SVGSVGElement | null>(null)
function toSource(e: PointerEvent): Pt | null {
  const svg = cornerSvg.value
  const ctm = svg?.getScreenCTM()
  if (!svg || !ctm || !original.value) return null
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
  return {
    x: Math.min(original.value.width, Math.max(0, p.x)),
    y: Math.min(original.value.height, Math.max(0, p.y)),
  }
}
function startCornerDrag(i: number, e: PointerEvent) {
  const move = (ev: PointerEvent) => {
    const p = toSource(ev)
    if (!p || !corners.value) return
    const next = [...corners.value] as [Pt, Pt, Pt, Pt]
    next[i] = p
    corners.value = next
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    reprocess()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  move(e)
}

// --- Place -------------------------------------------------------------------
async function place(vectorize: boolean) {
  const r = result.value
  if (!r || placing.value) return
  placing.value = true
  error.value = ''
  try {
    const cv = document.createElement('canvas')
    cv.width = r.width
    cv.height = r.height
    cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0)
    await placeSketch(store, {
      dataUrl: cv.toDataURL('image/png'),
      width: r.width,
      height: r.height,
      vectorize,
      replaceImageId: props.sourceImageId ?? null,
    })
    close()
  } catch (err) {
    store.undo()
    error.value = (err as Error).message
  } finally {
    placing.value = false
  }
}

function backToSource() {
  phase.value = 'source'
}

function close() {
  emit('close')
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey, true)
  if (props.sourceImageId) {
    // Clean up an image already on the canvas.
    const o = store.getObject(props.sourceImageId)
    if (!o || o.type !== 'image') {
      error.value = 'That image is no longer on the canvas.'
      return
    }
    try {
      const blob = await (await fetch(o.href)).blob()
      await loadBlob(blob)
    } catch {
      error.value = 'This image blocks pixel access (cross-origin). Upload it as a file instead.'
    }
    return
  }
  qrSvg.value = await QRCode.toString(phoneUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#211a43', light: '#ffffff' } })
  startLink()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  if (debounce) clearTimeout(debounce)
  link?.close()
  session?.dispose()
  if (originalUrl.value?.startsWith('blob:')) URL.revokeObjectURL(originalUrl.value)
})
</script>

<style scoped>
.sd-overlay {
  position: absolute;
  inset: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 27, 0.4);
  font-family: Inter, sans-serif;
}
.sd {
  width: min(1040px, calc(100% - 32px));
  height: min(680px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(24, 24, 27, 0.3);
  overflow: hidden;
  color: #211a43;
}
.sd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #f0f0f2;
}
.sd-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.sd-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: #71717a;
}
.sd-x {
  border: none;
  background: transparent;
  font-size: 16px;
  color: #71717a;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}
.sd-x:hover {
  background: #f4f4f5;
}
.sd-source {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 16px;
  padding: 20px;
}
.sd-card {
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 20px;
}
.sd-qr-card {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.sd-qr {
  width: 210px;
  height: 210px;
  flex-shrink: 0;
  border-radius: 8px;
  border: 1px solid #f0f0f2;
}
.sd-qr :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.sd-qr-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.sd-step {
  margin: 0;
}
.sd-link-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fafafa;
  font-weight: 500;
}
.sd-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
}
.sd-link-status.is-paired .sd-dot {
  background: #16a34a;
}
.sd-link-status.is-error .sd-dot {
  background: #dc2626;
}
.sd-progress {
  height: 5px;
  border-radius: 3px;
  background: #e4e4e7;
  overflow: hidden;
}
.sd-bar {
  height: 100%;
  background: #458fd5;
}
.sd-private,
.sd-note {
  margin: 0;
  font-size: 12px;
  color: #71717a;
  line-height: 1.45;
}
.sd-note {
  color: #92400e;
  background: #fffbeb;
  border-radius: 6px;
  padding: 6px 8px;
}
.sd-url {
  font-size: 11px;
  color: #a1a1aa;
  word-break: break-all;
}
.sd-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-style: dashed;
  color: #52525b;
  cursor: pointer;
  text-align: center;
}
.sd-drop.over,
.sd-drop:hover {
  border-color: #458fd5;
  background: #f5f9fd;
}
.sd-drop input {
  display: none;
}
.sd-drop-title {
  font-weight: 600;
  color: #211a43;
}
.sd-drop-sub {
  font-size: 12px;
  color: #a1a1aa;
}
.sd-studio {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  padding: 16px 20px;
}
.sd-panes {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.sd-pane {
  margin: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sd-pane figcaption {
  font-size: 12px;
  font-weight: 600;
  display: flex;
  justify-content: space-between;
}
.sd-cap-hint {
  font-weight: 400;
  color: #a1a1aa;
}
.sd-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border-radius: 10px;
  background: #f4f4f5;
  overflow: hidden;
}
.sd-stage-result {
  background: #e4e4e7;
}
.sd-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.sd-corners {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.sd-quad {
  fill: rgba(69, 143, 213, 0.12);
  stroke: #458fd5;
}
.sd-handle {
  fill: #fff;
  stroke: #458fd5;
  cursor: grab;
}
.sd-controls {
  width: 250px;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 13px;
}
.sd-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f2;
}
.sd-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.sd-check em {
  color: #a1a1aa;
  font-style: normal;
}
.sd-inline {
  display: flex;
  gap: 6px;
  padding-left: 24px;
}
.sd-mini {
  padding: 4px 8px;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  color: #211a43;
  cursor: pointer;
}
.sd-mini:disabled {
  opacity: 0.4;
  cursor: default;
}
.sd-label {
  display: flex;
  justify-content: space-between;
  color: #52525b;
}
.sd-label span {
  color: #a1a1aa;
}
.sd-select {
  padding: 6px 8px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 12px;
  color: #211a43;
  background: #fff;
}
.sd-error {
  color: #b91c1c;
  font-size: 12px;
  margin: 0;
}
.sd-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid #f0f0f2;
}
.sd-foot-hint {
  flex: 1;
  font-size: 12px;
  color: #a1a1aa;
}
.sd-btn {
  padding: 8px 14px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  background: #fff;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
}
.sd-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.sd-btn-primary {
  background: #211a43;
  border-color: #211a43;
  color: #fff;
}
</style>

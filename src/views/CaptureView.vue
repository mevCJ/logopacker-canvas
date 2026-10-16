<template>
  <main class="cap">
    <header class="cap-head">
      <img class="cap-logo" src="/android-chrome-192x192.png" alt="" />
      <div>
        <h1 class="cap-title">Send a sketch</h1>
        <p class="cap-sub">to your LogoPacker canvas</p>
      </div>
    </header>

    <div class="cap-status" :class="`is-${status}`">
      <span class="cap-dot" />
      {{ statusText }}
    </div>

    <section v-if="!validRoom" class="cap-card">
      <p>This link isn't valid. Scan the QR code on your desktop again.</p>
    </section>

    <template v-else>
      <section v-if="preview" class="cap-card cap-preview">
        <img :src="preview" alt="Your photo" />
        <div v-if="sending" class="cap-progress">
          <div class="cap-bar" :style="{ width: `${Math.round(progress * 100)}%` }" />
        </div>
        <p v-if="sent" class="cap-ok">Sent ✓ — finish cleanup on your desktop.</p>
        <p v-if="error" class="cap-err">{{ error }}</p>
      </section>

      <section v-else class="cap-card cap-tips">
        <p class="cap-tips-title">For the cleanest result</p>
        <ul>
          <li>Lay the paper flat in even light</li>
          <li>Hold the phone straight above it</li>
          <li>Fill the frame; a little table around the sheet is fine</li>
        </ul>
      </section>

      <div class="cap-actions">
        <label class="cap-btn cap-btn-primary" :class="{ disabled: !canPick }">
          <input type="file" accept="image/*" capture="environment" :disabled="!canPick" @change="onPick" />
          {{ preview ? 'Take another photo' : 'Take photo' }}
        </label>
        <label class="cap-btn" :class="{ disabled: !canPick }">
          <input type="file" accept="image/*" :disabled="!canPick" @change="onPick" />
          Choose from library
        </label>
        <button v-if="error && lastBlob" type="button" class="cap-btn" @click="send(lastBlob)">Try again</button>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { CaptureSender, type LinkStatus } from '@/services/capture/captureLink'

// Photos are downscaled on the phone before sending: faster transfer, and the
// desktop cleanup works at ≤1600px anyway (2400 keeps headroom for warping).
const SEND_MAX = 2400

const route = useRoute()
const roomId = String(route.params.room || '')
const validRoom = /^[0-9a-f]{32}$/.test(roomId)

const status = ref<LinkStatus>('connecting')
const statusDetail = ref('')
const preview = ref<string | null>(null)
const sending = ref(false)
const sent = ref(false)
const progress = ref(0)
const error = ref('')
const lastBlob = ref<Blob | null>(null)
let link: CaptureSender | null = null

const statusText = computed(() => {
  switch (status.value) {
    case 'connecting':
      return 'Connecting…'
    case 'waiting':
      return 'Waiting for your desktop — keep the QR dialog open there'
    case 'pairing':
      return 'Linking devices…'
    case 'paired':
      return sending.value ? 'Sending…' : 'Connected to your desktop'
    case 'error':
      return statusDetail.value || 'Connection problem'
    default:
      return 'Disconnected'
  }
})
const canPick = computed(() => status.value === 'paired' && !sending.value)

async function downscale(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const k = Math.min(1, SEND_MAX / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * k)
  canvas.height = Math.round(bmp.height * k)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo.'))), 'image/jpeg', 0.9),
  )
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  sent.value = false
  try {
    const blob = await downscale(file)
    if (preview.value) URL.revokeObjectURL(preview.value)
    preview.value = URL.createObjectURL(blob)
    lastBlob.value = blob
    await send(blob)
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function send(blob: Blob) {
  if (!link) return
  error.value = ''
  sending.value = true
  progress.value = 0
  try {
    await link.sendPhoto(blob, `sketch-${Date.now()}.jpg`, (s, t) => (progress.value = s / t))
    sent.value = true
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    sending.value = false
  }
}

onMounted(() => {
  if (!validRoom) return
  link = new CaptureSender(roomId, (s, detail) => {
    status.value = s
    statusDetail.value = detail || ''
  })
  link.start()
})
onBeforeUnmount(() => {
  link?.close()
  if (preview.value) URL.revokeObjectURL(preview.value)
})
</script>

<style scoped>
.cap {
  min-height: 100vh;
  max-width: 480px;
  margin: 0 auto;
  padding: 20px 16px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #211a43;
  background: #fafafa;
}
.cap-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cap-logo {
  width: 40px;
  height: 40px;
}
.cap-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}
.cap-sub {
  font-size: 13px;
  color: #71717a;
  margin: 0;
}
.cap-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #e4e4e7;
  font-size: 14px;
}
.cap-dot {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #f59e0b;
}
.cap-status.is-paired .cap-dot {
  background: #16a34a;
}
.cap-status.is-error .cap-dot,
.cap-status.is-closed .cap-dot {
  background: #dc2626;
}
.cap-card {
  padding: 14px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid #e4e4e7;
  font-size: 14px;
  line-height: 1.5;
}
.cap-tips-title {
  font-weight: 600;
  margin: 0 0 6px;
}
.cap-tips ul {
  margin: 0;
  padding-left: 18px;
  color: #52525b;
}
.cap-preview img {
  width: 100%;
  max-height: 50vh;
  object-fit: contain;
  border-radius: 8px;
  background: #f4f4f5;
  display: block;
}
.cap-progress {
  margin-top: 10px;
  height: 6px;
  border-radius: 3px;
  background: #e4e4e7;
  overflow: hidden;
}
.cap-bar {
  height: 100%;
  background: #458fd5;
  transition: width 0.1s linear;
}
.cap-ok {
  margin: 10px 0 0;
  color: #15803d;
  font-weight: 600;
}
.cap-err {
  margin: 10px 0 0;
  color: #b91c1c;
}
.cap-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: auto;
}
.cap-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  border-radius: 12px;
  border: 1px solid #d4d4d8;
  background: #fff;
  font-size: 16px;
  font-weight: 600;
  color: #211a43;
  cursor: pointer;
}
.cap-btn input {
  display: none;
}
.cap-btn-primary {
  background: #211a43;
  border-color: #211a43;
  color: #fff;
}
.cap-btn.disabled {
  opacity: 0.45;
  pointer-events: none;
}
</style>

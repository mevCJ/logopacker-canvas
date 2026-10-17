<template>
  <header class="toolbar">
    <!-- Row 1: application menu bar (Illustrator's File / Edit / Object …). -->
    <div ref="menubar" class="menubar">
      <img class="mb-logo" src="/android-chrome-512x512.png" alt="logo" />
      <nav class="mb-menus" role="menubar">
        <div v-for="menu in menus" :key="menu.id" class="mb-menu">
          <button
            type="button"
            class="mb-menu-btn"
            :class="{ open: openMenu === menu.id }"
            role="menuitem"
            :data-menu="menu.id"
            @click="toggleMenu(menu.id)"
            @mouseenter="hoverMenu(menu.id)"
          >
            {{ menu.label }}
          </button>
          <div v-if="openMenu === menu.id" class="mb-dropdown" role="menu">
            <template v-for="(item, i) in menu.items" :key="i">
              <div v-if="item === SEP" class="mb-sep" />
              <div v-else-if="'header' in item" class="mb-header">{{ item.header }}</div>
              <button
                v-else
                type="button"
                class="mb-item"
                role="menuitem"
                :disabled="item.disabled?.()"
                @click="run(item)"
              >
                <span class="mb-check">{{ item.checked?.() ? '✓' : '' }}</span>
                <span class="mb-item-label">{{ item.label }}</span>
                <span v-if="item.keys" class="mb-keys">{{ fmtKeys(item.keys) }}</span>
              </button>
            </template>
          </div>
        </div>
      </nav>

      <span class="mb-doc">{{ docLabel }}</span>

      <div class="mb-right">
        <button
          class="tb-btn tb-icon"
          :class="{ 'tb-btn-active': activityOpen }"
          :title="activityOpen ? 'Hide agent activity' : 'Show agent activity'"
          @click="emit('toggle-activity')"
        >
          <IconAgent :is-outline="!activityOpen" />
        </button>
        <button class="tb-btn tb-btn--cta" title="Export (Shift+Cmd/Ctrl+E)" @click="emit('export')">Export</button>
      </div>
    </div>

    <!-- Row 2: contextual Control bar. -->
    <ControlBar @fit-view="emit('fit-view')" />
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCanvasStore } from '@/stores/canvas'
import { applyPathfinder, type PathfinderOp } from '@/services/canvas/pathBoolean'
import { vectorizeImageObject } from '@/services/canvas/vectorize'
import IconAgent from '../icons/IconAgent.vue'
import ControlBar from './ControlBar.vue'
import { openSketchDialog } from '@/services/capture/captureState'
import { addFontFiles, fontLibrary, loadLocalFonts } from '@/services/canvas/fontLibrary'
import { createOutlines } from '@/services/canvas/textOutlines'
import { expandAppearance, hasVisibleStroke } from '@/services/canvas/expandAppearance'
import { canJoin, joinSelection, reflectSelection } from '@/services/canvas/pathEdit'
import { snapSettings } from '@/services/canvas/snapSettings'

const emit = defineEmits<{
  (e: 'fit-view'): void
  (e: 'toggle-activity'): void
  (e: 'export'): void
  (e: 'save'): void
  (e: 'load'): void
}>()

defineProps<{ activityOpen?: boolean }>()

const store = useCanvasStore()

// ---------------------------------------------------------------------------
// Menu model
// ---------------------------------------------------------------------------
// `keys` is a shortcut spec: mod = Cmd on Mac / Ctrl elsewhere, plus
// shift/alt and a key (matched against KeyboardEvent.code when it starts
// with "Key"/"Digit"/"Bracket" so Option-modified keys still match).
interface Keys {
  mod?: boolean
  shift?: boolean
  alt?: boolean
  key: string
  // Typed characters that also trigger it (layout-independent, e.g. '>' sits
  // on a different physical key on many non-US keyboards).
  chars?: string[]
  // Shown in the menu but handled elsewhere (CanvasStage owns these).
  displayOnly?: boolean
}
interface Item {
  label: string
  keys?: Keys
  action: () => unknown
  disabled?: () => boolean
  checked?: () => boolean
}
const SEP = 'sep' as const
type Entry = Item | typeof SEP | { header: string }
interface Menu {
  id: string
  label: string
  items: Entry[]
}

const hasSel = () => store.selectedIds.length > 0
const selPaths = () => store.selectedObjects.filter((o) => o.type === 'path')
const forSel = (label: string, fn: (id: string) => unknown) => () => {
  if (!hasSel()) return
  store.snapshot(label)
  ;[...store.selectedIds].forEach(fn)
}

async function pathfinder(op: PathfinderOp) {
  const ids = selPaths().map((o) => o.id)
  if (ids.length < 2) return
  store.snapshot('Pathfinder')
  try {
    store.selectObjects(await applyPathfinder(store, ids, op))
  } catch (err) {
    store.undo()
    window.alert((err as Error).message)
  }
}

async function imageTrace() {
  const o = store.singleSelected
  if (!o || o.type !== 'image') return
  store.snapshot('Vectorize')
  try {
    store.selectObjects(await vectorizeImageObject(store, o.id))
  } catch (err) {
    store.undo()
    window.alert((err as Error).message)
  }
}

function arrange(dir: 'front' | 'forward' | 'backward' | 'back') {
  if (!hasSel()) return
  store.snapshot('Arrange')
  // Step moves process front-most first when moving forward (and vice versa)
  // so neighbors in the selection don't leapfrog each other.
  const ids = store.objectOrder.filter((id) => store.selectedIds.includes(id))
  if (dir === 'front') ids.forEach((id) => store.bringToFront(id))
  if (dir === 'back') [...ids].reverse().forEach((id) => store.sendToBack(id))
  if (dir === 'forward') [...ids].reverse().forEach((id) => store.shiftObject(id, 1))
  if (dir === 'backward') ids.forEach((id) => store.shiftObject(id, -1))
}

const selTexts = () => store.selectedObjects.filter((o) => o.type === 'text')

function bumpFont(dir: 1 | -1) {
  const ids = selTexts().map((o) => o.id)
  if (!ids.length) return
  store.snapshot(dir > 0 ? 'Increase font size' : 'Decrease font size')
  store.bumpFontSize(ids, dir * 2)
}

async function outlines() {
  const ids = selTexts().map((o) => o.id)
  if (!ids.length) return
  store.snapshot('Create outlines')
  try {
    store.selectObjects(await createOutlines(store, ids))
  } catch (err) {
    store.undo()
    window.alert((err as Error).message)
  }
}

// Object ▸ Group / Ungroup (⌘G / ⇧⌘G).
const selectionUnits = () => new Set(store.selectedIds.map((id) => store.topGroupOf(id) ?? id))
const canGroup = () => selectionUnits().size >= 2
const canUngroup = () => store.selectedIds.some((id) => store.topGroupOf(id))
function group() {
  if (!canGroup()) return
  store.snapshot('Group')
  const gid = store.groupObjects([...store.selectedIds])
  if (gid) store.selectObjects(store.groupMembers(gid))
}
function ungroup() {
  if (!canUngroup()) return
  store.snapshot('Ungroup')
  store.selectObjects(store.ungroupObjects([...store.selectedIds]))
}

// Object ▸ Expand Appearance: strokes become filled outlines.
async function expand() {
  const ids = store.selectedObjects.filter(hasVisibleStroke).map((o) => o.id)
  if (!ids.length) return
  store.snapshot('Expand Appearance')
  try {
    const out = await expandAppearance(store, [...store.selectedIds])
    store.selectObjects(out)
  } catch (err) {
    store.undo()
    window.alert((err as Error).message)
  }
}

async function useInstalledFonts() {
  try {
    const n = await loadLocalFonts()
    window.alert(`${n} installed font families are now in the font menus.`)
  } catch (err) {
    window.alert((err as Error).message)
  }
}

function addFontFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.ttf,.otf,.woff,.woff2,font/*'
  input.multiple = true
  input.onchange = async () => {
    const files = [...(input.files ?? [])]
    if (!files.length) return
    try {
      const added = await addFontFiles(files)
      window.alert(`Added ${added.map((f) => f.label).join(', ')} for this session.`)
    } catch (err) {
      window.alert(`Couldn\u2019t load that font: ${(err as Error).message}`)
    }
  }
  input.click()
}

function duplicate() {
  if (!hasSel()) return
  store.snapshot('Duplicate')
  const dups = store.duplicateObjects([...store.selectedIds])
  if (dups.length) store.selectObjects(dups.map((d) => d.id))
}

const menus = computed<Menu[]>(() => [
  {
    id: 'file',
    label: 'File',
    items: [
      { label: 'Open…', keys: { mod: true, key: 'KeyO' }, action: () => emit('load') },
      { label: 'Save', keys: { mod: true, key: 'KeyS' }, action: () => emit('save') },
      SEP,
      { label: 'Capture Sketch from Phone…', action: () => openSketchDialog() },
      SEP,
      { label: 'Export…', keys: { mod: true, shift: true, key: 'KeyE' }, action: () => emit('export') },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      {
        label: store.history.length ? `Undo ${store.history[store.history.length - 1]!.label}` : 'Undo',
        keys: { mod: true, key: 'KeyZ', displayOnly: true },
        action: () => store.undo(),
        disabled: () => !store.history.length,
      },
      SEP,
      { label: 'Duplicate', keys: { mod: true, key: 'KeyD', displayOnly: true }, action: duplicate, disabled: () => !hasSel() },
      {
        label: 'Delete',
        keys: { key: '⌫', displayOnly: true },
        action: forSel('Delete', (id) => store.removeObject(id)),
        disabled: () => !hasSel(),
      },
    ],
  },
  {
    id: 'object',
    label: 'Object',
    items: [
      { header: 'Arrange' },
      { label: 'Bring to Front', keys: { mod: true, shift: true, key: 'BracketRight' }, action: () => arrange('front'), disabled: () => !hasSel() },
      { label: 'Bring Forward', keys: { mod: true, key: 'BracketRight' }, action: () => arrange('forward'), disabled: () => !hasSel() },
      { label: 'Send Backward', keys: { mod: true, key: 'BracketLeft' }, action: () => arrange('backward'), disabled: () => !hasSel() },
      { label: 'Send to Back', keys: { mod: true, shift: true, key: 'BracketLeft' }, action: () => arrange('back'), disabled: () => !hasSel() },
      SEP,
      { label: 'Group', keys: { mod: true, key: 'KeyG' }, action: group, disabled: () => !canGroup() },
      { label: 'Ungroup', keys: { mod: true, shift: true, key: 'KeyG' }, action: ungroup, disabled: () => !canUngroup() },
      SEP,
      { label: 'Lock Selection', keys: { mod: true, key: 'Digit2' }, action: forSel('Lock', (id) => store.setObjectLocked(id, true)), disabled: () => !hasSel() },
      {
        label: 'Unlock All',
        keys: { mod: true, alt: true, key: 'Digit2' },
        action: () => {
          store.snapshot('Unlock all')
          store.orderedObjects.forEach((o) => o.locked && store.setObjectLocked(o.id, false))
        },
        disabled: () => !store.orderedObjects.some((o) => o.locked),
      },
      { label: 'Hide Selection', keys: { mod: true, key: 'Digit3' }, action: forSel('Hide', (id) => store.setObjectHidden(id, true)), disabled: () => !hasSel() },
      {
        label: 'Show All',
        keys: { mod: true, alt: true, key: 'Digit3' },
        action: () => {
          store.snapshot('Show all')
          store.orderedObjects.forEach((o) => o.hidden && store.setObjectHidden(o.id, false))
        },
        disabled: () => !store.orderedObjects.some((o) => o.hidden),
      },
      SEP,
      { header: 'Transform' },
      { label: 'Reflect Horizontal', action: () => reflectSelection(store, 'horizontal'), disabled: () => !hasSel() },
      { label: 'Reflect Vertical', action: () => reflectSelection(store, 'vertical'), disabled: () => !hasSel() },
      SEP,
      { header: 'Path' },
      { label: 'Join', keys: { mod: true, key: 'KeyJ' }, action: () => joinSelection(store), disabled: () => !canJoin(store, store.selectedIds) },
      { label: 'Expand Appearance', action: expand, disabled: () => !store.selectedObjects.some(hasVisibleStroke) },
      SEP,
      { header: 'Pathfinder' },
      { label: 'Unite', action: () => pathfinder('unite'), disabled: () => selPaths().length < 2 },
      { label: 'Minus Front', action: () => pathfinder('minusFront'), disabled: () => selPaths().length < 2 },
      { label: 'Intersect', action: () => pathfinder('intersect'), disabled: () => selPaths().length < 2 },
      { label: 'Exclude', action: () => pathfinder('exclude'), disabled: () => selPaths().length < 2 },
      SEP,
      { label: 'Image Trace', action: imageTrace, disabled: () => store.singleSelected?.type !== 'image' },
      {
        label: 'Clean Up Sketch…',
        action: () => openSketchDialog(store.singleSelected!.id),
        disabled: () => store.singleSelected?.type !== 'image',
      },
      SEP,
      { header: 'Artboards' },
      {
        label: 'New Artboard',
        action: () => {
          store.snapshot('Add artboard')
          store.addArtboardAuto({ name: `Artboard ${store.artboards.length + 1}`, width: 400, height: 400 })
        },
      },
      {
        label: 'Fit to Artwork Bounds',
        action: () => {
          const ab = store.selectedArtboard ?? store.artboards[0]
          if (!ab) return
          store.snapshot('Fit artboard to artwork')
          store.fitArtboardToArtwork(ab.id)
        },
        disabled: () => !store.artboards.length,
      },
    ],
  },
  {
    id: 'type',
    label: 'Type',
    items: [
      { header: 'Fonts' },
      {
        label: fontLibrary.localStatus === 'granted' ? 'Installed Fonts Loaded' : 'Use Installed Fonts…',
        action: useInstalledFonts,
        disabled: () => fontLibrary.localStatus === 'granted' || fontLibrary.localStatus === 'unsupported',
      },
      { label: 'Add Font File…', action: addFontFile },
      SEP,
      { label: 'Increase Font Size', keys: { mod: true, shift: true, key: 'Period', chars: ['>'] }, action: () => bumpFont(1), disabled: () => !selTexts().length },
      { label: 'Decrease Font Size', keys: { mod: true, shift: true, key: 'Comma', chars: ['<'] }, action: () => bumpFont(-1), disabled: () => !selTexts().length },
      SEP,
      { label: 'Create Outlines', keys: { mod: true, shift: true, key: 'KeyO' }, action: outlines, disabled: () => !selTexts().length },
      SEP,
      { label: 'Type on a Path Tool', action: () => store.setActiveTool('textPath') },
    ],
  },
  {
    id: 'select',
    label: 'Select',
    items: [
      {
        label: 'All',
        keys: { mod: true, key: 'KeyA' },
        action: () => store.selectObjects([...store.objectOrder]),
      },
      { label: 'Deselect', keys: { mod: true, shift: true, key: 'KeyA' }, action: () => store.clearSelection(), disabled: () => !hasSel() },
      SEP,
      {
        label: 'Same Fill Color',
        action: () => {
          const f = store.singleSelected && store.singleSelected.type !== 'image' ? store.singleSelected.fill : null
          if (f) store.selectObjects(store.orderedObjects.filter((o) => o.type !== 'image' && o.fill === f).map((o) => o.id))
        },
        disabled: () => !store.singleSelected || store.singleSelected.type === 'image',
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      {
        label: 'Outline',
        keys: { mod: true, key: 'KeyY', displayOnly: true },
        action: () => store.toggleViewMode(),
        checked: () => store.viewMode === 'outline',
      },
      SEP,
      {
        label: 'Smart Guides',
        keys: { mod: true, key: 'KeyU' },
        action: () => (snapSettings.smartGuides = !snapSettings.smartGuides),
        checked: () => snapSettings.smartGuides,
      },
      {
        label: 'Snap to Point',
        keys: { mod: true, alt: true, key: 'Quote' },
        action: () => (snapSettings.snapToPoint = !snapSettings.snapToPoint),
        checked: () => snapSettings.snapToPoint,
      },
      SEP,
      { label: 'Fit All in Window', keys: { mod: true, key: 'Digit0' }, action: () => emit('fit-view') },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [{ label: 'Agent Activity', action: () => emit('toggle-activity') }],
  },
])

// ---------------------------------------------------------------------------
// Menu open/close (menubar semantics: once one is open, hovering switches)
// ---------------------------------------------------------------------------
const openMenu = ref<string | null>(null)
const menubar = ref<HTMLElement | null>(null)

function toggleMenu(id: string) {
  openMenu.value = openMenu.value === id ? null : id
}
function hoverMenu(id: string) {
  if (openMenu.value) openMenu.value = id
}
function run(item: Item) {
  openMenu.value = null
  if (item.disabled?.()) return
  item.action()
}
function onDocDown(e: MouseEvent) {
  if (openMenu.value && !menubar.value?.contains(e.target as Node)) openMenu.value = null
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'BracketRight') return ']'
  if (code === 'BracketLeft') return '['
  // Font size shortcuts read as Illustrator's ⇧⌘> / ⇧⌘<.
  if (code === 'Quote') return '"'
  if (code === 'Period') return '>'
  if (code === 'Comma') return '<'
  return code
}
function fmtKeys(k: Keys): string {
  const key = keyName(k.key)
  if (isMac) return `${k.alt ? '⌥' : ''}${k.shift ? '⇧' : ''}${k.mod ? '⌘' : ''}${key}`
  return [k.mod && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', key].filter(Boolean).join('+')
}

function onKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.isContentEditable) return
  if (e.key === 'Escape' && openMenu.value) {
    openMenu.value = null
    return
  }
  const mod = isMac ? e.metaKey : e.ctrlKey
  for (const menu of menus.value) {
    for (const entry of menu.items) {
      if (entry === SEP || 'header' in entry || !entry.keys || entry.keys.displayOnly) continue
      const k = entry.keys
      if (!!k.mod !== mod || !!k.shift !== e.shiftKey || !!k.alt !== e.altKey) continue
      if (k.key !== e.code && !k.chars?.includes(e.key)) continue
      e.preventDefault()
      if (!entry.disabled?.()) entry.action()
      return
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('mousedown', onDocDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('mousedown', onDocDown)
})

const docLabel = computed(() => {
  const n = store.artboards.length
  const zoomless = `${n} artboard${n === 1 ? '' : 's'}`
  return store.viewMode === 'outline' ? `${zoomless} · Outline` : zoomless
})
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  font-family: Inter, sans-serif;
  position: relative;
  z-index: 35;
}
.menubar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid #f0f0f2;
}
.mb-logo {
  width: 24px;
  height: 24px;
  margin-right: 6px;
}
.mb-menus {
  display: flex;
  align-items: center;
}
.mb-menu {
  position: relative;
}
.mb-menu-btn {
  padding: 5px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
}
.mb-menu-btn:hover,
.mb-menu-btn.open {
  background: #f4f4f5;
}
.mb-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 240px;
  padding: 5px;
  background: #fff;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(24, 24, 27, 0.16);
  z-index: 60;
}
.mb-header {
  font-size: 11px;
  color: #a1a1aa;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 6px 10px 3px 26px;
}
.mb-sep {
  height: 1px;
  background: #f0f0f2;
  margin: 4px 6px;
}
.mb-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 6px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #211a43;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.mb-item:hover:not(:disabled) {
  background: #211a43;
  color: #fff;
}
.mb-item:hover:not(:disabled) .mb-keys {
  color: #c7c4d8;
}
.mb-item:disabled {
  color: #c4c4cc;
  cursor: default;
}
.mb-check {
  width: 16px;
  text-align: center;
  font-size: 12px;
}
.mb-item-label {
  flex: 1;
}
.mb-keys {
  font-size: 12px;
  color: #a1a1aa;
  margin-left: 16px;
}
.mb-doc {
  margin-left: 10px;
  font-size: 12px;
  color: #a1a1aa;
}
.mb-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tb-btn {
  padding: 4px 12px;
  border-radius: 8px;
  border: 1px solid #e4e4e7;
  background: #fff;
  color: #211a43;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s ease;
}
.tb-btn:hover:not(:disabled) {
  background: #f4f4f5;
}
.tb-icon {
  padding: 2px 6px;
  display: flex;
  align-items: center;
}
.tb-btn-active {
  background: #211a43;
  border-color: #211a43;
  color: #fff;
}
.tb-btn-active:hover:not(:disabled) {
  background: #2d2456;
}
.tb-btn--cta {
  background: #458fd5;
  border-color: #458fd5;
  color: white;
  padding: 5px 14px;
}
.tb-btn--cta:hover:not(:disabled) {
  background: #346ea4 !important;
}
</style>

// Smart Guides / Snap to Point toggles (View menu). A per-browser preference,
// not document state, so it's remembered in localStorage.
import { reactive, watch } from 'vue'

const KEY = 'logopacker.snap'

function load(): { smartGuides: boolean; snapToPoint: boolean } {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null
    const v = raw ? JSON.parse(raw) : null
    return { smartGuides: v?.smartGuides !== false, snapToPoint: v?.snapToPoint !== false }
  } catch {
    return { smartGuides: true, snapToPoint: true }
  }
}

export const snapSettings = reactive(load())

watch(
  () => ({ ...snapSettings }),
  (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v))
    } catch {
      /* private mode / blocked storage: keep in memory */
    }
  },
)

// Snap distance in screen pixels (converted to canvas units at the current
// zoom, so snapping feels the same zoomed in or out).
export const SNAP_PX = 6

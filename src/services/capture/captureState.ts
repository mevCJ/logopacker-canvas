// Open state for the sketch capture/cleanup dialog. Lives outside the store
// (it's UI, not document state) so any component — menus, the control bar,
// the property panel — can open it without prop/emit plumbing.
import { reactive } from 'vue'

export const sketchDialog = reactive<{
  open: boolean
  // When set, the dialog cleans up this existing image object instead of
  // waiting for a phone/file photo.
  sourceImageId: string | null
}>({ open: false, sourceImageId: null })

export function openSketchDialog(sourceImageId: string | null = null): void {
  sketchDialog.sourceImageId = sourceImageId
  sketchDialog.open = true
}

export function closeSketchDialog(): void {
  sketchDialog.open = false
  sketchDialog.sourceImageId = null
}

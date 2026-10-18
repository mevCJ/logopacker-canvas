// The letters picked for styling: a character range of one text object,
// chosen by selecting text in the in-place editor. It outlives the editor
// (clicking a color in a panel closes it) so the panels can style just those
// letters; it clears when that object stops being the selection.
import { reactive } from 'vue'

export const letterSelection = reactive<{ id: string | null; start: number; end: number }>({ id: null, start: 0, end: 0 })

export function setLetterSelection(id: string, start: number, end: number): void {
  if (end <= start) return clearLetterSelection()
  letterSelection.id = id
  letterSelection.start = start
  letterSelection.end = end
}

export function clearLetterSelection(): void {
  letterSelection.id = null
  letterSelection.start = 0
  letterSelection.end = 0
}

// The picked range on this object, if any.
export function letterRangeFor(id: string | null | undefined): { start: number; end: number } | null {
  return id && letterSelection.id === id && letterSelection.end > letterSelection.start
    ? { start: letterSelection.start, end: letterSelection.end }
    : null
}

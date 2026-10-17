// "Pick a color from the canvas" while a color picker is open. The most
// recently opened picker receives the pick; the canvas swallows that click
// (it doesn't select anything) and the picker closes itself.
import { computed, shallowReactive } from 'vue'

type PickHandler = (color: string) => void

const stack = shallowReactive<PickHandler[]>([])

export const canvasPickActive = computed(() => stack.length > 0)

export function registerCanvasPick(handler: PickHandler): () => void {
  stack.push(handler)
  return () => {
    const i = stack.lastIndexOf(handler)
    if (i >= 0) stack.splice(i, 1)
  }
}

// Deliver a picked color to the active picker. Returns false if none.
export function deliverCanvasPick(color: string): boolean {
  const handler = stack[stack.length - 1]
  if (!handler) return false
  handler(color)
  return true
}

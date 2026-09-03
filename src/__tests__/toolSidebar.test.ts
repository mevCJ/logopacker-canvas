import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import ToolSidebar from '@/components/canvas/ToolSidebar.vue'
import { useCanvasStore } from '@/stores/canvas'

describe('ToolSidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('arms tools when the top-level buttons are clicked', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    const buttons = wrapper.findAll('.tool-btn')
    // Order: select, text, shapes, image.
    await buttons[1]!.trigger('click')
    expect(store.activeTool).toBe('text')
    await buttons[0]!.trigger('click')
    expect(store.activeTool).toBe('select')
  })

  it('opens the shape flyout and arms each shape tool', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    const shapesBtn = wrapper.findAll('.tool-btn')[2]!
    await shapesBtn.trigger('click')
    const flyoutBtns = wrapper.findAll('.flyout-btn')
    expect(flyoutBtns).toHaveLength(3)
    await flyoutBtns[1]!.trigger('click') // Ellipse
    expect(store.activeTool).toBe('ellipse')
    // Flyout closes after selection.
    expect(wrapper.findAll('.flyout-btn')).toHaveLength(0)
  })

  it('emits open-image-picker when the image tool is chosen', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    const imageBtn = wrapper.findAll('.tool-btn')[3]!
    await imageBtn.trigger('click')
    expect(store.activeTool).toBe('image')
    expect(wrapper.emitted('open-image-picker')).toBeTruthy()
  })
})

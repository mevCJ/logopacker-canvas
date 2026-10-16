import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import ToolSidebar from '@/components/canvas/ToolSidebar.vue'
import { useCanvasStore } from '@/stores/canvas'

const slot = (wrapper: ReturnType<typeof mount>, group: string) => wrapper.find(`[data-group="${group}"]`)

describe('ToolSidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('arms each group slot tool on click', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    await slot(wrapper, 'pen').trigger('click')
    expect(store.activeTool).toBe('pen')
    await slot(wrapper, 'type').trigger('click')
    expect(store.activeTool).toBe('text')
    await slot(wrapper, 'build').trigger('click')
    expect(store.activeTool).toBe('shapeBuilder')
    await slot(wrapper, 'gradient').trigger('click')
    expect(store.activeTool).toBe('gradient')
    await slot(wrapper, 'selection').trigger('click')
    expect(store.activeTool).toBe('select')
  })

  it('opens a group flyout from the caret and remembers the picked tool', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    await slot(wrapper, 'shape').find('.tool-caret').trigger('click')
    const flyoutBtns = wrapper.findAll('.flyout-btn')
    expect(flyoutBtns.map((b) => b.attributes('data-tool'))).toEqual(['rect', 'ellipse', 'line'])
    await flyoutBtns[1]!.trigger('click')
    expect(store.activeTool).toBe('ellipse')
    expect(wrapper.findAll('.flyout-btn')).toHaveLength(0)
    // The slot now arms the ellipse directly.
    store.setActiveTool('select')
    await slot(wrapper, 'shape').trigger('click')
    expect(store.activeTool).toBe('ellipse')
  })

  it('slot follows tools armed elsewhere (e.g. hotkeys)', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    store.setActiveTool('textPath')
    await wrapper.vm.$nextTick()
    expect(slot(wrapper, 'type').classes()).toContain('active')
    store.setActiveTool('select')
    await slot(wrapper, 'type').trigger('click')
    expect(store.activeTool).toBe('textPath')
  })

  it('emits open-image-picker when the image tool is chosen', async () => {
    const store = useCanvasStore()
    const wrapper = mount(ToolSidebar)
    await slot(wrapper, 'image').trigger('click')
    expect(store.activeTool).toBe('image')
    expect(wrapper.emitted('open-image-picker')).toBeTruthy()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import Toolbar from '@/components/canvas/Toolbar.vue'
import { useCanvasStore } from '@/stores/canvas'

async function openMenu(wrapper: ReturnType<typeof mount>, id: string) {
  await wrapper.find(`[data-menu="${id}"]`).trigger('click')
}
function menuItem(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper.findAll('.mb-item').find((b) => b.find('.mb-item-label').text() === label)
}

describe('Toolbar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('emits export when the Export button is clicked', async () => {
    const wrapper = mount(Toolbar)
    const exportBtn = wrapper.findAll('.tb-btn').find((b) => b.text() === 'Export')
    expect(exportBtn).toBeDefined()
    await exportBtn!.trigger('click')
    expect(wrapper.emitted('export')).toBeTruthy()
  })

  it('File menu opens and saves', async () => {
    const wrapper = mount(Toolbar)
    await openMenu(wrapper, 'file')
    await menuItem(wrapper, 'Open…')!.trigger('click')
    expect(wrapper.emitted('load')).toBeTruthy()
    await openMenu(wrapper, 'file')
    await menuItem(wrapper, 'Save')!.trigger('click')
    expect(wrapper.emitted('save')).toBeTruthy()
  })

  it('View menu fits the view and toggles outline', async () => {
    const store = useCanvasStore()
    const wrapper = mount(Toolbar)
    await openMenu(wrapper, 'view')
    await menuItem(wrapper, 'Fit All in Window')!.trigger('click')
    expect(wrapper.emitted('fit-view')).toBeTruthy()
    await openMenu(wrapper, 'view')
    await menuItem(wrapper, 'Outline')!.trigger('click')
    expect(store.viewMode).toBe('outline')
  })

  it('disables selection-dependent items with nothing selected', async () => {
    const wrapper = mount(Toolbar)
    await openMenu(wrapper, 'object')
    expect(menuItem(wrapper, 'Bring to Front')!.attributes('disabled')).toBeDefined()
    expect(menuItem(wrapper, 'New Artboard')!.attributes('disabled')).toBeUndefined()
  })

  it('runs Object menu shortcuts (Cmd/Ctrl+] brings forward)', async () => {
    const store = useCanvasStore()
    const wrapper = mount(Toolbar, { attachTo: document.body })
    const a = store.addObject({ type: 'path' })
    const b = store.addObject({ type: 'path' })
    store.selectObjects([a.id])
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'BracketRight', key: ']', metaKey: isMac, ctrlKey: !isMac }))
    expect(store.objectOrder).toEqual([b.id, a.id])
    wrapper.unmount()
  })

  it('control bar shows the selection kind and aligns', async () => {
    const store = useCanvasStore()
    const ab = store.addArtboard({ width: 200, height: 100 })
    const o = store.addObject({ type: 'path', shape: 'rect', x: 10, y: 10, width: 20, height: 20, artboardId: ab.id })
    store.selectObjects([o.id])
    const wrapper = mount(Toolbar)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.cb-kind').text()).toBe('Rectangle')
    await wrapper.find('[data-align="right"]').trigger('click')
    expect(store.getObject(o.id)!.x).toBe(180)
  })
})

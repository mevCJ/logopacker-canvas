import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import Toolbar from '@/components/canvas/Toolbar.vue'

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

  it('emits fit-view when Fit view is clicked', async () => {
    const wrapper = mount(Toolbar)
    const fitBtn = wrapper.findAll('.tb-btn').find((b) => b.text() === 'Fit view')
    await fitBtn!.trigger('click')
    expect(wrapper.emitted('fit-view')).toBeTruthy()
  })
})

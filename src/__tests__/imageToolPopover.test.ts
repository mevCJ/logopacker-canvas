import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import ImageToolPopover from '@/components/canvas/ImageToolPopover.vue'
import { useCanvasStore } from '@/stores/canvas'

const SAMPLE = {
  query: 'building',
  total: 1,
  results: [
    { id: 1, alt: 'A building', thumb: 't.jpg', src: 'large.jpg', width: 1200, height: 800, url: 'https://pexels.com/photo/1' },
  ],
}

describe('ImageToolPopover', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('searches Pexels and stages the picked result as pendingImage', async () => {
    const store = useCanvasStore()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => SAMPLE,
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(ImageToolPopover)
    await wrapper.find('.ip-input').setValue('building')
    await wrapper.find('.ip-search').trigger('submit')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/pexels/search?'))
    const thumbs = wrapper.findAll('.ip-thumb')
    expect(thumbs).toHaveLength(1)

    await thumbs[0]!.trigger('click')
    expect(store.pendingImage).toMatchObject({ href: 'large.jpg', width: 1200, height: 800 })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('shows an error when the search request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }))
    const wrapper = mount(ImageToolPopover)
    await wrapper.find('.ip-input').setValue('x')
    await wrapper.find('.ip-search').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.ip-error').exists()).toBe(true)
  })

  it('clears the staged image', async () => {
    const store = useCanvasStore()
    store.setPendingImage({ href: 'x.jpg' })
    const wrapper = mount(ImageToolPopover)
    expect(wrapper.find('.ip-staged').exists()).toBe(true)
    await wrapper.find('.ip-link').trigger('click')
    expect(store.pendingImage).toBeNull()
  })
})

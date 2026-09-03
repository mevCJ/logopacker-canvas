import { describe, it, expect, beforeEach } from 'vitest'
import { CanvasRenderer } from '@/services/canvas/svgEngine'

// Regression coverage for the tool overlays (marquee + shape preview). These
// exercise the real SVG.js element chain in happy-dom, which previously threw
// on an invalid `.fillOpacity()` call — leaving stacked, un-clearable rects.
describe('CanvasRenderer — tool overlays', () => {
  let host: HTMLElement
  let renderer: CanvasRenderer

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    renderer = new CanvasRenderer(host)
    renderer.setViewBox({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('reuses a single marquee rect, tracks position, and clears it', () => {
    renderer.showMarquee({ x: 100, y: 100, width: 50, height: 40 })
    renderer.showMarquee({ x: 120, y: 130, width: 80, height: 60 })

    const rects = host.querySelectorAll('.tool-layer rect')
    expect(rects.length).toBe(1)
    const rect = rects[0]!
    expect(rect.getAttribute('x')).toBe('120')
    expect(rect.getAttribute('y')).toBe('130')
    expect(rect.getAttribute('width')).toBe('80')
    expect(rect.getAttribute('height')).toBe('60')

    renderer.hideMarquee()
    expect(host.querySelectorAll('.tool-layer rect').length).toBe(0)
  })

  it('draws and clears a rect/ellipse/line shape preview without stacking', () => {
    renderer.showShapePreview('rect', { x: 10, y: 10, width: 40, height: 30 })
    renderer.showShapePreview('ellipse', { x: 10, y: 10, width: 40, height: 30 })
    renderer.showShapePreview('line', { x: 10, y: 10, width: 40, height: 30 })

    // Only the latest preview element should exist.
    const previews = host.querySelectorAll('.tool-layer > *')
    expect(previews.length).toBe(1)
    expect(previews[0]!.tagName.toLowerCase()).toBe('line')

    renderer.hideShapePreview()
    expect(host.querySelectorAll('.tool-layer > *').length).toBe(0)
  })

  it('renders objects with a transform that carries position, rotation and scale', () => {
    renderer.render({
      artboards: [{ id: 'ab', name: 'A', x: 100, y: 100, width: 400, height: 400 }],
      objects: {
        p1: {
          id: 'p1',
          type: 'path',
          artboardId: 'ab',
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          baseWidth: 50,
          baseHeight: 50,
          rotation: 90,
          d: 'M0 0 H50 V50 H0 Z',
          fill: '#000',
        },
        img: {
          id: 'img',
          type: 'image',
          artboardId: 'ab',
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          baseWidth: 200,
          baseHeight: 100,
          rotation: 0,
          href: 'x.png',
        },
      },
      objectOrder: ['p1', 'img'],
    })

    const path = host.querySelector('path.canvas-object')!
    // Absolute position = artboard (100,100) + local (10,20); scale = 100/50, 50/50.
    expect(path.getAttribute('transform')).toBe('translate(110 120) rotate(90 50 25) scale(2 1)')

    const image = host.querySelector('image.canvas-object')!
    // Image renders at base intrinsic size, scale 1, positioned via transform.
    expect(image.getAttribute('transform')).toBe('translate(100 100)')
    expect(image.getAttribute('width')).toBe('200')
    expect(image.getAttribute('height')).toBe('100')
  })

  it('draws 8 resize handles + a rotate handle for a single selection', () => {
    const obj = {
      id: 'p1',
      type: 'path' as const,
      artboardId: 'ab',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      baseWidth: 100,
      baseHeight: 50,
      rotation: 0,
      d: 'M0 0 H100 V50 H0 Z',
      fill: '#000',
    }
    renderer.render({
      artboards: [{ id: 'ab', name: 'A', x: 0, y: 0, width: 400, height: 400 }],
      objects: { p1: obj },
      objectOrder: ['p1'],
    })
    renderer.setSelection(['p1'], [obj])

    const rectHandles = host.querySelectorAll('.handle-layer rect[data-handle]')
    expect(rectHandles.length).toBe(8)
    expect(host.querySelectorAll('.handle-layer circle[data-handle="rotate"]').length).toBe(1)
  })

  it('draws no handles for a multi-selection', () => {
    const a = { id: 'a', type: 'path' as const, artboardId: 'ab', x: 0, y: 0, width: 50, height: 50, baseWidth: 50, baseHeight: 50, rotation: 0, d: 'M0 0 H50 V50 H0 Z', fill: '#000' }
    const b = { id: 'b', type: 'path' as const, artboardId: 'ab', x: 80, y: 0, width: 50, height: 50, baseWidth: 50, baseHeight: 50, rotation: 0, d: 'M0 0 H50 V50 H0 Z', fill: '#000' }
    renderer.render({
      artboards: [{ id: 'ab', name: 'A', x: 0, y: 0, width: 400, height: 400 }],
      objects: { a, b },
      objectOrder: ['a', 'b'],
    })
    renderer.setSelection(['a', 'b'], [a, b])
    expect(host.querySelectorAll('.handle-layer [data-handle]').length).toBe(0)
  })

  it('clears handles when the selection is emptied', () => {
    const obj = { id: 'p1', type: 'path' as const, artboardId: 'ab', x: 0, y: 0, width: 100, height: 50, baseWidth: 100, baseHeight: 50, rotation: 0, d: 'M0 0 H100 V50 H0 Z', fill: '#000' }
    renderer.render({
      artboards: [{ id: 'ab', name: 'A', x: 0, y: 0, width: 400, height: 400 }],
      objects: { p1: obj },
      objectOrder: ['p1'],
    })
    renderer.setSelection(['p1'], [obj])
    expect(host.querySelectorAll('.handle-layer [data-handle]').length).toBe(9)
    renderer.setSelection([], [])
    expect(host.querySelectorAll('.handle-layer [data-handle]').length).toBe(0)
  })
})

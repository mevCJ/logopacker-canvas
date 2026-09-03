// Convert imported SVG markup into native, node-editable path objects.
//
// Imported/pasted SVGs used to be embedded as a single opaque <image> data URL,
// so the node-edit tool had nothing to grab. This module parses each <path> in
// the markup into Bézier anchors (PathNode[]) in the same convention the pen
// tool + renderer use (nodesToPathData), flattening ancestor transforms and the
// root viewBox so geometry lands where the artwork drew it. The caller places
// the result as real PathObjects that the node tool can reshape.
//
// The hard part — parsing every path command (relative/absolute, S/T shorthand,
// arc-to-bézier) and applying transforms — is delegated to the `svgpath`
// library: normalize to absolute cubic/line segments via
// .transform().unshort().unarc().abs(), then map each segment to anchors.
//
// ponytail: only <path> elements convert. Basic shapes (<rect>/<circle>/...),
// <text>, <image>, gradients, clip paths and CSS-class styling are NOT handled;
// callers fall back to the single-image embed when svgToPathObjects returns
// null (no usable paths). Upgrade path: pre-normalize shapes to paths and
// resolve <style>/<use> before parsing.

import svgpath from 'svgpath'
import { parseSvg, readViewBox } from './novaSeed'
import type { PathNode } from './svgEngine'

interface Subpath {
  nodes: PathNode[]
  closed: boolean
}

// Collect the transform attributes from an element up to (not including) the
// root <svg>, ordered outermost-first so applying them in sequence yields
// parent(child(point)).
function ancestorTransforms(el: Element, root: Element): string[] {
  const chain: string[] = []
  let cur: Element | null = el
  while (cur && cur !== root) {
    const t = cur.getAttribute('transform')
    if (t) chain.push(t)
    cur = cur.parentElement
  }
  return chain.reverse()
}

// Parse an SVG path `d` into subpaths of cubic anchors. Handles are stored so a
// segment re-serializes to C when curved and L when straight (matching
// nodesToPathData): the outgoing handle lives on the start anchor's out*, the
// incoming handle on the end anchor's in*. `transforms` are raw transform
// attribute strings applied outermost-first.
export function parsePathData(d: string, transforms: string[] = []): Subpath[] {
  let sp = svgpath(d)
  for (const t of transforms) sp = sp.transform(t)
  // Normalize: expand shorthands, convert arcs to cubics, make absolute.
  sp = sp.unshort().unarc().abs()

  const subpaths: Subpath[] = []
  let nodes: PathNode[] = []
  let closed = false

  const flush = () => {
    if (nodes.length) subpaths.push({ nodes, closed })
    nodes = []
    closed = false
  }

  sp.iterate((seg, _idx, x, y) => {
    const cmd = seg[0]
    switch (cmd) {
      case 'M': {
        flush()
        nodes.push({ x: seg[1], y: seg[2] })
        break
      }
      case 'L': {
        nodes.push({ x: seg[1], y: seg[2] })
        break
      }
      case 'H': {
        nodes.push({ x: seg[1], y })
        break
      }
      case 'V': {
        nodes.push({ x, y: seg[1] })
        break
      }
      case 'C': {
        // Outgoing handle on the current last anchor; new anchor with incoming.
        const start = nodes[nodes.length - 1]
        if (start) {
          start.outX = seg[1]
          start.outY = seg[2]
        }
        nodes.push({ x: seg[5], y: seg[6], inX: seg[3], inY: seg[4] })
        break
      }
      case 'Q': {
        // svgpath doesn't lower quadratics; elevate Q to a cubic here.
        // (unshort() already turned any T into Q.) Control point (qx,qy),
        // endpoint (ex,ey); current point is (x,y).
        const qx = seg[1]
        const qy = seg[2]
        const ex = seg[3]
        const ey = seg[4]
        const start = nodes[nodes.length - 1]
        if (start) {
          start.outX = x + (2 / 3) * (qx - x)
          start.outY = y + (2 / 3) * (qy - y)
        }
        nodes.push({
          x: ex,
          y: ey,
          inX: ex + (2 / 3) * (qx - ex),
          inY: ey + (2 / 3) * (qy - ey),
        })
        break
      }
      case 'Z':
      case 'z': {
        closed = true
        break
      }
      // After abs().unshort().unarc() the remaining commands are M/L/H/V/C/Q/Z
      // (svgpath expands S/T/A but leaves plain Q). Anything else is ignored.
    }
  })
  flush()
  return subpaths
}

// Fold parsed subpaths into a single flat node list plus the node count of each
// subpath, so a compound path (e.g. a glyph with a hole) round-trips through
// the single-`nodes` model. `closed` is shared across subpaths (logo fills are
// all-closed); it's true if any subpath was closed.
export function flattenSubpaths(subs: Subpath[]): {
  nodes: PathNode[]
  subpaths: number[]
  closed: boolean
} {
  const nodes: PathNode[] = []
  const subpaths: number[] = []
  let closed = false
  for (const sp of subs) {
    if (sp.nodes.length < 2) continue
    nodes.push(...sp.nodes)
    subpaths.push(sp.nodes.length)
    if (sp.closed) closed = true
  }
  return { nodes, subpaths, closed }
}

export interface ImportedPath {
  nodes: PathNode[]
  // Node count of each subpath (compound paths have >1 entry).
  subpaths: number[]
  closed: boolean
  fill: string
  stroke: string
  strokeWidth: number
}

export interface SvgPathsResult {
  viewBox: { x: number; y: number; width: number; height: number }
  paths: ImportedPath[]
}

// Parse SVG markup into node-editable paths in the SVG's own coordinate space
// (viewBox coords). Returns null when the markup has no usable <path> elements
// (caller should fall back to embedding it as an image). Presentation is read
// from each path's own fill/stroke attributes; inherited/CSS styling is not
// resolved (ponytail ceiling noted at file top).
export function svgToPathObjects(markup: string): SvgPathsResult | null {
  let root: Element
  try {
    root = parseSvg(markup)
  } catch {
    return null
  }
  const viewBox = readViewBox(root)
  let pathEls: Element[]
  try {
    pathEls = Array.from(root.querySelectorAll('path'))
  } catch {
    pathEls = []
  }
  if (pathEls.length === 0 && root.ownerDocument) {
    try {
      pathEls = Array.from(root.ownerDocument.querySelectorAll('path'))
    } catch {
      pathEls = []
    }
  }
  if (pathEls.length === 0) return null

  const paths: ImportedPath[] = []
  for (const el of pathEls) {
    const d = el.getAttribute('d')
    if (!d) continue
    let subpaths: Subpath[]
    try {
      subpaths = parsePathData(d, ancestorTransforms(el, root))
    } catch {
      continue
    }
    // One ImportedPath per <path>, preserving its subpaths (a compound path
    // keeps its holes/pieces as one object instead of splitting them apart).
    const { nodes, subpaths: counts, closed } = flattenSubpaths(subpaths)
    if (nodes.length < 2) continue
    const fillAttr = el.getAttribute('fill')
    const strokeAttr = el.getAttribute('stroke')
    const swAttr = el.getAttribute('stroke-width')
    paths.push({
      nodes,
      subpaths: counts,
      closed,
      fill: fillAttr == null || fillAttr === '' ? '#000000' : fillAttr,
      stroke: strokeAttr == null || strokeAttr === '' ? 'none' : strokeAttr,
      strokeWidth: swAttr ? Number(swAttr) || 0 : 0,
    })
  }
  if (paths.length === 0) return null
  return { viewBox, paths }
}

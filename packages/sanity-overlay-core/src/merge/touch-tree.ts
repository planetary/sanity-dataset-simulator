/**
 * The touched-path tree the merge walks (PRD §13.5, §17.6, §17.7).
 *
 * A flat `OverlayPath[]` cannot be merged directly, because §17.6 requires the
 * merge to descend *into* base objects — "preserve new upstream sibling fields
 * when only one child path is touched" — and §17.7 requires it to descend into
 * keyed arrays by `_key`. Turning the list into a trie makes both descents a
 * single recursive walk, and makes the "whole subtree is locally owned" rule a
 * property of one node rather than a repeated prefix scan.
 */
import {isKeySegment, type OverlayPath, type OverlayPathSegment} from '../types/path'

export interface TouchTreeChild {
  segment: OverlayPathSegment
  node: TouchTreeNode
}

export interface TouchTreeNode {
  /** This exact path was recorded as touched: the whole subtree is local (§17.6). */
  self: boolean
  /** This exact path carries an explicit unset (§17.5). */
  unset: boolean
  children: Map<string, TouchTreeChild>
}

/** What kind of container a node's children address. */
export type TouchChildKind = 'object' | 'keyed' | 'index'

function emptyNode(): TouchTreeNode {
  return {self: false, unset: false, children: new Map()}
}

/** Stable map key for one path segment. */
export function segmentKey(segment: OverlayPathSegment): string {
  if (isKeySegment(segment)) return `k:${segment._key}`
  if (typeof segment === 'number') return `i:${segment}`
  return `s:${segment}`
}

function insert(root: TouchTreeNode, path: OverlayPath, mark: 'self' | 'unset'): void {
  if (path.length === 0) return
  let node = root
  for (const segment of path) {
    const key = segmentKey(segment)
    let child = node.children.get(key)
    if (child === undefined) {
      child = {segment, node: emptyNode()}
      node.children.set(key, child)
    }
    node = child.node
  }
  node.self = true
  if (mark === 'unset') node.unset = true
}

/**
 * Build the trie. Unset paths are inserted as touched *and* unset, so an unset
 * recorded without a matching touched path still suppresses inheritance
 * (invariant §34.11).
 */
export function buildTouchTree(
  touchedPaths: readonly OverlayPath[],
  unsetPaths: readonly OverlayPath[] = [],
): TouchTreeNode {
  const root = emptyNode()
  for (const path of touchedPaths) insert(root, path, 'self')
  for (const path of unsetPaths) insert(root, path, 'unset')
  return root
}

/**
 * Which container the node's children address, decided by the first child
 * segment. A numeric segment means the array has no `_key` support, which §17.7
 * turns into a full-array touch.
 */
export function childKind(node: TouchTreeNode): TouchChildKind {
  for (const child of node.children.values()) {
    if (isKeySegment(child.segment)) return 'keyed'
    if (typeof child.segment === 'number') return 'index'
    return 'object'
  }
  /* istanbul ignore next -- callers check `children.size` first */
  return 'object'
}

/**
 * Where somebody else's caret goes on the grid — M5.3.
 *
 * Pure, so that the interesting part is testable without a DOM: what a peer's
 * position means on *this* tab's grid, which is not always the same grid the peer
 * has. Two people in one session can be a document apart for as long as it takes an
 * update to arrive — one has already added a qubit, the other has not — and a mark
 * for a cell that does not exist here is a caret drawn in the padding, or at a
 * negative offset, or under the classical register.
 *
 * So a position off the drawn grid produces no mark at all. It is not an error and
 * nothing is reported: the peer is looking at a cell this tab cannot show yet, and
 * the update that makes it showable is already on its way.
 */

import { controlsOf, type Circuit } from '@qsim/schema'
import type { CollabAccess } from '@qsim/contract'

import { rowCount, type Cell, type GridSize } from '../circuit-editor/geometry'
import { collaboratorHue } from '../../lib/collab-colour'
import type { PeerPresence } from './presence'

export interface PresenceMark {
  /** Stable across renders, so React does not rebuild a caret on every frame. */
  readonly key: string
  readonly peerId: string
  readonly name: string | null
  readonly access: CollabAccess
  /** The peer's hue, in degrees — see `lib/collab-colour.ts`. */
  readonly hue: number
  /**
   * `cursor` is where they are focused; `selection` is a gate they are holding.
   *
   * Two kinds rather than one flag, because they are drawn differently and for a
   * reason that is not decoration: a solid outline with a caret says "somebody is
   * *here*" and a dashed one says "somebody has *that*", and a reader who cannot
   * separate two hues can still separate two line styles.
   */
  readonly kind: 'cursor' | 'selection'
  readonly cell: Cell
  /** Only a cursor carries the name label; a selection would print it twice. */
  readonly labelled: boolean
}

/**
 * Every mark to draw, in the order the peers arrived.
 *
 * Selections come before the cursor of the same peer so that the caret — the thing
 * that says where they are — is painted last and therefore on top.
 */
export function presenceMarks(
  peers: readonly PeerPresence[],
  circuit: Circuit,
  size: GridSize
): PresenceMark[] {
  const marks: PresenceMark[] = []
  const rows = rowCount(size)

  for (const peer of peers) {
    const hue = collaboratorHue(peer.peerId)
    const shared = {
      peerId: peer.peerId,
      name: peer.name,
      access: peer.access,
      hue,
    }

    for (const id of peer.selection) {
      const operation = circuit.operations.find((entry) => entry.id === id)
      // A selection naming an operation this tab has not got: the peer selected a
      // gate whose creation has not arrived here yet, or that has just been
      // deleted. Nothing is drawn and nothing is wrong.
      if (operation === undefined) continue
      /*
       * Every wire the operation stands on, not merely its first target. A CNOT
       * that somebody is holding is two cells wide on screen, and outlining only
       * the target would say they had hold of half of it.
       */
      const wires = [
        ...operation.targets,
        ...controlsOf(operation).map((control) => control.qubit),
      ]
      for (const qubit of wires) {
        const cell = { qubit, column: operation.column }
        if (!inside(cell, size, rows)) continue
        marks.push({
          ...shared,
          key: `${peer.peerId}:${id}:${qubit}`,
          kind: 'selection',
          cell,
          labelled: false,
        })
      }
    }

    if (peer.cursor !== null && inside(peer.cursor, size, rows)) {
      marks.push({
        ...shared,
        key: `${peer.peerId}:cursor`,
        kind: 'cursor',
        cell: peer.cursor,
        labelled: true,
      })
    }
  }

  return marks
}

/**
 * Whether this tab's grid has such a cell.
 *
 * `rowCount` rather than `size.qubits`, because the classical register is a row of
 * the grid a cursor may stand on (`geometry.ts`) — and it is the one row where a
 * peer's caret is *more* informative than usual, since nothing can be placed there
 * and somebody standing on it is reading a measurement.
 */
function inside(cell: Cell, size: GridSize, rows: number): boolean {
  return (
    cell.qubit >= 0 &&
    cell.qubit < rows &&
    cell.column >= 0 &&
    cell.column < size.columns
  )
}

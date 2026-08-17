/**
 * What the frame is showing, from either of the two places it can come from.
 *
 * The API answers with a saved circuit and its server-computed counters; a
 * `?c=` link carries a document nobody saved, which has no title, no author
 * and no row to have counted anything. One shape covers both, with the three
 * absent facts spelled `null` rather than defaulted here — the view is where
 * a missing title becomes a translated sentence, because that is the only
 * layer that knows what language to say it in (D2).
 *
 * ── The counters are the server's when there is a server ─────────────────
 *
 * `gateCount` and `depth` are denormalised columns computed by `@qsim/db` on
 * every write, over the *expanded* circuit (§3.1, decision 3), and the embed
 * prints those rather than recomputing them. That is the same rule the gallery
 * card and the challenge leaderboard follow, and it exists so that one figure
 * cannot be labelled two ways on two screens.
 *
 * For a `?c=` document there is no server and no row, so the same helpers the
 * server would have used are called here. They are @qsim/schema's, which is
 * the shared implementation both ends hold (§12.1) — so this is the same
 * arithmetic, not a second one.
 */

import { depth, gateCount, type Circuit } from '@qsim/schema'
import type { EmbedCircuitView } from '@qsim/contract'

export interface EmbedDocument {
  readonly circuit: Circuit
  /** `null` for a circuit that was never saved and therefore never named. */
  readonly title: string | null
  /** The author's username, or `null` when there is no row to have one. */
  readonly author: string | null
  /** The handle its canonical page lives at, or `null` when it has none. */
  readonly slug: string | null
  readonly qubitCount: number
  readonly gateCount: number
  readonly depth: number
}

/** A saved circuit, as `GET /embed/:handle` describes it. */
export function documentFromApi(view: EmbedCircuitView): EmbedDocument {
  return {
    circuit: view.circuit,
    title: view.title,
    author: view.author.username,
    slug: view.slug,
    qubitCount: view.qubitCount,
    gateCount: view.gateCount,
    depth: view.depth,
  }
}

/** A circuit carried inside its own link — decision D4. */
export function documentFromLink(circuit: Circuit): EmbedDocument {
  return {
    circuit,
    title: null,
    author: null,
    slug: null,
    qubitCount: circuit.qubits,
    gateCount: gateCount(circuit),
    depth: depth(circuit),
  }
}

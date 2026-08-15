/**
 * The visual diff between two versions — §3.4, milestone M1.4b.
 *
 * `circuitDiff.ts` decides *what* changed; this file decides how a reader sees
 * it. The split is the usual one — the judgement is pure and tested against
 * hand-written expectations, the drawing is not — and it matters more here
 * than usual, because a diff that looks plausible and is wrong is worse than
 * no diff at all.
 *
 * ── Colour is never the distinction ───────────────────────────────────────
 *
 * §10 states the rule for phase and it applies with full force to a diff:
 * telling "added" from "removed" is exactly the case where two states must be
 * separated at a glance, and roughly one man in twelve cannot separate them by
 * hue. So each kind carries three independent signals and colour is the last
 * of them:
 *
 *   - a **silhouette** — triangle, square, diamond, circle — which survives a
 *     monochrome screen, a printout and a screenshot scaled to a third;
 *   - a **glyph** inside it, and a **dash pattern** on the outline around the
 *     cell: solid, dashed, dotted, dash-dot;
 *   - and only then a hue.
 *
 * The same four marks appear in the legend and on the diagram, from one
 * function, so the key and the picture cannot drift apart.
 *
 * ── Two layers, again ─────────────────────────────────────────────────────
 *
 * The drawing is `aria-hidden`, exactly as `CircuitCanvas`'s plot is, and for
 * the same reason: what a reader who cannot see it needs is not "there is a
 * dashed square here" but "H removed from q0, moment 2". That sentence lives
 * in the change list below the diagram, in three languages, with the gate
 * symbol through `Notation` and the wire names joined by `Intl.ListFormat`.
 * The list is not a fallback — it is the primary account, and the picture is
 * the summary of it.
 *
 * ── The grid is the union of the two versions ─────────────────────────────
 *
 * A version that removed the last two wires still has to show what stood on
 * them, and a version that added a column has to have somewhere to draw it. So
 * the register and the column count are the larger of the two, and an
 * operation that exists in only one version is drawn on a grid big enough to
 * hold both.
 */

import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Circuit, Operation } from '@qsim/schema'

import { Notation, NotationText } from '../../components/Notation'
import { GateNode } from '../circuit-editor/GateNode'
import {
  DEFAULT_METRICS,
  MAX_DRAWN_COLUMNS,
  MIN_COLUMNS,
  cellBounds,
  cellCenter,
  classicalY,
  columnCount,
  plotHeight,
  plotWidth,
  qubitY,
  type Cell,
  type GridMetrics,
  type GridSize,
} from '../circuit-editor/geometry'
import {
  formatWireList,
  gateSymbol,
  qubitLabel,
} from '../circuit-editor/operationRoles'
import {
  changedEntries,
  diffCircuits,
  operationCells,
  type DiffAspect,
  type DiffEntry,
  type DiffKind,
} from './circuitDiff.js'

/** The kinds that get a mark. `unchanged` is the absence of one. */
type MarkedKind = Exclude<DiffKind, 'unchanged'>

const MARKED_KINDS: readonly MarkedKind[] = [
  'added',
  'removed',
  'moved',
  'changed',
]

/**
 * Room at the left of the plot for the wire names.
 *
 * The canvas solves this with a sticky gutter of real DOM, because its rows
 * carry buttons. Nothing here is interactive, so the names are drawn into the
 * SVG and the padding is simply widened to make room — which also means the
 * whole diff is one element that scrolls as a unit.
 */
const LABEL_WIDTH = 34

const DIFF_METRICS: GridMetrics = { ...DEFAULT_METRICS, padX: LABEL_WIDTH + 14 }

/**
 * Each mark, centred on the origin so one path serves the legend and the
 * diagram. Radius 9, which is large enough for the silhouette to read at a
 * glance and small enough to sit in a cell corner without covering the gate.
 */
const MARK_SHAPES: Readonly<Record<MarkedKind, string>> = {
  added: 'M 0 -9 L 8 6 L -8 6 Z',
  removed: 'M -7.5 -7.5 H 7.5 V 7.5 H -7.5 Z',
  moved: 'M 0 -9 L 9 0 L 0 9 L -9 0 Z',
  changed: 'M -8 0 A 8 8 0 1 0 8 0 A 8 8 0 1 0 -8 0 Z',
}

/** The glyph inside the silhouette: plus, minus, arrow, wave. */
const MARK_GLYPHS: Readonly<Record<MarkedKind, string>> = {
  // Nudged down, because a triangle's visual centre is below its centroid.
  added: 'M 0 -1 V 5 M -3 2 H 3',
  removed: 'M -4 0 H 4',
  moved: 'M -4.5 0 H 4 M 1 -3 L 4 0 L 1 3',
  changed: 'M -4 1.5 Q -2 -2.5 0 0 T 4 -1.5',
}

export interface CircuitDiffViewProps {
  /** The older version. */
  readonly before: Circuit
  /** The newer version. */
  readonly after: Circuit
  /** The older version's number, for the heading and the summary. */
  readonly from: number
  readonly to: number
  readonly metrics?: GridMetrics
}

export function CircuitDiffView({
  before,
  after,
  from,
  to,
  metrics = DIFF_METRICS,
}: CircuitDiffViewProps) {
  const { t, i18n } = useTranslation('circuits')
  const headingId = useId()

  const diff = useMemo(() => diffCircuits(before, after), [before, after])
  const changes = useMemo(() => changedEntries(diff), [diff])

  const size = unionSize(before, after)
  const width = plotWidth(size, metrics)
  const height = plotHeight(size, metrics)
  const numbers = new Intl.NumberFormat(i18n.language)

  const hidden = Math.max(
    0,
    Math.max(columnCount(before), columnCount(after)) - MAX_DRAWN_COLUMNS
  )

  return (
    <section className="circuit-diff" aria-labelledby={headingId}>
      <h3 className="circuit-diff__heading" id={headingId}>
        {t('diff.heading', {
          from: numbers.format(from),
          to: numbers.format(to),
        })}
      </h3>

      {diff.identical ? (
        <p className="circuit-diff__summary">{t('diff.identical')}</p>
      ) : changes.length === 0 ? (
        <p className="circuit-diff__summary">{t('diff.registersOnly')}</p>
      ) : null}

      {diff.qubits === null ? null : (
        <p className="circuit-diff__register">
          {t('diff.register.qubits', {
            before: numbers.format(diff.qubits.before),
            after: numbers.format(diff.qubits.after),
          })}
        </p>
      )}
      {diff.clbits === null ? null : (
        <p className="circuit-diff__register">
          {t('diff.register.clbits', {
            before: numbers.format(diff.clbits.before),
            after: numbers.format(diff.clbits.after),
          })}
        </p>
      )}
      {diff.labelsChanged ? (
        <p className="circuit-diff__register">{t('diff.register.labels')}</p>
      ) : null}
      {/*
       * Neither of these draws on the diagram, and both change what the
       * circuit computes. Saying nothing about them is how two versions that
       * simulate differently came back as "the same circuit".
       */}
      {diff.parametersChanged ? (
        <p className="circuit-diff__register">
          {t('diff.document.parameters')}
        </p>
      ) : null}
      {diff.customGatesChanged ? (
        <p className="circuit-diff__register">
          {t('diff.document.customGates')}
        </p>
      ) : null}

      {hidden > 0 ? (
        <p className="circuit-diff__register">
          {t('diff.tooManyColumns', {
            drawn: numbers.format(MAX_DRAWN_COLUMNS),
            hidden: numbers.format(hidden),
          })}
        </p>
      ) : null}

      {/*
       * The legend and the tally are one thing, deliberately. A key that says
       * "a triangle means added" and a summary that says "two were added" are
       * the same two facts, and separating them costs a reader a lookup for
       * nothing. Label above figure, as on a circuit card, because "2 added"
       * as a sentence needs a plural rule in each of the three languages and
       * this needs none (D2).
       */}
      {changes.length === 0 ? null : (
        <dl className="circuit-diff__tally">
          {MARKED_KINDS.filter((kind) => diff.counts[kind] > 0).map((kind) => (
            <div className={`circuit-diff__mark--${kind}`} key={kind}>
              <dt>
                <MarkBadge kind={kind} /> {t(`diff.kind.${kind}`)}
              </dt>
              <dd className="tabular-numbers">
                {numbers.format(diff.counts[kind])}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="circuit-diff__viewport">
        <svg
          className="circuit-diff__plot"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          focusable="false"
        >
          <g className="qsim-wires">
            {range(size.qubits).map((qubit) => (
              <DiffWire
                key={qubit}
                y={qubitY(qubit, metrics)}
                width={width}
                label={wireName(qubit, before, after)}
              />
            ))}
            {size.clbits > 0 ? (
              <DiffWire
                classical
                y={classicalY(size, metrics)}
                width={width}
                label="c"
              />
            ) : null}
          </g>

          {/*
           * Under the live drawing, never over it: a ghost is what is no
           * longer there, and letting it obscure what *is* there would make
           * the newer version the harder of the two to read.
           */}
          <g className="circuit-diff__ghosts">
            {changes.map((entry) =>
              entry.before === null || entry.kind === 'changed' ? null : (
                <GateNode
                  key={`ghost-${entry.before.id}-${entry.before.column}`}
                  circuit={before}
                  operation={entry.before}
                  size={size}
                  metrics={metrics}
                />
              )
            )}
          </g>

          <g className="circuit-diff__operations">
            {after.operations.map((operation) => (
              <GateNode
                key={operation.id}
                circuit={after}
                operation={operation}
                size={size}
                metrics={metrics}
              />
            ))}
          </g>

          <g className="circuit-diff__marks">
            {changes.map((entry, index) => (
              <EntryMarks
                key={`${entry.kind}-${entry.after?.id ?? entry.before?.id ?? index}-${index}`}
                entry={entry}
                metrics={metrics}
              />
            ))}
          </g>
        </svg>
      </div>

      {changes.length === 0 ? null : (
        <ul className="circuit-diff__changes">
          {changes.map((entry, index) => (
            <ChangeLine
              key={`${entry.kind}-${entry.after?.id ?? entry.before?.id ?? index}-${index}`}
              entry={entry}
              before={before}
              after={after}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/* ── The drawing ────────────────────────────────────────────────────────── */

/**
 * A wire and its name. Drawn here rather than reused from `QubitWire` because
 * the diagram carries its labels inside the SVG: the wire has to start after
 * the name rather than at the left edge, which is a property of this layout
 * and not of the editor's.
 */
function DiffWire({
  y,
  width,
  label,
  classical = false,
}: {
  y: number
  width: number
  label: string
  classical?: boolean
}) {
  const className = classical ? 'qsim-wire qsim-wire--classical' : 'qsim-wire'
  return (
    <g>
      <NotationText
        className="circuit-diff__wire-label"
        value={label}
        x={LABEL_WIDTH / 2}
        y={y}
      />
      {classical ? (
        <>
          <line
            className={className}
            x1={LABEL_WIDTH}
            x2={width}
            y1={y - 2.5}
            y2={y - 2.5}
          />
          <line
            className={className}
            x1={LABEL_WIDTH}
            x2={width}
            y1={y + 2.5}
            y2={y + 2.5}
          />
        </>
      ) : (
        <line className={className} x1={LABEL_WIDTH} x2={width} y1={y} y2={y} />
      )}
    </g>
  )
}

/**
 * Everything drawn for one change: the outlined cells, the badge, and — for a
 * move — the arrow that says where it came from.
 */
function EntryMarks({
  entry,
  metrics,
}: {
  entry: DiffEntry
  metrics: GridMetrics
}) {
  if (entry.kind === 'unchanged') return null
  const kind: MarkedKind = entry.kind

  const origin = entry.before
  const destination = entry.after ?? entry.before
  if (destination === null) return null

  const outlined =
    kind === 'moved' && origin !== null ? [origin, destination] : [destination]

  const badge = cellBounds(anchorCell(destination), metrics)

  return (
    <g className={`circuit-diff__mark circuit-diff__mark--${kind}`}>
      {distinctCells(outlined).map((cell) => {
        const bounds = cellBounds(cell, metrics)
        return (
          <rect
            className="circuit-diff__cell"
            key={`${cell.qubit}-${cell.column}`}
            x={bounds.x + 2}
            y={bounds.y + 2}
            width={bounds.width - 4}
            height={bounds.height - 4}
            rx={5}
          />
        )
      })}

      {kind === 'moved' && origin !== null ? (
        <MoveArrow
          origin={origin}
          destination={destination}
          metrics={metrics}
        />
      ) : null}

      <g
        transform={`translate(${badge.x + badge.width - 9} ${badge.y + 9})`}
        className="circuit-diff__badge"
      >
        <path className="circuit-diff__badge-shape" d={MARK_SHAPES[kind]} />
        <path className="circuit-diff__badge-glyph" d={MARK_GLYPHS[kind]} />
      </g>
    </g>
  )
}

/**
 * The line from where an operation stood to where it stands, with a head on
 * the destination end. It is geometry rather than colour, so it says "this one
 * moved, and this far" with no hue involved at all.
 */
function MoveArrow({
  origin,
  destination,
  metrics,
}: {
  origin: Operation
  destination: Operation
  metrics: GridMetrics
}) {
  const from = cellCenter(anchorCell(origin), metrics)
  const to = cellCenter(anchorCell(destination), metrics)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length < 1) return null

  // Stop short of the destination so the head sits beside the gate rather
  // than on top of it.
  const inset = Math.min(16, length / 2)
  const tipX = to.x - (dx / length) * inset
  const tipY = to.y - (dy / length) * inset
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI

  return (
    <g className="circuit-diff__arrow">
      <line x1={from.x} y1={from.y} x2={tipX} y2={tipY} />
      <path
        className="circuit-diff__arrow-head"
        d="M 0 0 L -8 -4 L -8 4 Z"
        transform={`translate(${tipX} ${tipY}) rotate(${angle})`}
      />
    </g>
  )
}

/** One mark, at legend size. Inline so it sits on the text baseline. */
function MarkBadge({ kind }: { kind: MarkedKind }) {
  return (
    <svg
      className={`circuit-diff__badge circuit-diff__mark--${kind}`}
      viewBox="-11 -11 22 22"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <path className="circuit-diff__badge-shape" d={MARK_SHAPES[kind]} />
      <path className="circuit-diff__badge-glyph" d={MARK_GLYPHS[kind]} />
    </svg>
  )
}

/* ── The sentences ──────────────────────────────────────────────────────── */

/**
 * One change, in words.
 *
 * The gate symbol goes through `Notation` instead of into the middle of a
 * translated sentence (D2): `H`, `CNOT` and `Rz(θ)` are the same in all three
 * languages, and a symbol interpolated into a catalog string is a symbol no
 * lint rule can protect. The wire names are joined with `Intl.ListFormat`,
 * because "q0 and q1" is "q0 y q1" and "q0 et q1", and a hard-coded comma is
 * wrong in every language including English.
 */
function ChangeLine({
  entry,
  before,
  after,
}: {
  entry: DiffEntry
  before: Circuit
  after: Circuit
}) {
  const { t, i18n } = useTranslation('circuits')
  if (entry.kind === 'unchanged') return null
  const kind: MarkedKind = entry.kind

  const locale = i18n.language
  const numbers = new Intl.NumberFormat(locale)
  const shown = entry.after ?? entry.before
  if (shown === null) return null
  const context = entry.after === null ? before : after

  const place = (operation: Operation, circuit: Circuit) => ({
    qubits: formatWireList(
      operationCells(operation).map((cell) => qubitLabel(circuit, cell.qubit)),
      locale
    ),
    column: numbers.format(operation.column),
  })

  const sentence =
    kind === 'moved' && entry.before !== null && entry.after !== null
      ? t('diff.change.moved', {
          fromQubits: place(entry.before, before).qubits,
          fromColumn: place(entry.before, before).column,
          toQubits: place(entry.after, after).qubits,
          toColumn: place(entry.after, after).column,
        })
      : t(`diff.change.${kind}`, place(shown, context))

  const detail = describeAspects(entry.aspects, kind, t, locale)

  return (
    <li className={`circuit-diff__change circuit-diff__change--${kind}`}>
      <MarkBadge kind={kind} />{' '}
      <Notation
        className="circuit-diff__gate"
        value={gateSymbol(shown.gate, context)}
      />{' '}
      <span>{sentence}</span>{' '}
      {detail === null ? null : (
        <span className="circuit-diff__change-detail">{detail}</span>
      )}
    </li>
  )
}

type Translate = TFunction<'circuits'>

/**
 * "different angles", "a different gate and different controls" — the detail
 * behind the headline.
 *
 * A move already says the position changed, so the two positional aspects are
 * dropped from its detail rather than repeated in different words. A change in
 * place keeps all of them, because for it they *are* the news. `order` is kept
 * on both: a move says nothing about which wire the gate reads first, so a
 * reordering that arrived with one is still news.
 */
function describeAspects(
  aspects: readonly DiffAspect[],
  kind: MarkedKind,
  t: Translate,
  locale: string
): string | null {
  const relevant =
    kind === 'moved'
      ? aspects.filter((aspect) => aspect !== 'column' && aspect !== 'qubits')
      : aspects
  if (relevant.length === 0) return null

  const list = new Intl.ListFormat(locale, {
    style: 'long',
    type: 'conjunction',
  }).format(relevant.map((aspect) => t(`diff.aspect.${aspect}`)))

  return t('diff.change.detail', { aspects: list })
}

/* ── Geometry helpers ───────────────────────────────────────────────────── */

/**
 * A grid big enough for both versions. Capped at `MAX_DRAWN_COLUMNS` for the
 * reason `geometry.ts` gives — a document may name column 4095, and one
 * element per cell is not a drawing anyone waits for.
 */
function unionSize(before: Circuit, after: Circuit): GridSize {
  return {
    qubits: Math.max(before.qubits, after.qubits),
    clbits: Math.max(before.clbits, after.clbits),
    columns: Math.min(
      MAX_DRAWN_COLUMNS,
      Math.max(MIN_COLUMNS, columnCount(before), columnCount(after))
    ),
  }
}

/**
 * The cell a mark hangs off: the topmost wire the operation occupies.
 *
 * `operationCells` cannot return an empty list — the contract requires at
 * least one target — but nothing in the type system says so, and a fallback
 * that draws in the right column is a better answer to an impossible case than
 * a non-null assertion that would crash the whole diff.
 */
function anchorCell(operation: Operation): Cell {
  const [first] = operationCells(operation)
  return first ?? { qubit: 0, column: operation.column }
}

/**
 * The cells a set of operations occupies, once each.
 *
 * A move outlines both where the operation stood and where it stands, and for
 * a multi-wire gate those overlap: a CNOT on q0/q1 that becomes a CNOT on
 * q1/q2 shares the q1 cell. Emitting a rect per operation per cell put two
 * identical elements on that cell — a doubled stroke — and, because both
 * carried the same operation id, a duplicate-key error in the console on an
 * ordinary interaction.
 */
function distinctCells(operations: readonly Operation[]): Cell[] {
  const seen = new Set<string>()
  const cells: Cell[] = []
  for (const operation of operations) {
    for (const cell of operationCells(operation)) {
      const key = `${cell.qubit}-${cell.column}`
      if (seen.has(key)) continue
      seen.add(key)
      cells.push(cell)
    }
  }
  return cells
}

/** The newer version's name for a wire, falling back to the older version's. */
function wireName(qubit: number, before: Circuit, after: Circuit): string {
  return qubit < after.qubits
    ? qubitLabel(after, qubit)
    : qubitLabel(before, qubit)
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

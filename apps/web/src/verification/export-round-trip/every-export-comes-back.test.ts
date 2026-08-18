import { toCircuitJson, toOpenQasm3 } from '@qsim/qasm'
import type { Circuit } from '@qsim/schema'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PRESETS } from '../../features/circuit-editor/presets'
import { circuitToSvg } from '../../features/export/diagram'
import { EXPORT_FORMATS } from '../../features/export/formats'
import { readCircuitSource } from '../../features/import/readCircuit'

/**
 * Every export that claims to be a circuit can be read back as that circuit.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * The JSON export described itself, in three languages, as "the only export
 * that loses nothing, and the one to save if you want to reopen this circuit
 * here" — and for two phases nothing on the way in could read it. The importer
 * only spoke OpenQASM, its file picker did not even offer `.json`, and pasting
 * an exported circuit into it produced a syntax error pointing at line 1.
 *
 * Every suite was green throughout, and each was right about its own half:
 * `formats.test.ts` proved the writer wrote, `ImportPanel.test.tsx` proved the
 * reader read QASM. A round trip is a property of the *pair*, and nothing owned
 * the pair. This file owns it.
 *
 * It is asserted over `EXPORT_FORMATS` rather than a list written here, so a
 * seventh format cannot be added without landing in one of the two groups
 * below on purpose.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE TWO THAT DO NOT COME BACK, AND WHY THAT IS NOT A BUG
 *
 * `png` is pixels. Recovering operations from a raster is not a thing, and the
 * canvas that produces it would have to grow a metadata chunk writer for the
 * circuit to travel inside it — possible, not done, and the format promises
 * only "the diagram as an image".
 *
 * `qiskit` is Python. Reading it back means parsing Python, which is a
 * different project. It promises only "Python for a notebook".
 *
 * Both are listed explicitly below rather than merely skipped: an export that
 * silently stopped round-tripping should turn this file red, and an export
 * that starts round-tripping should have to move a line.
 */

/** Formats whose file is the circuit, and must survive the trip. */
const ROUND_TRIPS = ['json', 'svg', 'qasm3'] as const

/** Formats that are a picture or a program, and are one-way by nature. */
const ONE_WAY = ['png', 'qiskit'] as const

const CONTEXT = {
  title: 'Round trip',
  description: 'A circuit exported and read back.',
}

/**
 * The bytes each format writes, for the three that must return. `buildExport`
 * is not used because it produces a `Blob` and rasterises; what matters here is
 * the text, and the SVG's own builder is the thing under test.
 */
function write(format: (typeof ROUND_TRIPS)[number], circuit: Circuit): string {
  switch (format) {
    case 'svg':
      return circuitToSvg(circuit, renderToStaticMarkup, CONTEXT).svg
    case 'json':
      // The writer the export panel calls, not a hand-rolled `JSON.stringify`.
      // A round-trip test that serialises the circuit its own way proves a path
      // nobody runs: `toCircuitJson` orders the keys and emits `schemaVersion`,
      // and if it ever stopped emitting it this assertion is what would notice.
      return toCircuitJson(circuit)
    case 'qasm3':
      return toOpenQasm3(circuit)
  }
}

describe('the format list is accounted for', () => {
  it('sorts every export into exactly one of the two groups', () => {
    const covered = [...ROUND_TRIPS, ...ONE_WAY].sort()
    expect(covered).toEqual([...EXPORT_FORMATS].sort())
  })
})

describe.each(ROUND_TRIPS)('a circuit exported as %s', (format) => {
  for (const preset of PRESETS) {
    it(`comes back from ${preset.id}`, () => {
      const written = write(format, preset.circuit)
      const read = readCircuitSource(written)

      // The failure path first: a refusal here is the defect this file exists
      // for, and its message names the format rather than a boolean.
      if (!read.ok) {
        throw new Error(
          `${format} did not come back: ${read.failure.code}` +
            (read.failure.line === undefined
              ? ''
              : ` at line ${String(read.failure.line)}`)
        )
      }

      // Qubit and gate counts, and the gates in order. Not a deep equality:
      // OpenQASM has no field for an operation's id, so a QASM round trip
      // legitimately returns fresh ones — which is exactly why this compares
      // what the format promises to preserve rather than the object.
      expect(read.circuit.qubits).toBe(preset.circuit.qubits)
      expect(
        read.circuit.operations.map((operation) => operation.gate)
      ).toEqual(preset.circuit.operations.map((operation) => operation.gate))
      expect(
        read.circuit.operations.map((operation) => [...operation.targets])
      ).toEqual(
        preset.circuit.operations.map((operation) => [...operation.targets])
      )
    })
  }
})

describe('the native formats preserve the document exactly', () => {
  // JSON and SVG both carry `toCircuitJson`, so unlike QASM they owe an
  // operation-for-operation match including the ids the comment anchors depend
  // on never being recycled.
  for (const format of ['json', 'svg'] as const) {
    it(`${format} returns the same operation ids`, () => {
      const preset = PRESETS[0]
      // `noUncheckedIndexedAccess` is on, and rightly: a fixture that lost its
      // first entry should fail here rather than read `undefined.circuit`.
      expect(preset).toBeDefined()
      if (preset === undefined) return
      const read = readCircuitSource(write(format, preset.circuit))
      expect(read.ok).toBe(true)
      if (!read.ok) return
      expect(read.circuit.operations.map((operation) => operation.id)).toEqual(
        preset.circuit.operations.map((operation) => operation.id)
      )
    })
  }
})

describe('an SVG that is not one of ours', () => {
  it('is refused with a sentence rather than read as a circuit', () => {
    const read = readCircuitSource(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'
    )
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.failure.code).toBe('svg-no-circuit')
  })
})

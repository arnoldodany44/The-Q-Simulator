/**
 * Independent verification (lens: ui-truth-a11y) — does the Q-sphere's table
 * carry the same information as the picture, and does the panel survive having
 * no picture at all?
 *
 * jsdom has no WebGL, so the degradation path is not simulated here: it really
 * happens on every run of this file. That is the point. The claim
 * `QSpherePanel.tsx` makes is that the numbers *are* the rendering and the
 * drawing is allowed to fail, so the test is that every fact survives the
 * failure — with the sentence saying so, and without the table losing a row.
 *
 * The expected values are computed from the amplitudes of hand-written
 * statevectors, not read from `buildQSphere`. What the picture encodes is
 * latitude (Hamming weight), radius (|a|) and hue (the phase); the table must
 * carry all three as numbers, plus the probability, or a reader who cannot see
 * the sphere is reading less than one who can.
 */

import type { Statevector } from '@qsim/core'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { QSpherePanel } from '../../features/analysis/QSpherePanel'
import enAnalysis from '../../i18n/locales/en/analysis.json'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: { en: { analysis: enAnalysis } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function stateOf(
  qubits: number,
  amplitudes: readonly (readonly [number, number, number])[]
): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let norm = 0
  for (const [index, real, imaginary] of amplitudes) {
    re[index] = real
    im[index] = imaginary
    norm += real * real + imaginary * imaginary
  }
  const scale = 1 / Math.sqrt(norm)
  for (let i = 0; i < size; i++) {
    re[i] = (re[i] ?? 0) * scale
    im[i] = (im[i] ?? 0) * scale
  }
  return { qubits, size, re, im }
}

function popcount(value: number): number {
  let bits = value
  let count = 0
  while (bits !== 0) {
    bits &= bits - 1
    count += 1
  }
  return count
}

/**
 * The panel, rendered.
 *
 * Nothing is awaited: the table is present on the first paint, which is the
 * claim this file exists to check. The scene arrives later, asynchronously, and
 * fails — the one test that is about *that* waits for it explicitly.
 */
function draw(state: Statevector) {
  return render(
    <I18nextProvider i18n={i18nFor()}>
      <QSpherePanel state={state} />
    </I18nextProvider>
  )
}

interface Row {
  readonly ket: string
  readonly ring: string
  readonly magnitude: number
  readonly probability: number
  readonly degrees: number
  readonly radians: number
}

function rows(): Row[] {
  const table = screen.getByRole('table')
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => {
      const cells = within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent ?? '')
      const phase = cells[3] ?? ''
      const [degrees = '', radians = ''] = phase.split('·')
      return {
        ket: within(row).getByRole('rowheader').textContent ?? '',
        ring: cells[0] ?? '',
        magnitude: Number((cells[1] ?? '').replace(/,/gu, '')),
        probability: Number((cells[2] ?? '').replace(/[^\d.]/gu, '')) / 100,
        degrees: Number(degrees.replace(/[^\d.]/gu, '')),
        radians: Number(radians.replace(/[^\d.]/gu, '')),
      }
    })
}

afterEach(cleanup)

describe('the Q-sphere’s table is the rendering', () => {
  /*
   * Phases chosen away from a full turn: `format.ts` folds a value that rounds
   * to 2π back to zero, which is right and would make an exact comparison at
   * that one point a test of the fold rather than of the reading.
   */
  const state = stateOf(4, [
    [0b0000, 2, 0], //   phase 0,      weight 0
    [0b0001, 0, 1], //   phase π/2,    weight 1
    [0b0110, -1, 0], //  phase π,      weight 2
    [0b1111, 1, 1], //   phase π/4,    weight 4
  ])

  it('says so when the browser cannot draw the sphere', async () => {
    // jsdom has no WebGL, so this is the real degradation path: three.js loads,
    // fails to obtain a context, and the panel falls back to the rendering that
    // was carrying the meaning all along.
    draw(state)
    expect(await screen.findByText(enAnalysis.qsphere.unavailable)).toBeTruthy()
    // Every row survived the failure.
    expect(rows()).toHaveLength(4)
  })

  it('keeps every drawn state as a row when the picture is gone', () => {
    draw(state)
    expect(rows().map((row) => row.ket)).toEqual([
      '|0000⟩',
      '|0001⟩',
      '|0110⟩',
      '|1111⟩',
    ])
  })

  it('carries the three things the picture encodes, as numbers', () => {
    draw(state)
    const listed = rows()

    for (const row of listed) {
      const index = Number.parseInt(row.ket.replace(/[|⟩]/gu, ''), 2)
      const re = state.re[index] ?? 0
      const im = state.im[index] ?? 0
      const probability = re * re + im * im
      const magnitude = Math.sqrt(probability)
      const phase = Math.atan2(im, re)
      const folded = phase < 0 ? phase + 2 * Math.PI : phase

      // Radius — the picture's size channel.
      expect(row.magnitude, `${row.ket} magnitude`).toBeCloseTo(magnitude, 4)
      // Probability — what the histogram beside it shows.
      expect(row.probability, `${row.ket} probability`).toBeCloseTo(
        probability,
        4
      )
      // Latitude — the picture's position channel, as a count of ones.
      expect(row.ring, `${row.ket} ring`).toBe(
        `${popcount(index)} of 4 qubits at 1`
      )
      // Phase — the picture's hue channel, in both units §3.2 asks for.
      expect(row.degrees, `${row.ket} degrees`).toBeCloseTo(
        (folded * 180) / Math.PI,
        2
      )
      expect(row.radians, `${row.ket} radians`).toBeCloseTo(folded, 4)
    }
  })

  it('shows the table rather than hiding it behind a screen reader', () => {
    // The Bloch panel's ruling, restated here: a node's radius in an
    // orthographic projection is not a length anyone compares by eye, so a
    // reader with low vision and no screen reader must still get the numbers.
    const view = draw(state)
    const table = view.container.querySelector('.qsphere__grid')
    expect(table).not.toBeNull()
    expect(table?.closest('.visually-hidden')).toBeNull()
    // Its own scroller, so five columns cannot push the page sideways.
    expect(table?.parentElement?.className).toContain('qsphere__viewport')
  })

  it('names the ring in words rather than leaving a bare number', () => {
    // "2" in a column called "Ring" is a position; "2 of 4 qubits are 1" is the
    // fact the ring stands for, and it is the only place the picture's latitude
    // is stated at all.
    draw(state)
    for (const row of rows()) {
      expect(row.ring).toMatch(/\bqubits?\b/u)
      expect(row.ring).toMatch(/^\d+ of \d+ /u)
    }
  })

  it('states how much of the state is on the sphere', () => {
    draw(state)
    const disclosure = screen.getByText(/basis states/u)
    expect(disclosure.textContent).toContain('4')
    expect(disclosure.textContent).toContain('16')
  })
})

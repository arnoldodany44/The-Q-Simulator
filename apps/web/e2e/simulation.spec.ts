/**
 * The one test that proves M0.6 exists as far as a user is concerned.
 *
 * Everything under `src/features/simulation` is covered unit by unit — the
 * scheduler's timing, the worker's message loop, the hook's wiring, the
 * engine's physics — and all of it passed for a milestone in which no worker
 * was ever spawned by the running app, because nothing imported the hook.
 * Only a real browser can settle the join: a real `Worker` compiled by Vite,
 * a real statevector crossing the thread boundary, and a number on screen
 * that could not be there unless every link held.
 *
 * The numbers are the assertion. An empty three-qubit register has exactly
 * one basis state carrying probability — |000⟩ — and a Bell pair has two.
 * Neither can be produced by a component that only pretends to simulate.
 *
 * The catalog sentences are written out rather than imported, following the
 * rule in `support/editor.ts`: a test that read the same file the app
 * rendered from would pass just as happily if every value in it were empty.
 */

import { expect, test } from '@playwright/test'

import {
  buildBellPairByKeyboard,
  openEditor,
  sampledCell,
  sampledRows,
  simulationFact,
  simulationFailure,
  simulationState,
} from './support/editor'

/** The terms the panel labels its facts with, in the default language. */
const QUBITS = 'Qubits'
const BASIS_STATES = 'Basis states with a non-zero probability'

const READY = 'This describes the circuit on screen.'

test('the editor simulates the circuit it is showing', async ({ page }) => {
  await openEditor(page)

  // The dev server sets COOP/COEP (`vite.config.ts`), so this run is the
  // `SharedArrayBuffer` path. Asserted rather than assumed: if the headers
  // ever go, that path stops being covered anywhere but in unit tests, and
  // this is the line that says so.
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true)

  // A blank document is still a circuit: three wires in |000⟩, one basis
  // state. Reaching `ready` at all means a worker spawned, ran, and answered.
  await expect(simulationState(page)).toHaveText(READY)
  await expect(simulationFact(page, QUBITS)).toHaveText('3')
  await expect(simulationFact(page, BASIS_STATES)).toHaveText('1')
  await expect(simulationFailure(page)).toHaveText('')

  await buildBellPairByKeyboard(page)

  // H then CNOT: (|00⟩ + |11⟩)/√2 on the first two wires, so two of the eight
  // basis states carry probability. The editor is showing the answer to the
  // circuit the user just built, not to the one it started with.
  await expect(simulationFact(page, BASIS_STATES)).toHaveText('2')
  await expect(simulationState(page)).toHaveText(READY)
})

/*
 * §5.6/protocol.ts: the statevector crosses the thread boundary through a
 * `SharedArrayBuffer` when the page is cross-origin isolated and through
 * transferred `ArrayBuffer`s when it is not. The headers that grant isolation
 * are set for the dev server and must be set on the deployment too — but a
 * deployment that forgets them has to get slower, never broken, and that
 * promise is only worth anything if it is exercised. Stripping the headers on
 * the way through is the closest a test can get to a misconfigured host.
 */
test('still answers when the page is not cross-origin isolated', async ({
  page,
}) => {
  await page.route('**/*', async (route) => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    delete headers['cross-origin-opener-policy']
    delete headers['cross-origin-embedder-policy']
    await route.fulfill({ response, headers })
  })

  await openEditor(page)
  expect(
    await page.evaluate(() => globalThis.crossOriginIsolated),
    'the headers really were stripped'
  ).toBe(false)

  // No shared memory, so the amplitudes are transferred instead. Same answer,
  // one copy slower, and nothing on screen says otherwise.
  await expect(simulationState(page)).toHaveText(READY)
  await expect(simulationFact(page, BASIS_STATES)).toHaveText('1')

  await buildBellPairByKeyboard(page)
  await expect(simulationFact(page, BASIS_STATES)).toHaveText('2')
})

/*
 * M0.7c's half of the same argument. The shots control is wired to the worker
 * — `sampleShots` runs there, on the state of the very run that answered — and
 * every unit test of it hands the counts in by hand. Only a real browser can
 * show that a tick in a checkbox ends with a thousand real draws in the DOM.
 *
 * The numbers are again the assertion. A Bell pair on three wires has exactly
 * two reachable basis states, so a sample of it is two rows whose counts add
 * up to the shot count and nothing else: a comparison built from the wrong
 * state, or from no state, cannot produce that.
 */
test('shots are drawn on the worker and compared against the exact answer', async ({
  page,
}) => {
  await openEditor(page)
  await buildBellPairByKeyboard(page)

  await page
    .getByRole('checkbox', {
      name: 'Compare a sample with the exact distribution',
    })
    .check()

  await expect(sampledRows(page)).toHaveCount(2)
  // The exact column is the theory: half each, whatever the sample said.
  await expect(sampledCell(page, 0, 0)).toHaveText('50%')
  await expect(sampledCell(page, 1, 0)).toHaveText('50%')

  const drawn = async (): Promise<number[]> =>
    sampledRows(page).evaluateAll((rows) =>
      rows.map((row) =>
        Number(row.querySelectorAll('td')[1]?.textContent?.replace(/\D/gu, ''))
      )
    )

  const counts = await drawn()
  expect(counts[0]! + counts[1]!).toBe(1000)
  // And the sample is a sample rather than the theory rounded off: the seed
  // is fixed, so this split is the same on every run and it is not 500/500.
  expect(counts[0]).not.toBe(500)

  // A hundred times the shots is a tenth of the error, which is the whole
  // point of the control. The slider is keyboard-operable, so this is also
  // how a reader with no pointer reaches the far end of it.
  const slider = page.getByRole('slider', { name: 'Shots' })
  await slider.focus()
  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', '100,000')

  // Polled rather than read once: the previous table stays on screen while
  // the new run crosses the thread boundary, which is the deliberate
  // behaviour — a comparison that blanked on every drag would be unreadable.
  await expect
    .poll(async () => {
      const large = await drawn()
      return large[0]! + large[1]!
    })
    .toBe(100_000)
})

/*
 * WCAG 2.2 SC 1.4.10 again, for what M0.7c added. The analysis panel now
 * carries three tables of numbers — six columns of amplitudes and five of
 * counts — and none of them can shrink to a phone's width without becoming
 * unreadable. They scroll inside their own viewport instead, and the promise
 * that makes is that the *page* never does; `editor.spec.ts` makes the same
 * check with the sampling section closed, which is precisely the state in
 * which these two tables do not exist.
 */
test('the analysis panel never pushes the page sideways at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 })
  await openEditor(page, 'fr')

  await page
    .getByRole('checkbox', {
      name: 'Comparer un échantillon avec la distribution exacte',
    })
    .check()
  await expect(sampledRows(page)).toHaveCount(1)

  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    return { scroll: root.scrollWidth, client: root.clientWidth }
  })
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

  // French is the widest of the three languages and the one that broke the
  // shortcuts panel, so it is the one this asserts in.
  await expect(sampledCell(page, 0, 0)).toHaveText(/100\s%/u)
})

test('a register past the browser ceiling is refused, not attempted', async ({
  page,
}) => {
  await openEditor(page)
  const insertBelowFirst = page.getByRole('button', {
    name: 'Insert a qubit below q0',
  })

  // Seventeen more wires: 3 + 17 = 20, the last size §3.1 keeps in the tab.
  for (let added = 0; added < 17; added += 1) await insertBelowFirst.click()
  await expect(simulationFact(page, QUBITS)).toHaveText('20')
  await expect(simulationFailure(page)).toHaveText('')

  await insertBelowFirst.click()

  // The twenty-first wire is refused on the main thread, so the tab never
  // allocates the 32 MB it could not afford — and the user is told why
  // instead of watching the page freeze.
  await expect(simulationFailure(page)).toContainText('21')
  await expect(simulationFailure(page)).toContainText('20')
  await expect(simulationState(page)).toHaveText('The simulation did not run.')

  // And it recovers: back under the ceiling, the pipeline answers again.
  await page.getByRole('button', { name: 'Remove qubit q0' }).click()
  await expect(simulationState(page)).toHaveText(READY)
  await expect(simulationFailure(page)).toHaveText('')
})

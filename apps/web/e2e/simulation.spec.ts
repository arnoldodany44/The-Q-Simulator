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

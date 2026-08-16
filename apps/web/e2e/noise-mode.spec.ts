/**
 * §3.3 in a real browser: the noisy run really happens, and the ceiling really
 * refuses.
 *
 * Everything under `features/analysis` is covered unit by unit — the unit
 * conversion, the comparison model, the density block, the refusal path — and
 * all of it would pass for a milestone in which no density matrix was ever
 * evolved, because the unit tests hand the panel a payload rather than making
 * one. Only a real browser settles the join: a real `Worker` compiled by Vite,
 * `runNoisyDensity` running on the other side of it, and a fidelity on screen
 * that could not be there unless every link held.
 *
 * The other half is the ceiling. `MAX_DENSITY_QUBITS` is twelve and the editor
 * lets a reader ask for more wires than that, so this is the one place the
 * whole refusal is exercised as a user meets it: a register grown past the
 * limit, a sentence naming both numbers, and a button that switches to the
 * method with no ceiling.
 *
 * The catalog sentences are written out rather than imported, following the
 * rule in `support/editor.ts`: a test that read the same file the app rendered
 * from would pass just as happily if every value in it were empty.
 */

import { expect, test, type Page } from '@playwright/test'

import { openEditor, simulationState } from './support/editor'

const READY = 'This describes the circuit on screen.'

/** The noise mode's own switch, by its accessible name. */
function noiseSwitch(page: Page) {
  return page.getByRole('checkbox', {
    name: 'Run this circuit under a noise model',
  })
}

function figure(page: Page, term: string) {
  return page
    .locator('.noise-comparison__figure')
    .filter({ hasText: term })
    .locator('dd')
}

/**
 * Grows the register through the editor's own control, one wire at a time.
 *
 * Always below `q0`, so the button's accessible name is the same on every
 * press — inserting below the *last* wire would rename it each time and turn
 * this into a loop that has to know how many wires it has already added.
 */
async function addQubits(page: Page, wires: number): Promise<void> {
  const insert = page.getByRole('button', { name: 'Insert a qubit below q0' })
  for (let index = 0; index < wires; index++) await insert.click()
}

test('a noisy run really runs, and the comparison shows the difference', async ({
  page,
}) => {
  await openEditor(page)
  await expect(simulationState(page)).toHaveText(READY)

  await noiseSwitch(page).check()

  // The exact method is the default, so this is `runNoisyDensity` evolving a
  // real ρ on the worker. The sentence saying so is the panel's promise that
  // the digits below it are not shot noise.
  await expect(
    page.getByText(
      'Computed exactly, with no sampling error: every figure below is as precise as the arithmetic allows.'
    )
  ).toBeVisible()

  /*
   * Four numbers, each answering a different question, and every one of them a
   * share in [0, 1] — anything outside it is arithmetic that did not run. Two
   * are printed bare and two as percentages, which is the right choice for each
   * (a fidelity is a figure of merit, a movement is a share of the
   * distribution) and is why the reading below divides when it sees a sign.
   */
  for (const term of [
    'Distribution fidelity',
    'Probability that moved',
    'State fidelity',
    'Purity',
  ]) {
    const text = (await figure(page, term).first().textContent()) ?? ''
    const parsed =
      Number(text.replace(/[^\d.-]/gu, '')) / (text.includes('%') ? 100 : 1)
    expect(parsed, term).toBeGreaterThanOrEqual(0)
    expect(parsed, term).toBeLessThanOrEqual(1)
  }

  // One chart, not two: §3.3's comparison is the histogram with a second mark
  // on it, and a second chart would mean the reader is doing the subtraction.
  const comparison = page.locator('.noise-comparison')
  await expect(comparison.locator('.histogram__plot')).toHaveCount(1)
  await expect(comparison.locator('.histogram__second').first()).toBeAttached()

  // And the difference is a number, in a visible table.
  await expect(
    comparison.getByRole('columnheader', { name: 'With noise' })
  ).toBeVisible()
  await expect(
    comparison.getByRole('columnheader', { name: 'Difference' })
  ).toBeVisible()
})

test('the density matrix is drawn only when it is asked for', async ({
  page,
}) => {
  await openEditor(page)
  await noiseSwitch(page).check()

  await expect(page.locator('.density')).toHaveCount(0)
  await page
    .getByRole('checkbox', { name: 'Show the density matrix (advanced)' })
    .check()

  // Two grids — the real part and the imaginary one — and a table of the
  // entries behind them, which is the rendering a screen reader gets.
  await expect(page.locator('.density__plot')).toHaveCount(2)
  await expect(page.getByText('Real part')).toBeVisible()
  await expect(page.locator('.density__grid-table')).toBeVisible()
})

test('the ceiling refuses in a sentence and offers the way out', async ({
  page,
}) => {
  await openEditor(page)
  await noiseSwitch(page).check()
  // Thirteen qubits: ρ would be 4¹³ complex numbers, a gigabyte, and §3.3
  // stops at twelve. The statevector is 8 K amplitudes and simulates happily,
  // which is exactly the point — the refusal is about one panel. A fresh
  // document starts with three wires.
  await addQubits(page, 10)
  await expect(simulationState(page)).toHaveText(READY)

  const refusal = page.locator('.noise__refusal-text')
  await expect(refusal).toContainText('13')
  await expect(refusal).toContainText('12')
  await expect(refusal).toContainText('trajectories')

  // Nothing else was taken away to report it. A refusal that cost the reader
  // their histogram would be the frozen tab wearing the opposite mask.
  await expect(page.locator('.histogram__plot').first()).toBeVisible()
  await expect(page.locator('.qsphere')).toBeVisible()

  // The way out is a control, and it works.
  await page.getByRole('button', { name: 'Use sampled trajectories' }).click()
  await expect(page.locator('.noise__refusal')).toHaveCount(0)
  await expect(page.getByText('Sampled over', { exact: false })).toBeVisible({
    timeout: 15_000,
  })
})

test('the noise controls speak French too', async ({ page }) => {
  // D2 is not satisfied by a catalog: the surface behind a checkbox is the one
  // nobody opens while translating, so it is opened here.
  await openEditor(page, 'fr')
  await page
    .getByRole('checkbox', {
      name: 'Exécuter ce circuit avec un modèle de bruit',
    })
    .check()

  await expect(page.getByText('Idéal contre bruité')).toBeVisible()
  await expect(page.getByText('Fidélité de distribution')).toBeVisible()

  // No raw key anywhere in the panel, which is the specific failure
  // `no-raw-keys.spec.ts` exists for and cannot reach behind a control.
  const text = (await page.locator('.simulation-panel').textContent()) ?? ''
  expect(text).not.toMatch(/noise\.[a-z]+\./u)
  expect(text).not.toMatch(/density\.[a-z]+\./u)
})

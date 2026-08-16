/**
 * M1.7's definition of done: pressing a format button puts a file on the
 * reader's disk.
 *
 * This is the one claim no unit test can make. `ExportPanel.test.tsx` proves
 * the right bytes reach `saveFile`; what happens *after* that is entirely the
 * browser's business, and it is where downloads quietly stop working — a
 * `data:` URL Chrome refuses, an anchor Firefox will not click because it is
 * detached, an object URL revoked before the fetch that reads it. None of
 * those throw. All of them produce a page where clicking does nothing at all.
 * So the assertions below are Playwright's `download` event: the browser
 * really started a download, with that name, and here are its bytes.
 *
 * The PNG is here for a second reason. Its path runs through an `Image`, a
 * `<canvas>` and a PNG encoder, and jsdom has none of the three — so this is
 * not merely the best place to test rasterisation, it is the only one.
 */

import { expect, test } from '@playwright/test'

import { cellAt, dragOnto, gateChip, openEditor } from './support/editor'

/** The first eight bytes of every PNG file (the signature of the format). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Reads a started download into memory. */
async function bytesOf(download: {
  createReadStream: () => Promise<NodeJS.ReadableStream>
}): Promise<Buffer> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test.describe('Exporting the circuit', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page)
    // One gate is enough to tell an export of the circuit from an export of
    // an empty document, and it is asymmetric: on qubit 0 of three.
    await dragOnto(page, gateChip(page, 'h'), cellAt(page, 0, 0))
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')
  })

  test('downloads OpenQASM 3 that carries the circuit', async ({ page }) => {
    const started = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download as OpenQASM 3' }).click()
    const download = await started

    expect(download.suggestedFilename()).toBe('circuit.qasm')
    const text = (await bytesOf(download)).toString('utf8')
    expect(text).toContain('OPENQASM 3.0;')
    expect(text).toContain('qubit[3] q;')
    // The gate is on qubit 0 and the file says so — unmirrored (D1).
    expect(text).toContain('h q[0];')
  })

  test('downloads Python', async ({ page }) => {
    const started = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download as Qiskit' }).click()
    const download = await started

    expect(download.suggestedFilename()).toBe('circuit.py')
    const text = (await bytesOf(download)).toString('utf8')
    expect(text).toContain('from qiskit import')
    expect(text).toContain('circuit.h(q[0])')
  })

  test('downloads the native JSON, which parses', async ({ page }) => {
    const started = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download as JSON' }).click()
    const download = await started

    expect(download.suggestedFilename()).toBe('circuit.json')
    const document_ = JSON.parse(
      (await bytesOf(download)).toString('utf8')
    ) as {
      qubits: number
      operations: { gate: string }[]
    }
    expect(document_.qubits).toBe(3)
    expect(document_.operations.map((operation) => operation.gate)).toEqual([
      'h',
    ])
  })

  test('downloads an SVG that stands on its own', async ({ page }) => {
    const started = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download as SVG' }).click()
    const download = await started

    expect(download.suggestedFilename()).toBe('circuit.svg')
    const text = (await bytesOf(download)).toString('utf8')
    expect(text).toContain('<svg')
    expect(text).toContain('<style>')
    // Nothing to fetch and nothing to resolve: no external reference, and no
    // custom property that would need a `:root` this file does not have.
    expect(text).not.toContain('var(--')
    expect(text).not.toContain('@import')
  })

  /**
   * The rasteriser, in a browser that actually has one.
   *
   * The bytes are checked twice over: the PNG signature says the file is a
   * PNG rather than an error page, and the size says the encoder had a
   * picture to work with rather than a blank canvas — which is exactly what a
   * failed `drawImage` produces, silently and at a plausible file size for an
   * empty image.
   */
  test('downloads a PNG the browser really rasterised', async ({ page }) => {
    const started = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download as PNG' }).click()
    const download = await started

    expect(download.suggestedFilename()).toBe('circuit.png')
    const bytes = await bytesOf(download)
    expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  test('says what it handed over, where a screen reader hears it', async ({
    page,
  }) => {
    const started = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download as JSON' }).click()
    await started

    await expect(
      page.getByRole('status').filter({ hasText: '.json' })
    ).toHaveText(/circuit\.json/)
  })
})

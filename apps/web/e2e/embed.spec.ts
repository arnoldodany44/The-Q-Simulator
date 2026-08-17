import { expect, test } from '@playwright/test'

/**
 * The embed, in a real browser — §3.4, §11.
 *
 * Everything asserted here is something no unit test can see, and most of it
 * is about HEADERS, which is the half of this feature that only exists at the
 * moment a response leaves a server. `src/embed/headers.ts` declares them,
 * `vite.config.ts` serves them (so this suite exercises the real thing), and
 * `verification/embed-isolation/` proves `vercel.json` carries the same
 * values — this file proves the arrangement actually reaches a browser.
 *
 * THE TWO ANSWERS ARE OPPOSITE AND BOTH ARE ASSERTED. A page that refused to
 * be framed everywhere would be safe and useless; one that allowed it
 * everywhere would be usable and a clickjacking surface on `/settings`. Only
 * asserting both catches the change that makes them the same.
 *
 * WHAT THIS SUITE CANNOT DO: it runs Vite with no API behind it, so
 * `/embed/c/:slug` settles into its "not available" sentence. That is the
 * right state to exercise anyway — it is the one a reader of a blog post sees
 * when a circuit is made private, and it is the state §11 requires to be
 * indistinguishable from a slug nobody minted. The rendered-circuit path is
 * exercised through `?c=`, which needs no server at all (decision D4).
 */

/**
 * A Bell pair, as `lib/circuit-url` encodes one: JSON, deflated, base64url
 * (decision D4). Written out rather than built here because a Playwright spec
 * runs outside the bundler and importing the codec would pull `fflate` and
 * `@qsim/schema` into the test process for one constant.
 *
 * `circuit-url.test.ts` is what proves the codec round-trips; if this literal
 * ever stops decoding, the frame renders its "could not be read" sentence and
 * the assertions below fail loudly rather than passing on an empty page.
 */
const BELL_PARAM = 'izbUMdIx0ImOVsov0DVQ0lHKUNKJNojVASKwkCFQKLkCKGYYq2MIkgECAA'

test.describe('the framing headers', () => {
  test('the ordinary app refuses to be framed, in both spellings', async ({
    request,
  }) => {
    const response = await request.get('/new')

    // `X-Frame-Options` for browsers that do not honour `frame-ancestors`,
    // and the CSP directive for the ones that do and ignore the legacy header
    // when both are present.
    expect(response.headers()['x-frame-options']).toBe('DENY')
    expect(response.headers()['content-security-policy']).toContain(
      "frame-ancestors 'none'"
    )
  })

  test('the embed may be framed by anyone, and sends no X-Frame-Options', async ({
    request,
  }) => {
    const response = await request.get('/embed/c/nobody12345')

    /*
     * The absence is the load-bearing half. `X-Frame-Options` has no "any
     * origin" value — `ALLOW-FROM` is dead in every current browser — so a
     * `SAMEORIGIN` left here by an over-broad header rule would break every
     * embed in the world while looking like a tightening.
     */
    expect(response.headers()['x-frame-options']).toBeUndefined()
    expect(response.headers()['content-security-policy']).toContain(
      'frame-ancestors *'
    )
  })

  test('the app is cross-origin isolated and the embed deliberately is not', async ({
    request,
  }) => {
    const app = await request.get('/new')
    expect(app.headers()['cross-origin-opener-policy']).toBe('same-origin')
    expect(app.headers()['cross-origin-embedder-policy']).toBe('require-corp')

    /*
     * NO COOP is what makes the embed un-isolated, and it is the whole of it.
     * Isolation needs COOP *and* COEP together, and only for a top-level
     * document — so without COOP `crossOriginIsolated` is false whether the
     * embed is framed or opened directly, which is why what this suite
     * exercises is what a reader gets.
     */
    const embed = await request.get('/embed/c/nobody12345')
    expect(embed.headers()['cross-origin-opener-policy']).toBeUndefined()

    /*
     * COEP *is* sent, and both halves of the permission are needed.
     *
     * CORP answers for the embed loaded as a subresource. A nested DOCUMENT
     * loaded into a `COEP: require-corp` parent must carry its own COEP or the
     * load is refused with `ERR_BLOCKED_BY_RESPONSE` before a single script
     * runs — so with CORP alone the embed was blocked by exactly the technical
     * sites the header was added for, and blocked too early for any of its
     * "never show a blank frame" machinery to report it.
     */
    expect(embed.headers()['cross-origin-resource-policy']).toBe('cross-origin')
    expect(embed.headers()['cross-origin-embedder-policy']).toBe('require-corp')
  })

  /**
   * Framed by a page that has itself opted into cross-origin isolation.
   *
   * The property `headers.ts` claims and could not previously deliver, driven
   * end to end rather than asserted as a header table: a parent sending COOP
   * `same-origin` and COEP `require-corp` is cross-origin isolated, and it has
   * to be able to load the embed.
   */
  test('a cross-origin-isolated page can actually frame the embed', async ({
    page,
  }) => {
    const failures: string[] = []
    page.on('requestfailed', (request) => {
      failures.push(request.failure()?.errorText ?? 'failed')
    })

    /*
     * The parent is served by the dev server itself, so it is same-origin —
     * which is the stricter test rather than the weaker one: the embed's own
     * `frame-ancestors *` and CORP are what allow it either way, and COEP is
     * the only thing the parent's `require-corp` is asking about.
     */
    await page.goto('/new')
    const isolated = await page.evaluate(() => window.crossOriginIsolated)
    expect(isolated).toBe(true)

    const framed = await page.evaluate(async () => {
      const frame = document.createElement('iframe')
      frame.src = '/embed/c/nobody12345'
      const loaded = new Promise<boolean>((resolve) => {
        frame.addEventListener('load', () => resolve(true))
        frame.addEventListener('error', () => resolve(false))
        window.setTimeout(() => resolve(false), 10_000)
      })
      document.body.append(frame)
      return loaded
    })

    expect(framed).toBe(true)
    expect(
      failures.filter((text) => text.includes('BLOCKED_BY_RESPONSE'))
    ).toEqual([])
  })

  test('the embed never sends an unlisted slug as a referrer', async ({
    request,
  }) => {
    // The path of an embed IS the credential §11 sizes at 126 bits. The app's
    // `strict-origin-when-cross-origin` would leak it same-origin.
    const embed = await request.get('/embed/c/nobody12345')
    expect(embed.headers()['referrer-policy']).toBe('no-referrer')

    const app = await request.get('/new')
    expect(app.headers()['referrer-policy']).toBe(
      'strict-origin-when-cross-origin'
    )
  })
})

test.describe('the address really serves the other document', () => {
  test('an embed path is answered by embed.html, not by the app', async ({
    page,
  }) => {
    /*
     * The rewrite is the easiest thing here to get wrong and the hardest to
     * notice: an SPA fallback that answered `/embed/c/:slug` with
     * `index.html` would render the whole app — session, router and all — at
     * the one address that must not have one, and it would look fine.
     */
    await page.goto(`/embed?c=${BELL_PARAM}`)

    await expect(page.locator('.embed')).toBeVisible()
    // The app's shell is what must NOT be here.
    await expect(page.locator('.page__header-tools')).toHaveCount(0)
  })

  test('the app is still the app', async ({ page }) => {
    await page.goto('/new')
    await expect(page.locator('.embed')).toHaveCount(0)
  })
})

test.describe('a circuit carried in its own link', () => {
  test('draws the circuit and simulates it without shared memory', async ({
    page,
  }) => {
    await page.goto(`/embed?c=${BELL_PARAM}`)

    // The diagram is labelled rather than hidden: this drawing is complete and
    // the frame has no ARIA grid beside it.
    await expect(page.getByRole('img')).toBeVisible()

    /*
     * THE CROSS-ORIGIN-ISOLATION ASSERTION, made where it is true. The embed
     * sends no COOP/COEP, so `crossOriginIsolated` is false even at the top
     * level — which means `sharedMemoryAvailable()` is false, the request
     * carries `sharedMemory: false`, and `encodeState` takes the documented
     * TRANSFER path. That the histogram appears at all is the proof the
     * fallback works end to end.
     */
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false)

    /*
     * Two bars, which is a Bell pair: the answer arrived from the worker, was
     * decoded on the main thread, and was drawn. Asserted on the marks rather
     * than on the accessible table because the table is `visually-hidden`
     * here — it is the alternative to a length a sighted reader can compare,
     * not the reading (`ProbabilityHistogram.tsx`).
     */
    await expect(page.locator('.histogram__row')).toHaveCount(2, {
      timeout: 15_000,
    })
  })

  test('has no editor, no account and nothing to press', async ({ page }) => {
    await page.goto(`/embed?c=${BELL_PARAM}`)
    await expect(page.locator('.embed')).toBeVisible()

    // Not a locked editor — no editor. A control inside a frame is a control
    // on somebody else's page.
    await expect(page.locator('button')).toHaveCount(0)
    await expect(page.locator('input')).toHaveCount(0)
    await expect(page.locator('form')).toHaveCount(0)
    await expect(page.locator('[role="grid"]')).toHaveCount(0)
  })

  test('every link it has opens a new tab and hands back no handle', async ({
    page,
  }) => {
    await page.goto('/embed/c/nobody12345')
    await expect(page.locator('.embed')).toBeVisible()

    // Asserted over every anchor rather than over the one that exists today:
    // a link that navigated the frame would turn an embed into a way to
    // wander this app inside a stranger's layout.
    for (const link of await page.locator('a').all()) {
      expect(await link.getAttribute('target')).toBe('_blank')
      expect(await link.getAttribute('rel')).toContain('noopener')
    }
  })
})

test.describe('the language a teacher pins', () => {
  test('wins over the reader’s browser', async ({ page }) => {
    /*
     * The whole product detects the reader's language (D2). An embed must
     * not: the frame sits inside a page written in one language, and a French
     * panel in the middle of an English slide is worse than either alone.
     */
    await page.goto(`/embed?c=${BELL_PARAM}&lang=fr`)

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Circuit quantique'
    )
  })

  test('does not touch the language the reader chose in the app', async ({
    page,
  }) => {
    /*
     * An embed shares `localStorage` with the app when it is not sandboxed,
     * so caching a language chosen by somebody else's blog post would change
     * the language of the reader's own editor tab. `embed/i18n.ts` uses no
     * detector and no cache; this is that promise, observed.
     */
    await page.addInitScript(() => {
      window.localStorage.setItem('qsim.language', 'en')
    })
    await page.goto(`/embed?c=${BELL_PARAM}&lang=fr`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')

    expect(
      await page.evaluate(() => window.localStorage.getItem('qsim.language'))
    ).toBe('en')
  })
})

test.describe('what a frame says when it has nothing to show', () => {
  test('refuses without saying whether the circuit exists', async ({
    page,
  }) => {
    /*
     * With no API behind this suite the fetch fails rather than 404s, so what
     * is asserted here is the shape rather than the code: a frame that cannot
     * show a circuit says one sentence and never blanks. The 404 path — where
     * a PRIVATE circuit and a slug nobody minted must be indistinguishable —
     * is asserted in `src/embed/EmbedApp.test.tsx` and, from the other end,
     * in `apps/api/src/routes/embed.test.ts`.
     */
    await page.goto('/embed/c/nobody12345')

    const notice = page.locator('.embed__failure')
    await expect(notice).toBeVisible()
    await expect(notice).not.toHaveText(/private/i)
  })
})

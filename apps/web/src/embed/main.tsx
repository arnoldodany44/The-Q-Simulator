/**
 * The embed's entry point — the second of this app's two documents (§3.4).
 *
 * Compare it with `src/main.tsx`, which is the app's: that one builds a
 * Supabase session, an API client pointed at the session's access token, and a
 * React Query cache, then wraps the router in all three. None of that is here,
 * and none of it is reachable from here — `.dependency-cruiser.cjs` fails the
 * build if a module under `src/embed/` ever imports the router, the session,
 * the query client, the document store, dnd-kit or three.js.
 *
 * That is what makes six frames in a blog post cheap: the entry chunk of this
 * document is the plot renderer, the histogram, i18next and React, and the
 * pieces it shares with the app are downloaded once and served to all six from
 * cache.
 *
 * ── Catalogs first, then render ──────────────────────────────────────────
 *
 * Same order and same `catch` as the app's entry, for the same two reasons: no
 * frame may show a raw i18n key, and a catalog that fails to arrive must
 * degrade rather than leave `#root` empty. A blank rectangle in the middle of
 * a lecture slide is the one outcome with no diagnostic value at all.
 *
 * ── The address is read once, here ───────────────────────────────────────
 *
 * `window.location` is read at mount and handed down as three strings, so
 * every component below is a pure function of its props and a test never has
 * to install a history. Nothing in the frame can change the address.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../index.css'
import { EmbedApp } from './EmbedApp'
import { initEmbedI18n } from './i18n'
import { readEmbedAddress } from './source'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

const root = createRoot(container)
const { pathname, search, origin } = window.location

// The teacher's `?lang=`, already narrowed to a supported tag, or `null` to
// let the reader's browser decide. See `embed/paths.ts`.
const { language } = readEmbedAddress(pathname, search)

function mount(): void {
  root.render(
    <StrictMode>
      <EmbedApp pathname={pathname} search={search} origin={origin} />
    </StrictMode>
  )
}

void initEmbedI18n(language)
  .catch((cause: unknown) => {
    console.error('i18n failed to initialise; rendering the fallback', cause)
  })
  .then(mount)

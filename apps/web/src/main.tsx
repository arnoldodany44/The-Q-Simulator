import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'
import { SessionProvider, createAuthRuntime } from './features/auth'
import { initI18n } from './i18n'
import { ApiProvider, createApiClient, createQueryClient } from './lib/api'
import type { AuthRuntime } from './features/auth'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

const root = createRoot(container)

/**
 * The API transport and the query cache, built once for the tab.
 *
 * Constructed here rather than at module scope inside `lib/api` so that
 * neither is a hidden singleton a test would have to reach around — every
 * suite builds its own pair (see `useCircuits.test.tsx`).
 */
const apiClient = createApiClient()
const queryClient = createQueryClient()

/**
 * The Supabase session, if this deployment has one.
 *
 * `createAuthRuntime` also points the API client at the session's access
 * token, before the first render, so a route that fetches on its first paint
 * is already authenticated. `null` means no Supabase project is configured —
 * a supported state, not a failure: the landing page and the editor work
 * without accounts, so the app mounts and every guarded route redirects.
 *
 * A *misconfiguration* still throws, and is caught here rather than left to
 * take the page down. A white screen is the one outcome with no diagnostic
 * value at all; this way the console names the variable and the public half
 * of the app keeps working.
 */
function authRuntime(): AuthRuntime | null {
  try {
    return createAuthRuntime()
  } catch (cause) {
    console.error('authentication is disabled: bad configuration', cause)
    return null
  }
}

const runtime = authRuntime()

function mount(): void {
  root.render(
    <StrictMode>
      <ApiProvider client={apiClient} queryClient={queryClient}>
        {/*
          Inside the query provider because signing out has to be able to
          throw away everything the previous user's queries cached, and
          outside the router because the session is not a route's concern —
          only the guards are, and they are rendered by routes.
        */}
        <SessionProvider runtime={runtime}>
          <App />
        </SessionProvider>
      </ApiProvider>
    </StrictMode>
  )
}

// Catalogs load before the first render so no frame shows raw i18n keys.
//
// The `catch` is the difference between degrading and disappearing. Locales
// are code-split, so a stale deploy or a dropped request can reject this
// promise — and without a handler the `then` never runs, `#root` stays empty
// and the user is looking at a white page with no way to tell a broken app
// from a slow one. i18next still answers with its own fallback (and with the
// key itself in the worst case), so rendering anyway is strictly better than
// rendering nothing.
void initI18n()
  .catch((cause: unknown) => {
    console.error('i18n failed to initialise; rendering the fallback', cause)
  })
  .then(mount)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'
import { initI18n } from './i18n'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

const root = createRoot(container)

function mount(): void {
  root.render(
    <StrictMode>
      <App />
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

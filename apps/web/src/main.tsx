import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'
import { initI18n } from './i18n'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

// Catalogs load before the first render so no frame shows raw i18n keys.
void initI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})

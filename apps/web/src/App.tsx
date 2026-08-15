/**
 * The route table (specification §9).
 *
 * React Router in declarative mode: the app is a single-page client with no
 * server rendering and no data loaders yet, so `BrowserRouter` plus a list
 * of routes is the whole of it. Loaders and the data router become worth
 * their weight in Phase 1, when circuits start coming from the API.
 *
 * `/new` is the editor over a blank document. `/c/:slug` — the same editor
 * over a saved one — arrives with persistence.
 */

import { BrowserRouter, Route, Routes } from 'react-router'

import { EditorRoute } from './routes/editor'
import { LandingRoute } from './routes/landing'

/**
 * The table on its own, without a router around it, so a test can mount it
 * inside a `MemoryRouter` and assert what each path renders. `App` is then
 * the same table plus the history integration the browser needs.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route path="/new" element={<EditorRoute />} />
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}

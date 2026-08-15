/**
 * The client the hooks call, supplied by a provider.
 *
 * A module singleton would be simpler and would make every hook untestable
 * together: two tests in one file would share one client and one stub
 * `fetch`. A context costs one wrapper in `main.tsx` and lets a test render a
 * hook against a client built over a function that returns exactly the
 * response the case is about.
 *
 * The default is `null` rather than a lazily constructed client on purpose.
 * Building one reads `VITE_API_URL`, which throws in a production build that
 * was never configured — and a component tree with no provider should say
 * "there is no provider" rather than "the API origin is missing", which is a
 * different bug entirely.
 */

import { createContext, useContext } from 'react'

import type { ApiClient } from './client.js'

export const ApiContext = createContext<ApiClient | null>(null)

export function useApiClient(): ApiClient {
  const client = useContext(ApiContext)
  if (client === null) {
    throw new Error(
      'useApiClient must be used inside <ApiProvider>. Wrap the tree in ' +
        'main.tsx, or pass a client explicitly in a test.'
    )
  }
  return client
}

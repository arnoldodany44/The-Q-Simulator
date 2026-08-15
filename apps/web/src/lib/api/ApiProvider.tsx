/**
 * The two providers the server-state layer needs, as one wrapper.
 *
 * They are paired because using one without the other is always a mistake:
 * a `QueryClientProvider` with no API client gives hooks that throw on first
 * render, and an API client with no query client gives a transport nothing
 * calls. Both are constructed by the caller (`main.tsx` in M1.3, a test
 * elsewhere) rather than here, so neither is a hidden singleton.
 *
 * Nothing in this file renders text, which is why it is exempt from nothing:
 * `i18next/no-literal-string` has no literal to complain about, and that is
 * the intended shape for the transport layer — it produces codes, and the
 * screens that arrive in the next milestones translate them.
 */

import { QueryClientProvider } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { ApiContext } from './ApiContext.js'
import type { ApiClient } from './client.js'

export interface ApiProviderProps {
  readonly client: ApiClient
  readonly queryClient: QueryClient
  readonly children: ReactNode
}

export function ApiProvider({
  client,
  queryClient,
  children,
}: ApiProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  )
}

/**
 * Where the user was going before a guard sent them to sign in.
 *
 * `RequireSession` records it in history state; this reads it back, validated
 * — see `paths.ts` for why the value cannot be trusted just because this app
 * is the one that wrote it, and why it is not a `?next=` query parameter.
 *
 * In its own module so that `RequireSession.tsx` exports components and
 * nothing else, which is what keeps fast refresh working for them.
 */

import { useLocation } from 'react-router'

import { intendedPathFrom } from './paths.js'

export function useIntendedPath(): string {
  const location = useLocation()
  return intendedPathFrom(location.state)
}

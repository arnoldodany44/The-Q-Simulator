/**
 * Turns anything a 3D chunk throws into the numeric rendering beside it.
 *
 * Two failures reach here that a scene's own `onUnavailable` cannot: the
 * dynamic import failing (a stale deploy, a dropped request — the same failure
 * mode `loadCatalogs` guards against), and three.js throwing during render on a
 * platform it cannot support. Both would otherwise unmount the whole analysis
 * panel and take the histogram, the amplitude table and the shots control with
 * them, because an uncaught error in a subtree destroys the tree above it. **A
 * picture is not allowed to cost the reader their numbers.**
 *
 * A class because that is still the only way to catch a render error. It is
 * deliberately not a general-purpose boundary: it recovers by telling its
 * parent to stop asking for a scene, which is a decision only a panel that has
 * a numeric rendering to fall back on can make.
 *
 * Shared by the Bloch spheres (M1.6) and the Q-sphere (M2.2). One copy rather
 * than two, because the thing being guaranteed — that a WebGL failure costs
 * nothing but the picture — is a property of the analysis panel as a whole, and
 * two copies would be two places for it to stop being true.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface SceneBoundaryProps {
  readonly children: ReactNode
  readonly onFailure: () => void
  /**
   * What to call the scene in the console. Developer-facing and therefore not
   * a catalog string: it is read beside a stack trace, by whoever has to fix
   * the crash, never by a reader of the page.
   */
  readonly scene: string
}

export class SceneBoundary extends Component<
  SceneBoundaryProps,
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reported, never swallowed: the reader gets a sentence, and whoever has to
    // fix it gets the stack. `no-console` allows `error` for exactly this.
    console.error(`The ${this.props.scene} failed to render`, error, info)
    this.props.onFailure()
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

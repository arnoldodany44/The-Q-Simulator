/**
 * The selection the comment panel opens with, and the one the marker layer asks
 * for — Fase 5, M5.4.
 *
 * It is a shared constant rather than two literals because React Query keys by
 * parameters: the panel and the badges over the canvas want the *same* listing on
 * first paint, and two spellings of "open, page one" would be two cache entries
 * and two requests for one answer. `DEFAULT_COMMENT_STATE` is the contract's, so
 * this cannot drift from what the server does with a request that names no state.
 */

import { DEFAULT_COMMENT_STATE, type CommentState } from '@qsim/contract'

export interface CommentView {
  readonly state: CommentState
  readonly page: number
}

export const DEFAULT_COMMENT_VIEW: CommentView = {
  state: DEFAULT_COMMENT_STATE,
  page: 1,
}

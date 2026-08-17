/**
 * Challenge mode — §3.6, Phase 3.
 *
 * The barrel exists for the reason every other feature's does: routes import
 * from here, and the internals stay free to move.
 *
 * `paths.ts` is deliberately *also* exported from its own module, because
 * `App.tsx` reaches for the two templates and lives in the entry chunk — an
 * import of this barrel there would pull the player, and with it the whole
 * editor, out of the lazy split M0.9b built (see `landing-carries-no-editor`
 * in `.dependency-cruiser.cjs` for what that costs).
 */

export { ChallengeBrief } from './ChallengeBrief'
export type { ChallengeBriefProps } from './ChallengeBrief'

export { ChallengeLeaderboard } from './ChallengeLeaderboard'
export type { ChallengeLeaderboardProps } from './ChallengeLeaderboard'

export { ChallengePlayer } from './ChallengePlayer'
export type { ChallengePlayerProps } from './ChallengePlayer'

export { ChallengeProse } from './ChallengeProse'
export type { ChallengeProseProps } from './ChallengeProse'

export { ChallengeVerdict } from './ChallengeVerdict'
export type { ChallengeVerdictProps } from './ChallengeVerdict'

export {
  CHALLENGE_SLUGS,
  challengeKey,
  isChallengeSlug,
  renderable,
} from './catalog'

export { readLocally } from './local'
export type { LocalReading } from './local'

export {
  CHALLENGES_PATH,
  CHALLENGE_ROUTE_PATH,
  challengePagePath,
} from './paths'

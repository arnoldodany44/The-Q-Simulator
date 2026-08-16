/**
 * The account's own face: the picture, and where the settings screen lives
 * (M1.9).
 *
 * A barrel, imported by the settings and profile routes. `App.tsx` takes the
 * path templates from `./paths`, which imports nothing (M0.9b).
 */

export { Avatar } from './Avatar.js'
export type { AvatarProps } from './Avatar.js'

export { IDENTICON_GRID, hashIdentity, identiconFor } from './identicon.js'
export type { Identicon } from './identicon.js'

export { PROFILE_ALIAS_ROUTE_PATH, SETTINGS_PATH } from './paths.js'

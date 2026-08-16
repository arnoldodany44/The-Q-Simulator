/**
 * @qsim/contract — the REST wire contract, shared by `apps/api` and
 * `apps/web` (§8, §11, §12.3).
 *
 * ── What belongs here ─────────────────────────────────────────────────────
 *
 * Exactly the things both ends of an HTTP call must agree on and neither end
 * may own: the request bodies, the response shapes, the error codes, the
 * paths, and the visibility vocabulary that appears in all of them.
 *
 * ── Why it is a package and not a `types.ts` in the browser ───────────────
 *
 * `apps/web` may not import `@qsim/db` (§12.3, rule 3, and CI fails the
 * build if it ever does), so the browser cannot reach the Prisma types the
 * API's responses are projected from. The tempting shortcut is to hand-copy
 * the response shape into the client. That copy compiles forever: the day the
 * API renames `gateCount`, the browser keeps its old field, TypeScript is
 * happy on both sides, and the bug surfaces as an empty column in a gallery
 * card. This package is the alternative — one declaration, imported by both,
 * so the rename is a compile error in the client on the same commit.
 *
 * ── What must NOT come in here ────────────────────────────────────────────
 *
 *   - Anything from `@qsim/db`. This package is bundled into the browser;
 *     importing the Prisma client would defeat the boundary it exists to
 *     serve. Where a Postgres enum must be visible to both ends it is
 *     re-declared here and `apps/api` asserts the two agree — see
 *     `visibility.ts`.
 *   - Anything from `@qsim/qsim`. The engine runs the simulation; the wire
 *     contract only describes what travels.
 *   - React, the DOM, Node builtins. Same rule as every shared package
 *     (§12.3, rule 2).
 *   - Display text. The API sends codes; `apps/web` translates them into
 *     three catalogs (D2).
 */

export {
  API_ERROR_CODES,
  ErrorDetailSchema,
  ErrorResponseSchema,
  isApiErrorCode,
} from './errors.js'
export type { ApiErrorCode, ErrorDetail, ErrorResponseBody } from './errors.js'

export {
  VISIBILITY_VALUES,
  Visibility,
  VisibilitySchema,
} from './visibility.js'

export {
  CreateCircuitBody,
  CreateVersionBody,
  DEFAULT_PER_PAGE,
  ForkCircuitBody,
  MAX_DESCRIPTION_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PER_PAGE,
  MAX_TAG_INPUT_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
  PaginationQuery,
  TagsSchema,
  UpdateCircuitBody,
  serverCircuitResponses,
  serverTimestamp,
  wireCircuitResponses,
  wireTimestamp,
} from './circuits.js'
export type {
  CircuitCard,
  CircuitDetail,
  CircuitEnvelope,
  CircuitOwner,
  CircuitPage,
  CircuitVersion,
  CircuitVersionSummary,
  CircuitView,
  CircuitWithVersion,
  CreateCircuitRequest,
  CreateVersionRequest,
  ForkCircuitRequest,
  GalleryPage,
  Pagination,
  PaginationParams,
  PublicUser,
  UpdateCircuitRequest,
  UserCircuitsPage,
  VersionEnvelope,
  VersionPage,
} from './circuits.js'

export {
  DEFAULT_GALLERY_LIMIT,
  DEFAULT_GALLERY_SORT,
  GALLERY_SORTS,
  GalleryQuerySchema,
  GallerySortSchema,
  MAX_CURSOR_LENGTH,
  MAX_GALLERY_LIMIT,
  MAX_SEARCH_LENGTH,
  MAX_TAG_QUERY_LENGTH,
  MIN_SEARCH_LENGTH,
  StarStateResponse,
} from './gallery.js'
export type {
  GalleryQuery,
  GalleryQueryParams,
  GallerySort,
  StarState,
} from './gallery.js'

export {
  AVATAR_SOURCES,
  AvatarSourceSchema,
  DeleteAccountBody,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN,
  UpdateProfileBody,
  UsernameSchema,
  serverUserResponses,
  wireUserResponses,
} from './users.js'
export type {
  Account,
  AccountDeletion,
  AvatarSource,
  DeleteAccountRequest,
  Profile,
  UpdateProfileRequest,
} from './users.js'

export {
  AddCollectionItemBody,
  CreateCollectionBody,
  MAX_COLLECTION_DESCRIPTION_LENGTH,
  MAX_COLLECTION_ITEMS,
  MAX_COLLECTION_TITLE_LENGTH,
  UpdateCollectionBody,
  serverCollectionResponses,
  wireCollectionResponses,
} from './collections.js'
export type {
  AddCollectionItemRequest,
  CollectionCard,
  CollectionEnvelope,
  CollectionMembership,
  CollectionPage,
  CollectionView,
  CreateCollectionRequest,
  UpdateCollectionRequest,
} from './collections.js'

export {
  API_PREFIX,
  CIRCUIT_ROUTES,
  COLLECTION_ROUTES,
  GALLERY_ROUTES,
  USER_ROUTES,
  circuitPath,
  collectionPath,
  fillRoute,
  galleryPath,
  userPath,
} from './paths.js'
export type {
  CircuitRoute,
  CollectionRoute,
  GalleryRoute,
  UserRoute,
} from './paths.js'

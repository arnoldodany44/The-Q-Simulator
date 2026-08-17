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
  LESSON_SLUG_PATTERN,
  LessonSlugParams,
  LessonSlugSchema,
  MAX_LESSON_SLUG_LENGTH,
  MAX_LESSON_STEP_INDEX,
  UpdateLessonProgressBody,
  serverLessonResponses,
  wireLessonResponses,
} from './lessons.js'
export type {
  LessonProgress,
  LessonProgressList,
  UpdateLessonProgressRequest,
} from './lessons.js'

export { EmbedAuthor, EmbedCircuit, EmbedCircuitResponse } from './embed.js'
export type {
  EmbedAuthorRef,
  EmbedCircuitResponseBody,
  EmbedCircuitView,
} from './embed.js'

export {
  CHALLENGE_FEEDBACK_CODES,
  CHALLENGE_SLUGS,
  CHALLENGE_SLUG_PATTERN,
  CHALLENGE_TARGET_TYPES,
  ChallengeFeedbackSchema,
  ChallengeSlugParams,
  ChallengeSlugSchema,
  ChallengeTargetTypeSchema,
  DEFAULT_LEADERBOARD_LIMIT,
  LeaderboardQuerySchema,
  MAX_CHALLENGE_SLUG_LENGTH,
  MAX_LEADERBOARD_LIMIT,
  SubmitChallengeBody,
  isChallengeSlug,
  serverChallengeResponses,
  wireChallengeResponses,
} from './challenges.js'
export type {
  Challenge,
  ChallengeFeedback,
  ChallengeFeedbackCode,
  ChallengeList,
  ChallengeSlug,
  ChallengeSubmission,
  ChallengeSubmissionResult,
  ChallengeTargetType,
  ChallengeView,
  Leaderboard,
  LeaderboardEntry,
  LeaderboardQueryParams,
  LeaderboardStanding,
  SubmitChallengeRequest,
} from './challenges.js'

export {
  MAX_SEED,
  NOISE_PROFILE_IDS,
  NoiseProfileIdSchema,
  RUN_STATUS_VALUES,
  RunStatus,
  RunStatusSchema,
  SIMULATION_MODE_VALUES,
  SimulateBody,
  SimulationMode,
  SimulationModeSchema,
  serverSimulateResponses,
  wireSimulateResponses,
} from './simulate.js'
export type {
  NoiseProfileId,
  RunEnvelope,
  SimulateRequest,
  SimulationRun,
} from './simulate.js'

export {
  ClientFrameSchema,
  MAX_SOCKET_FRAMES_PER_WINDOW,
  MAX_SOCKET_FRAME_BYTES,
  MAX_SOCKET_PENDING_FRAMES,
  MAX_SOCKET_SUBSCRIPTIONS,
  MAX_SOCKET_TOKEN_LENGTH,
  SOCKET_CLOSE,
  SOCKET_ERROR_CODES,
  SOCKET_FRAME_WINDOW_MS,
  SOCKET_PATH,
  SUBSCRIPTION_END_REASONS,
  ServerFrameSchema,
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
} from './socket.js'
export type {
  ClientFrame,
  ServerFrame,
  SocketCloseCode,
  SocketErrorCode,
  SubscriptionEndReason,
} from './socket.js'

export {
  DEFAULT_HARDWARE_JOB_SHOTS,
  HARDWARE_JOB_STATUS_VALUES,
  HARDWARE_PROVIDERS,
  CreateHardwareCredentialBody,
  CreateHardwareJobBody,
  HardwareBackendListEnvelope,
  HardwareBackendResponse,
  HardwareJobStatus,
  HardwareJobStatusSchema,
  HardwareProgramResponse,
  HardwareProviderSchema,
  HardwareResultResponse,
  MAX_CREDENTIAL_LABEL,
  MAX_HARDWARE_JOB_PAGE,
  MAX_HARDWARE_JOB_SHOTS,
  MIN_HARDWARE_JOB_SHOTS,
  serverHardwareResponses,
  wireHardwareResponses,
} from './hardware.js'
export type {
  HardwareCredential,
  HardwareJob,
  HardwareProvider,
} from './hardware.js'

export {
  API_KEY_HINT_LENGTH,
  API_KEY_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_SCOPES,
  API_KEY_SECRET_BYTES,
  API_KEY_SECRET_LENGTH,
  ApiKeyScopeSchema,
  CreateApiKeyBody,
  MAX_ACTIVE_API_KEYS,
  MAX_API_KEY_NAME_LENGTH,
  apiKeyHint,
  isApiKeyFormat,
  isApiKeyScope,
  serverApiKeyResponses,
  wireApiKeyResponses,
} from './api-keys.js'
export type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyList,
  ApiKeyScope,
  CreateApiKeyRequest,
} from './api-keys.js'

export {
  PUBLIC_ROUTES,
  UNIVERSAL_ERRORS,
  WORKED_EXAMPLE,
  buildOpenApiDocument,
  jsonSchemaOf,
  openApiPath,
  pathParamNames,
} from './openapi.js'
export type {
  HttpMethod,
  JsonSchema,
  OpenApiOptions,
  PublicRoute,
  RouteResponse,
  WorkedStep,
} from './openapi.js'

export { renderApiReference } from './reference.js'
export type { ReferenceOptions } from './reference.js'

export {
  API_KEY_ROUTES,
  API_PREFIX,
  CHALLENGE_ROUTES,
  CIRCUIT_ROUTES,
  COLLECTION_ROUTES,
  EMBED_ROUTES,
  GALLERY_ROUTES,
  HARDWARE_ROUTES,
  LESSON_ROUTES,
  SIMULATE_ROUTES,
  USER_ROUTES,
  challengePath,
  circuitPath,
  collectionPath,
  embedPath,
  fillRoute,
  galleryPath,
  apiKeyPath,
  hardwarePath,
  lessonPath,
  simulatePath,
  userPath,
} from './paths.js'
export type {
  ApiKeyRoute,
  ChallengeRoute,
  CircuitRoute,
  CollectionRoute,
  EmbedRoute,
  GalleryRoute,
  HardwareRoute,
  LessonRoute,
  SimulateRoute,
  UserRoute,
} from './paths.js'

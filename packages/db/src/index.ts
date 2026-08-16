/**
 * @qsim/db — the Prisma schema, its migrations, and the one client the
 * server processes share (specification §7, §12.6).
 *
 * Consumed by `apps/api` and `apps/worker` only. `apps/web` never imports
 * this package — the browser talks to the API, and a boundary rule in
 * `.dependency-cruiser.cjs` fails CI if that ever stops being true.
 *
 * Where things live:
 *   - `prisma/schema.prisma`  the data model, and the only thing that may
 *                             generate a migration
 *   - `client.ts`             the PrismaClient singleton and why it is one
 *   - `prisma-errors.ts`      which unique constraint a P2002 refers to, in
 *                             every shape Prisma 7 reports it — including the
 *                             one the documentation does not mention
 *   - `users.ts`              `ensureUser`, and the argument for creating the
 *                             row in the backend rather than in a trigger
 *   - `visibility.ts`         the §11 rules as `where` fragments, because
 *                             Prisma connects as `postgres` and RLS does not
 *                             apply
 *   - `projections.ts`        `select` objects paired with their result types
 *   - `circuit-data.ts`       the one crossing between `JsonValue` and the
 *                             @qsim/schema contract, and the storage size cap
 *   - `slugs.ts`              the public handle, and how much entropy it has
 *   - `tags.ts`               the one place a tag's spelling is decided, and
 *                             the races that decision has to survive
 *   - `gallery.ts`            the gallery query: the filter that can only
 *                             narrow, the trigram search, and the keyset
 *                             cursor that replaces `?page=`
 *   - `circuits.ts`           circuit and version persistence: the repository
 *                             interface `apps/api` depends on, and the Prisma
 *                             implementation of it
 *   - `collections.ts`        the one rule a collection must not break — its
 *                             visibility governs the collection, never what is
 *                             inside it
 *   - `accounts.ts`           the settings write, the username race, and what
 *                             deleting an account has to clean up that no
 *                             foreign key will
 */

export {
  createPrismaClient,
  disconnectPrismaClient,
  getPrismaClient,
  poolSizeFromConnectionString,
} from './client.js'

export {
  isUniqueConstraintError,
  uniqueConstraintTargets,
  violatedConstraintMentions,
} from './prisma-errors.js'

export {
  baseUsernameFrom,
  ensureUser,
  uniqueConflictField,
  USERNAME_PATTERN,
  UserIdentityConflictError,
  UsernameUnavailableError,
  withUsernameSuffix,
} from './users.js'
export type {
  NewUserData,
  SupabaseIdentity,
  UserStore,
  UserUniqueField,
} from './users.js'

export {
  canEditCircuit,
  canEditCollection,
  circuitHandleFilter,
  collectionHandleFilter,
  idAddressableCircuitFilter,
  listableCircuitFilter,
  listableCollectionFilter,
  slugAddressableCircuitFilter,
} from './visibility.js'
export type { ViewerId } from './visibility.js'

export {
  circuitCardSelect,
  circuitDetailSelect,
  circuitVersionSummarySelect,
  collectionCardSelect,
  hardwareCredentialMetaSelect,
  publicUserSelect,
  toCircuitCard,
  toCircuitDetail,
  toCollectionCard,
} from './projections.js'
export type {
  CircuitCard,
  CircuitCardRow,
  CircuitDetail,
  CircuitDetailRow,
  CircuitVersionSummary,
  CollectionCard,
  CollectionCardRow,
  HardwareCredentialMeta,
  PublicUser,
} from './projections.js'

export {
  CollectionFullError,
  CollectionNotWritableError,
  MAX_COLLECTION_ITEMS,
  prismaCollectionRepository,
} from './collections.js'
export type {
  CollectionItems,
  CollectionMembership,
  CollectionRepository,
  CreateCollectionInput,
  UpdateCollectionInput,
} from './collections.js'

export { prismaAccountRepository, UsernameTakenError } from './accounts.js'
export type {
  AccountDeletionReport,
  AccountRepository,
  UpdateProfileInput,
} from './accounts.js'

export {
  attachCircuitTags,
  isNormalizedTagName,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_CIRCUIT,
  MIN_TAG_LENGTH,
  normalizeTagName,
  normalizeTagNames,
  readCircuitTagNames,
  setCircuitTags,
  TagLimitError,
} from './tags.js'
export type { TagWriter } from './tags.js'

export {
  cursorAfter,
  decodeGalleryCursor,
  encodeGalleryCursor,
  escapeLikePattern,
  GALLERY_SORTS,
  galleryOrderBy,
  galleryWhere,
  isGallerySort,
  MAX_CURSOR_LENGTH,
  MAX_STAR_COUNT,
} from './gallery.js'
export type { GalleryCursor, GalleryQuery, GallerySort } from './gallery.js'

export {
  CircuitTooLargeError,
  circuitJsonByteLength,
  MAX_CIRCUIT_JSON_BYTES,
  parseCircuitVersion,
  parseStoredCircuit,
  parseStoredPreview,
  toCircuitJson,
  toPreviewJson,
} from './circuit-data.js'
export type { ParsedCircuitVersion } from './circuit-data.js'

export {
  CIRCUIT_HANDLE_PATTERN,
  CIRCUIT_SLUG_ENTROPY_BITS,
  CIRCUIT_SLUG_LENGTH,
  generateCircuitSlug,
  isCircuitHandle,
} from './slugs.js'

export {
  CircuitGoneError,
  CircuitNotWritableError,
  forkCircuit,
  isSlugConflict,
  isVersionNumberConflict,
  MAX_SLUG_ATTEMPTS,
  MAX_VERSION_ATTEMPTS,
  metricsOf,
  MissingVersionError,
  prismaCircuitRepository,
  SlugUnavailableError,
  VERSION_RETRY_BASE_DELAY_MS,
  VersionConflictError,
  versionRetryDelayMs,
} from './circuits.js'
export type {
  AppendVersionInput,
  CircuitMetrics,
  CircuitRepository,
  CircuitWithVersion,
  CreateCircuitInput,
  CursorPage,
  Page,
  StarState,
  StoredVersion,
  UpdateCircuitInput,
} from './circuits.js'

/*
 * The generated client, re-exported so nothing outside this package ever
 * writes `@qsim/db/src/generated/...`. That path is an implementation detail
 * of `prisma generate` and has already changed shape once between major
 * versions.
 */
export { Prisma } from './generated/prisma/client.js'
export type { PrismaClient } from './generated/prisma/client.js'

export {
  JobStatus,
  RunStatus,
  SimMode,
  Visibility,
} from './generated/prisma/enums.js'

export type {
  ApiKey,
  Challenge,
  ChallengeSubmission,
  Circuit,
  CircuitTag,
  CircuitVersion,
  Collection,
  CollectionItem,
  Comment,
  HardwareCredential,
  HardwareJob,
  SimulationRun,
  Star,
  Tag,
  User,
} from './generated/prisma/client.js'

/**
 * The transport layer — everything `apps/web` knows about the API (§8, §9).
 *
 * Nothing outside this directory constructs a URL, sets an `Authorization`
 * header or parses a response. That is not tidiness: it is what makes "the
 * client and the server agree" a property one directory can be read to
 * verify, and what stops a second, subtly different fetch wrapper from
 * appearing next to the first screen that needs one.
 *
 * The boundary that must never move: `apps/web` does not import `@qsim/db`
 * (§12.3, rule 3, enforced in CI). Every shape crossing the wire comes from
 * `@qsim/contract`, which the API imports too.
 */

export { createApiClient } from './client.js'
export type {
  ApiClient,
  ApiClientOptions,
  FetchLike,
  HttpMethod,
  QueryParams,
  RequestSpec,
  ResponseSchema,
} from './client.js'

export {
  DEV_API_BASE_URL,
  resolveApiBaseUrl,
  resolveSocketUrl,
} from './config.js'
export type { ApiEnvSource } from './config.js'

export {
  anonymousAccessToken,
  currentAccessTokenProvider,
  setAccessTokenProvider,
} from './session.js'
export type { AccessTokenProvider } from './session.js'

export {
  ApiRequestError,
  CLIENT_ERROR_CODES,
  ERROR_CODES,
  UNKNOWN_ERROR_KEY,
  errorCodeForStatus,
  errorMessageKey,
  isApiRequestError,
  isForbidden,
  isNotFound,
  isRetryable,
  requiresAuthentication,
} from './errors.js'
export type { ClientErrorCode, ErrorCode } from './errors.js'

export {
  createCircuit,
  createVersion,
  deleteCircuit,
  forkCircuit,
  getCircuit,
  getVersion,
  listCircuits,
  listVersions,
  updateCircuit,
} from './circuits.js'
export type { RequestContext } from './circuits.js'

export {
  galleryQuery,
  listGallery,
  listUserCircuits,
  starCircuit,
  unstarCircuit,
} from './gallery.js'

export { applyStarToPage, applyStarToPages, applyStarToView } from './stars.js'
export type { StarUpdate, StarrablePage } from './stars.js'

export {
  deleteAccount,
  getAccount,
  getProfile,
  listUserCollections,
  updateProfile,
} from './account.js'

export { listLessonProgress, saveLessonProgress } from './lessons.js'

export {
  getChallenge,
  getLeaderboard,
  listChallenges,
  submitChallenge,
} from './challenges.js'

export {
  useChallenge,
  useChallenges,
  useLeaderboard,
  useSubmitChallenge,
} from './useChallenges.js'

export {
  addCollectionItem,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  listCollectionsHolding,
  removeCollectionItem,
  updateCollection,
} from './collections.js'

export {
  deleteComment,
  listComments,
  postComment,
  setThreadResolution,
} from './comments.js'
export {
  useComments,
  useDeleteComment,
  usePostComment,
  useResolveThread,
} from './useComments.js'
export type {
  DeleteCommentVariables,
  PostCommentVariables,
  ThreadResolutionVariables,
} from './useComments.js'

export {
  createHardwareCredential,
  createHardwareJob,
  deleteHardwareCredential,
  getHardwareJob,
  listHardwareBackends,
  listHardwareCredentials,
} from './hardware.js'
export {
  useCreateHardwareCredential,
  useDeleteHardwareCredential,
  useHardwareBackends,
  useHardwareCredentials,
  useHardwareJob,
  useSubmitHardwareJob,
} from './useHardware.js'

export {
  accountKeys,
  challengeKeys,
  circuitKeys,
  collectionKeys,
  commentKeys,
  galleryKeys,
  hardwareKeys,
  lessonKeys,
} from './queryKeys.js'
export {
  DEFAULT_STALE_TIME_MS,
  MAX_QUERY_RETRIES,
  createQueryClient,
  shouldRetryQuery,
} from './queryClient.js'

export { ApiContext, useApiClient } from './ApiContext.js'
export { ApiProvider } from './ApiProvider.js'
export type { ApiProviderProps } from './ApiProvider.js'

export {
  useCircuit,
  useCircuitVersion,
  useCircuitVersions,
  useCircuits,
  useCreateCircuit,
  useDeleteCircuit,
  useForkCircuit,
  useSaveVersion,
  useUpdateCircuit,
} from './useCircuits.js'
export type {
  ForkCircuitVariables,
  SaveVersionVariables,
  UpdateCircuitVariables,
} from './useCircuits.js'

export { useGallery, useStarCircuit, useUserCircuits } from './useGallery.js'
export type { GallerySelection, StarVariables } from './useGallery.js'

export {
  useAccount,
  useDeleteAccount,
  useProfile,
  useUpdateProfile,
  useUserCollections,
} from './useAccount.js'

export {
  useAddCollectionItem,
  useCollection,
  useCollections,
  useCollectionsHolding,
  useCreateCollection,
  useDeleteCollection,
  useRemoveCollectionItem,
  useUpdateCollection,
} from './useCollections.js'
export type {
  CollectionItemVariables,
  UpdateCollectionVariables,
} from './useCollections.js'

export { createApiKey, listApiKeys, revokeApiKey } from './api-keys.js'
export { useApiKeys, useCreateApiKey, useRevokeApiKey } from './useApiKeys.js'

export { useApiErrorMessage } from './useApiErrorMessage.js'
export type { ApiErrorMessage } from './useApiErrorMessage.js'

export { getSimulationRun, submitSimulation } from './simulate.js'

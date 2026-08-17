/**
 * The API key routes of §3.5, as functions.
 *
 * Same rules as `account.ts` beside it: the path comes from `@qsim/contract`'s
 * builders, the body goes through the contract schema before it is sent, and
 * the response is parsed with the wire schema.
 *
 * ── The one thing this module must never grow ─────────────────────────────
 *
 * A `getApiKey`. There is no such route and there must not be one: the server
 * stores a SHA-256 and cannot reproduce a key, so the only moment the value
 * exists is the response of `createApiKey` below. Anything in this app that
 * wants to show a key again has to be a bug, because there is nowhere for it
 * to have come from.
 *
 * That is also why `createApiKey` returns the whole envelope rather than the
 * metadata: the caller is obliged to handle `key`, once, and the type says so.
 */

import {
  CreateApiKeyBody,
  apiKeyPath,
  wireApiKeyResponses,
} from '@qsim/contract'
import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyList,
  CreateApiKeyRequest,
} from '@qsim/contract'

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/** `GET /api-keys` — the caller's keys, revoked ones included. */
export function listApiKeys(
  client: ApiClient,
  context: RequestContext = {}
): Promise<ApiKeyList> {
  return client.request({
    method: 'GET',
    path: apiKeyPath.collection(),
    schema: wireApiKeyResponses.ApiKeyListEnvelope,
    ...context,
  })
}

/**
 * `POST /api-keys` — mints one, and this is the only time the key exists.
 *
 * The body is parsed with the server's own schema first, so an empty name or
 * an empty scope list is a message beside the field rather than a 400 the user
 * has to interpret.
 */
export function createApiKey(
  client: ApiClient,
  request: CreateApiKeyRequest,
  context: RequestContext = {}
): Promise<ApiKeyCreated> {
  return client.request({
    method: 'POST',
    path: apiKeyPath.collection(),
    body: CreateApiKeyBody.parse(request),
    schema: wireApiKeyResponses.ApiKeyCreatedEnvelope,
    ...context,
  })
}

/**
 * `DELETE /api-keys/:id` — revokes, immediately and permanently.
 *
 * Answers with the revoked row rather than nothing, so the screen can show the
 * timestamp the server stamped instead of guessing one from the client clock.
 */
export function revokeApiKey(
  client: ApiClient,
  id: string,
  context: RequestContext = {}
): Promise<{ apiKey: ApiKey }> {
  return client.request({
    method: 'DELETE',
    path: apiKeyPath.item(id),
    schema: wireApiKeyResponses.ApiKeyEnvelope,
    ...context,
  })
}

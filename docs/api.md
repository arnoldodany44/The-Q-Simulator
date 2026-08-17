# The Q Simulator — public API

<!-- Generated from the Zod schemas in @qsim/contract. Do not edit: run `pnpm --filter @qsim/contract test -u` to regenerate. -->

Create circuits, run simulations and read results from outside the application (§3.5). Everything below is generated from the schemas the server validates with, so a field described here is a field the server accepts.

- **Base URL:** `https://the-q-simulator-production.up.railway.app`
- **Version:** `1`
- **Machine-readable:** [`https://the-q-simulator-production.up.railway.app/api/v1/openapi.json`](https://the-q-simulator-production.up.railway.app/api/v1/openapi.json) — OpenAPI 3.1, the complete schemas.
- **Content type:** `application/json`, and nothing else.

## Authentication

Send your key as a bearer token. It is the same header a browser session uses, so any HTTP client works unchanged:

```http
Authorization: Bearer qsk_…
```

A key is `qsk_` followed by 43 characters of base64url — 43 + 4 characters in all, matching `^qsk_[A-Za-z0-9_-]{43}$`. The prefix and the fixed length are deliberate: they make a leaked key findable by one grep, in a log or in a public repository, by somebody who has never seen this API before. Treat it as a password.

Four things that are worth knowing before you build on this:

1. **A key is shown once**, in the response that creates it. It is not recoverable afterwards by anyone, including you: the server stores a SHA-256 of it and there is no endpoint that returns a key. If you lose it, revoke it and mint another.
2. **A key acts as the account that minted it, and can do no less and no more.** It sees exactly the circuits that account sees; somebody else’s PRIVATE circuit answers 404 to your key exactly as it does to your browser.
3. **Revocation is immediate and cannot be undone.** The next request carrying a revoked key fails. There is no cache to wait out.
4. **Rate limits are per key**, not per address and not per account. A runaway script cannot exhaust the budget of your browser session or of your other keys, and a `429` names a key you can revoke.

### Scopes

A key carries one or more of the following. Each endpoint below states the one it requires; a key without it is refused with `API_KEY_SCOPE_REQUIRED` and the `details` name the scope that was missing.

| Scope | What it allows |
| --- | --- |
| `read` | Every read: your circuits and their versions, the gallery, collections, profiles, and the result of a run. |
| `write` | Everything that creates, changes or destroys a document: circuits, versions, forks, stars and collections. |
| `simulate` | Running simulations. Separate from `write` so a key can run your circuits without being able to change them. |

### What no key can do

Two parts of the API are unreachable with a key however it is scoped, and both refuse with `API_KEY_NOT_ACCEPTED`:

- **Managing keys.** A key that could mint keys would survive its own revocation, which would make revoking a leaked key pointless. Mint and revoke from the settings screen, signed in.
- **Real quantum hardware.** Submitting a job spends an allowance that does not refill on request, so it is a decision made by a person at a screen rather than by a script holding a credential.

## Errors

Every failure has the same body. Switch on `error.code`; never display `error.message`, which is fixed English for whoever is holding a terminal.

```json
{
  "error": {
    "code": "API_KEY_SCOPE_REQUIRED",
    "message": "This API key does not carry the scope this endpoint requires.",
    "requestId": "3f0a1c6e-2b7d-4f13-9a55-0c4e6a1d2b88",
    "details": [
      {
        "path": "scope",
        "code": "write"
      }
    ]
  }
}
```

`requestId` is also returned as the `x-request-id` header, on every response. Quote it in a bug report: it is what joins what you saw to the server’s own log line for the same request.

Any endpoint may answer with `AUTH_REQUIRED`, `AUTH_INVALID_TOKEN`, `API_KEY_SCOPE_REQUIRED`, `RATE_LIMITED`, `VALIDATION_FAILED`, `NOT_FOUND`, `INTERNAL_ERROR`. The complete vocabulary is 30 codes, enumerated in the OpenAPI document.

Rate-limited responses carry `retry-after` and `x-ratelimit-remaining`. The remaining budget is on *every* response, not only on the refusal, so a well-behaved client can slow down before it is cut off.

## Conventions

- **Bit order.** Qubit 0 is the least significant bit. A count key `"01"` means qubit 0 measured 1 and qubit 1 measured 0. This is the single most likely thing to get wrong when comparing results with another toolchain.
- **Timestamps** are ISO-8601 in UTC. **Numbers** are IEEE-754 double precision; amplitudes and probabilities agree with the engine to 1e-10.
- **A resource you may not see answers `404`**, never `403`. `403` would confirm that it exists.
- **Listings that can grow are cursor-paged.** Send back the `nextCursor` you were given; a `null` one means you have reached the end. Offsets are not offered, because the default ordering changes while you read it and an offset over a moving order repeats or skips rows without saying so.

## A worked example

Three calls, end to end: make a circuit, run it, read the counts. Set `QSIM_API_KEY` to a key with the `write`, `simulate` and `read` scopes.

### 1. Create a Bell pair

Qubit 0 is the least significant bit, here and everywhere else.

[`POST /api/v1/circuits`](#createcircuit)

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/circuits' \
  -H 'Authorization: Bearer '"$QSIM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Bell pair","visibility":"PRIVATE","circuit":{"schemaVersion":1,"qubits":2,"clbits":2,"operations":[{"id":"op-0","gate":"h","targets":[0],"column":0},{"id":"op-1","gate":"cx","targets":[1],"controls":[0],"column":1}]}}'
```

Abbreviated response:

```json
{
  "circuit": {
    "id": "c8k2r9v4m1x7p3q6t0w5y8z2",
    "slug": "V1StGXR8Z5jdHi6BmyT",
    "title": "Bell pair",
    "visibility": "PRIVATE",
    "qubitCount": 2,
    "gateCount": 2,
    "depth": 2
  },
  "version": {
    "versionNum": 1
  }
}
```

### 2. Run it

The document travels in full even when `circuitId` names a stored circuit: a run has to describe the circuit as it was at submission, or a version appended while the job waited would change what the job computed. `circuitId` is attribution — it is what lets the run be read back later under the same visibility rules. A two-qubit circuit is answered during the request; something larger comes back 202 with `status: "QUEUED"`, and the next step is how you finish it.

[`POST /api/v1/simulate`](#simulate)

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/simulate' \
  -H 'Authorization: Bearer '"$QSIM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"circuitId":"c8k2r9v4m1x7p3q6t0w5y8z2","shots":1024,"seed":7,"circuit":{"schemaVersion":1,"qubits":2,"clbits":2,"operations":[{"id":"op-0","gate":"h","targets":[0],"column":0},{"id":"op-1","gate":"cx","targets":[1],"controls":[0],"column":1}]}}'
```

Abbreviated response:

```json
{
  "run": {
    "id": "r4t7y1u3i9o2p5a8s0d6f2g4",
    "status": "DONE",
    "shots": 1024,
    "result": {
      "resultVersion": 1,
      "qubits": 2,
      "shots": 1024,
      "seed": 7,
      "outcomes": [
        {
          "state": "00",
          "probability": 0.5,
          "count": 508
        },
        {
          "state": "11",
          "probability": 0.5,
          "count": 516
        }
      ],
      "hiddenOutcomes": 0,
      "hiddenWeight": 0
    }
  }
}
```

### 3. Poll, if it was queued

Until `status` is `DONE` or `FAILED`. A queued run also emits `run:progress` frames on the WebSocket, which is cheaper than polling if you are staying connected.

[`GET /api/v1/simulate/{runId}`](#getrun)

Abbreviated response:

```json
{
  "run": {
    "id": "r4t7y1u3i9o2p5a8s0d6f2g4",
    "status": "DONE",
    "durationMs": 41
  }
}
```

## Endpoints

| Method | Path | Scope | Summary |
| --- | --- | --- | --- |
| GET | [`/api/v1/circuits`](#listcircuits) | `read` | List your own circuits |
| POST | [`/api/v1/circuits`](#createcircuit) | `write` | Create a circuit |
| GET | [`/api/v1/circuits/{id}`](#getcircuit) | `read` | Read one circuit and its latest version |
| PATCH | [`/api/v1/circuits/{id}`](#updatecircuit) | `write` | Change a circuit’s title, description, visibility or tags |
| DELETE | [`/api/v1/circuits/{id}`](#deletecircuit) | `write` | Delete a circuit and every version of it |
| POST | [`/api/v1/circuits/{id}/fork`](#forkcircuit) | `write` | Fork a circuit you can read |
| POST | [`/api/v1/circuits/{id}/star`](#starcircuit) | `write` | Star a circuit |
| DELETE | [`/api/v1/circuits/{id}/star`](#unstarcircuit) | `write` | Remove your star |
| GET | [`/api/v1/circuits/{id}/versions`](#listversions) | `read` | List a circuit’s versions |
| POST | [`/api/v1/circuits/{id}/versions`](#createversion) | `write` | Save a new version |
| GET | [`/api/v1/circuits/{id}/versions/{n}`](#getversion) | `read` | Read one version’s document |
| GET | [`/api/v1/gallery`](#listgallery) | `read` | Browse published circuits |
| GET | [`/api/v1/users/{username}/circuits`](#listusercircuits) | `read` | Browse one author’s published circuits |
| GET | [`/api/v1/users/{username}`](#getprofile) | `read` | Read one account’s public profile |
| POST | [`/api/v1/simulate`](#simulate) | `simulate` | Run a simulation |
| GET | [`/api/v1/simulate/{runId}`](#getrun) | `read` | Read a run |
| GET | [`/api/v1/collections`](#listcollections) | `read` | List your own collections |
| POST | [`/api/v1/collections`](#createcollection) | `write` | Create a collection |
| GET | [`/api/v1/collections/{id}`](#getcollection) | `read` | Read a collection and what you may see inside it |
| PATCH | [`/api/v1/collections/{id}`](#updatecollection) | `write` | Change a collection’s title, description or visibility |
| DELETE | [`/api/v1/collections/{id}`](#deletecollection) | `write` | Delete a collection |
| POST | [`/api/v1/collections/{id}/items`](#addcollectionitem) | `write` | Add a circuit to a collection |
| DELETE | [`/api/v1/collections/{id}/items/{circuitId}`](#removecollectionitem) | `write` | Remove a circuit from a collection |
| GET | [`/api/v1/circuits/{id}/collections`](#listcircuitcollections) | `read` | Which of your collections already hold a circuit |
| GET | [`/api/v1/users/{username}/collections`](#listusercollections) | `read` | Browse one account’s collections |
| GET | [`/api/v1/api-keys`](#listapikeys) | _session only_ | List your API keys |
| POST | [`/api/v1/api-keys`](#createapikey) | _session only_ | Mint an API key |
| DELETE | [`/api/v1/api-keys/{id}`](#revokeapikey) | _session only_ | Revoke an API key |

### GET /api/v1/circuits

<a id="listcircuits"></a>

**List your own circuits.** Every circuit the authenticated account owns, newest first, whatever its visibility. This is the one listing that includes PRIVATE work, because it is the caller’s own.

- **Authorisation:** Scope `read`. Requires credentials.

**Query string**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `page` | number \| string | no | The 1-based page number, at most 1000000. |
| `perPage` | number \| string | no | Rows per page, at most 100. |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A page of circuit cards. `items`, `page`, `perPage`, `total`, `totalPages` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/circuits' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/circuits

<a id="createcircuit"></a>

**Create a circuit.** Stores the document as version 1. `qubitCount`, `gateCount` and `depth` are derived from the circuit by the server and are not accepted in the body — sending them changes nothing. Visibility defaults to PRIVATE.

- **Authorisation:** Scope `write`. Requires credentials.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 120 |
| `description` | string \| null | no |  |
| `visibility` | `"PRIVATE"` \| `"UNLISTED"` \| `"PUBLIC"` | no | default `"PRIVATE"` |
| `circuit` | object | yes |  |
| `message` | string \| null | no |  |
| `tags` | string[] | no | max items 8 |

**Responses**

| Status | Body |
| --- | --- |
| 201 | The circuit and its first version. `circuit`, `version` |

**Errors beyond the universal ones:** `CIRCUIT_TOO_LARGE`.

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/circuits' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### GET /api/v1/circuits/{id}

<a id="getcircuit"></a>

**Read one circuit and its latest version.** Answers for a PUBLIC circuit to anybody, for an UNLISTED one to whoever holds its slug, and for a PRIVATE one only to its owner. A circuit you may not see answers 404, never 403 — the two must not be distinguishable.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The circuit, its latest version, and whether you have starred it. `circuit`, `version`, `starred` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### PATCH /api/v1/circuits/{id}

<a id="updatecircuit"></a>

**Change a circuit’s title, description, visibility or tags.** Cannot touch the document: changing the circuit itself is a new version. At least one field must be present.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no | min length 1, max length 120 |
| `description` | string \| null | no |  |
| `visibility` | `"PRIVATE"` \| `"UNLISTED"` \| `"PUBLIC"` | no |  |
| `tags` | string[] | no | max items 8 |

**Responses**

| Status | Body |
| --- | --- |
| 200 | The updated circuit. `circuit` |

**Errors beyond the universal ones:** `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X PATCH 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### DELETE /api/v1/circuits/{id}

<a id="deletecircuit"></a>

**Delete a circuit and every version of it.** Irreversible. The versions go with it, by cascade.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Responses**

| Status | Body |
| --- | --- |
| 204 | Deleted. _(empty)_ |

**Errors beyond the universal ones:** `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X DELETE 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/circuits/{id}/fork

<a id="forkcircuit"></a>

**Fork a circuit you can read.** Copies the latest version into a new circuit owned by you, PRIVATE by default, with `forkedFromId` set. Attribution is set by the server and never by a request body.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Request body** (`application/json`)

No fields of its own; see the machine-readable schema for the shape.

**Responses**

| Status | Body |
| --- | --- |
| 201 | The new circuit and its first version. `circuit`, `version` |

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/fork' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### POST /api/v1/circuits/{id}/star

<a id="starcircuit"></a>

**Star a circuit.** Idempotent: starring twice is one star.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The new star count and your own state. `starred`, `starCount` |

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/star' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### DELETE /api/v1/circuits/{id}/star

<a id="unstarcircuit"></a>

**Remove your star.** Idempotent: unstarring twice is not a negative count.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The new star count and your own state. `starred`, `starCount` |

<details><summary>curl</summary>

```bash
curl -X DELETE 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/star' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/circuits/{id}/versions

<a id="listversions"></a>

**List a circuit’s versions.** Metadata only. The document of one version is fetched separately, because a version payload can be hundreds of kilobytes.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Query string**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `page` | number \| string | no | The 1-based page number, at most 1000000. |
| `perPage` | number \| string | no | Rows per page, at most 100. |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A page of version summaries, newest first. `items`, `page`, `perPage`, `total`, `totalPages` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/versions' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/circuits/{id}/versions

<a id="createversion"></a>

**Save a new version.** Appends. Versions are immutable and numbered per circuit, so there is no update and no delete — restoring version 3 means saving its payload as version 8.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `circuit` | object | yes |  |
| `message` | string \| null | no |  |

**Responses**

| Status | Body |
| --- | --- |
| 201 | The stored version. `version` |

**Errors beyond the universal ones:** `VERSION_CONFLICT`, `CIRCUIT_TOO_LARGE`, `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/versions' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### GET /api/v1/circuits/{id}/versions/{n}

<a id="getversion"></a>

**Read one version’s document.** The full circuit as it was saved.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.
  - `n` — The version number, counting from 1.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The version and its circuit. `version` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/versions/<n>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/gallery

<a id="listgallery"></a>

**Browse published circuits.** Only PUBLIC circuits, plus your own if you are authenticated. Paged with a cursor rather than an offset: the default ordering is a column other people change while you read, and an OFFSET over a moving order repeats or skips rows silently. Pass the `nextCursor` you were given.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.

**Query string**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `sort` | `"recent"` \| `"stars"` | no | default `"recent"` |
| `tag` | string | no | min length 1, max length 64 |
| `q` | string | no | min length 3, max length 64 |
| `cursor` | string | no | max length 256 |
| `limit` | number \| string | no |  |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A cursor page of circuit cards. `items`, `nextCursor`, `limit`, `starred` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/gallery' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/users/{username}/circuits

<a id="listusercircuits"></a>

**Browse one author’s published circuits.** The gallery query narrowed to one account. What you see is what that account has published to you, so an owner reading their own sees more.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `username` — The author’s public handle.

**Query string**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `sort` | `"recent"` \| `"stars"` | no | default `"recent"` |
| `tag` | string | no | min length 1, max length 64 |
| `q` | string | no | min length 3, max length 64 |
| `cursor` | string | no | max length 256 |
| `limit` | number \| string | no |  |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A cursor page, plus the author. `items`, `nextCursor`, `limit`, `starred`, `user` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/users/<username>/circuits' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/users/{username}

<a id="getprofile"></a>

**Read one account’s public profile.** A name, a picture and two counts. Both counts go through the same visibility filters the listings do, so the number is the number of cards you would get by paging to the end.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `username` — The account’s public handle.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The profile. `user`, `circuitCount`, `collectionCount` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/users/<username>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/simulate

<a id="simulate"></a>

**Run a simulation.** Small circuits are answered synchronously with a finished run; larger ones are queued and answered 202 with a run you poll. Either way the response is the same shape, so a client that reads `status` needs no second code path. Qubit 0 is the least significant bit of every bitstring in the result.

- **Authorisation:** Scope `simulate`. Works without credentials; what you see depends on who you are.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `circuit` | object | yes |  |
| `mode` | `"STATEVECTOR"` \| `"DENSITY_MATRIX"` \| `"TRAJECTORIES"` | no | default `"STATEVECTOR"` |
| `shots` | integer | no | ≥ 1, ≤ 100000 |
| `seed` | integer | no | ≥ 0, ≤ 4294967295 |
| `noiseProfileId` | `"ideal"` \| `"superconducting"` \| `"trappedIon"` \| `"teaching"` | no |  |
| `readout` | boolean | no | default `true` |
| `circuitId` | string | no | min length 1, max length 64 |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A finished run, computed during the request. `run` |
| 201 | A finished run that was stored against a circuit. `run` |
| 202 | A queued run. Poll it with the id. `run` |

**Errors beyond the universal ones:** `SIMULATION_TOO_LARGE`, `SIMULATION_UNAVAILABLE`.

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/simulate' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### GET /api/v1/simulate/{runId}

<a id="getrun"></a>

**Read a run.** A run belongs to whoever asked for it, not to the circuit — several runs of one circuit may differ only by seed. Poll this until `status` is `DONE` or `FAILED`.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `runId` — The id from the run you were given.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The run, with its result once it has one. `run` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/simulate/<runId>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/collections

<a id="listcollections"></a>

**List your own collections.** Yours, whatever their visibility.

- **Authorisation:** Scope `read`. Requires credentials.

**Query string**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `page` | number \| string | no | The 1-based page number, at most 1000000. |
| `perPage` | number \| string | no | Rows per page, at most 100. |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A page of collection cards. `items`, `page`, `perPage`, `total`, `totalPages` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/collections' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/collections

<a id="createcollection"></a>

**Create a collection.** PRIVATE by default, like a circuit.

- **Authorisation:** Scope `write`. Requires credentials.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 120 |
| `description` | string \| null | no |  |
| `visibility` | `"PRIVATE"` \| `"UNLISTED"` \| `"PUBLIC"` | no | default `"PRIVATE"` |

**Responses**

| Status | Body |
| --- | --- |
| 201 | The new collection. `collection` |

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/collections' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### GET /api/v1/collections/{id}

<a id="getcollection"></a>

**Read a collection and what you may see inside it.** A collection’s visibility governs the collection and never its contents: a PUBLIC collection holding a PRIVATE circuit does not publish it. `withheldItemCount` says how many items were hidden from you — a number, never an identifier.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `id` — The collection’s id.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The collection and its visible items. `collection`, `items`, `withheldItemCount`, `starred` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/collections/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### PATCH /api/v1/collections/{id}

<a id="updatecollection"></a>

**Change a collection’s title, description or visibility.** At least one field must be present.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The collection’s id.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no | min length 1, max length 120 |
| `description` | string \| null | no |  |
| `visibility` | `"PRIVATE"` \| `"UNLISTED"` \| `"PUBLIC"` | no |  |

**Responses**

| Status | Body |
| --- | --- |
| 200 | The updated collection. `collection` |

**Errors beyond the universal ones:** `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X PATCH 'https://the-q-simulator-production.up.railway.app/api/v1/collections/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### DELETE /api/v1/collections/{id}

<a id="deletecollection"></a>

**Delete a collection.** The circuits in it are untouched: a collection holds references, and deleting the shelf does not burn the books.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The collection’s id.

**Responses**

| Status | Body |
| --- | --- |
| 204 | Deleted. _(empty)_ |

**Errors beyond the universal ones:** `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X DELETE 'https://the-q-simulator-production.up.railway.app/api/v1/collections/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/collections/{id}/items

<a id="addcollectionitem"></a>

**Add a circuit to a collection.** Two authorisations, both checked: you own the collection, and you may read the circuit. Idempotent.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The collection’s id.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `circuit` | string | yes |  |

**Responses**

| Status | Body |
| --- | --- |
| 200 | The collection, with its new item count. `collection` |

**Errors beyond the universal ones:** `COLLECTION_FULL`, `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/collections/<id>/items' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### DELETE /api/v1/collections/{id}/items/{circuitId}

<a id="removecollectionitem"></a>

**Remove a circuit from a collection.** Idempotent.

- **Authorisation:** Scope `write`. Requires credentials.
- **Path parameters:**
  - `id` — The collection’s id.
  - `circuitId` — The circuit’s id, as the collection lists it.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The collection. `collection` |

**Errors beyond the universal ones:** `FORBIDDEN`.

<details><summary>curl</summary>

```bash
curl -X DELETE 'https://the-q-simulator-production.up.railway.app/api/v1/collections/<id>/items/<circuitId>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/circuits/{id}/collections

<a id="listcircuitcollections"></a>

**Which of your collections already hold a circuit.** Scoped to your own collections. "Who has collected this" is a different question about other people’s curation, and this API does not answer it.

- **Authorisation:** Scope `read`. Requires credentials.
- **Path parameters:**
  - `id` — The circuit’s `slug` or its `id`. Both are unique; a slug is the shareable form and is the only handle that reaches an UNLISTED circuit.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The ids of your collections holding it. `collectionIds` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/circuits/<id>/collections' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/users/{username}/collections

<a id="listusercollections"></a>

**Browse one account’s collections.** What that account has published to you.

- **Authorisation:** Scope `read`. Works without credentials; what you see depends on who you are.
- **Path parameters:**
  - `username` — The account’s public handle.

**Query string**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `page` | number \| string | no | The 1-based page number, at most 1000000. |
| `perPage` | number \| string | no | Rows per page, at most 100. |

**Responses**

| Status | Body |
| --- | --- |
| 200 | A page of collection cards. `items`, `page`, `perPage`, `total`, `totalPages` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/users/<username>/collections' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### GET /api/v1/api-keys

<a id="listapikeys"></a>

**List your API keys.** Metadata only. No endpoint returns a key, including this one and including to the account that owns it — the server stores a SHA-256 and cannot reproduce the original.

- **Authorisation:** Session only — no API key may use this endpoint, however it is scoped. Requires credentials.

**Responses**

| Status | Body |
| --- | --- |
| 200 | Your keys, revoked ones included. `apiKeys` |

<details><summary>curl</summary>

```bash
curl -X GET 'https://the-q-simulator-production.up.railway.app/api/v1/api-keys' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

### POST /api/v1/api-keys

<a id="createapikey"></a>

**Mint an API key.** The only response in this API that contains a key. Store it now: it is not recoverable, and the remedy for losing it is to revoke this key and mint another.

- **Authorisation:** Session only — no API key may use this endpoint, however it is scoped. Requires credentials.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 60 |
| `scopes` | `"read"` \| `"write"` \| `"simulate"`[] | yes | min items 1, max items 3 |

**Responses**

| Status | Body |
| --- | --- |
| 201 | The key, once, and its metadata. `apiKey`, `key` |

**Errors beyond the universal ones:** `API_KEY_LIMIT_REACHED`.

<details><summary>curl</summary>

```bash
curl -X POST 'https://the-q-simulator-production.up.railway.app/api/v1/api-keys' \
  -H 'Authorization: Bearer $QSIM_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{ … }'
```

</details>

### DELETE /api/v1/api-keys/{id}

<a id="revokeapikey"></a>

**Revoke an API key.** Immediate and permanent. The next request carrying that key fails; there is no cache to wait out and no way to undo it. The row survives with a `revokedAt`, so the record of what was turned off and when is still there afterwards.

- **Authorisation:** Session only — no API key may use this endpoint, however it is scoped. Requires credentials.
- **Path parameters:**
  - `id` — The key’s id, from the listing.

**Responses**

| Status | Body |
| --- | --- |
| 200 | The revoked key. `apiKey` |

<details><summary>curl</summary>

```bash
curl -X DELETE 'https://the-q-simulator-production.up.railway.app/api/v1/api-keys/<id>' \
  -H 'Authorization: Bearer $QSIM_API_KEY'
```

</details>

-- The gallery's indexes — milestone M1.5, specification §3.4 and §8.
--
-- Nothing here reads, writes, moves or drops a single row. It installs one
-- extension and creates five indexes.
--
-- ── Why trigram search and not tsvector ───────────────────────────────────
--
-- The gallery searches title and description, case-insensitively. Both
-- candidates were considered against this project rather than in general:
--
--   * `to_tsvector` + GIN is the faster index at scale and understands word
--     boundaries and stemming — but a text-search configuration names ONE
--     language. This product is trilingual from day one (D2: es, en, fr) and
--     the corpus is user-written titles in all three, so `english` would stem
--     two thirds of the rows wrongly and `simple` would stem nothing, which
--     gives up the only advantage tsvector had. It also cannot match inside a
--     word: someone typing "grov" into a search box expects Grover, and
--     `to_tsquery('grov')` finds nothing at all. Prefix search (`grov:*`)
--     helps only at the start of a lexeme, never in the middle. And it needs
--     a stored generated column plus a rewrite of every row.
--
--   * `pg_trgm` + GIN indexes three-character shingles, so `ILIKE '%grov%'`
--     is an index lookup rather than a sequential scan. It has no opinion
--     about language, matches anywhere inside a word, needs no extra column,
--     and its one real limit is that a search term shorter than three
--     characters produces no trigrams and therefore cannot use the index.
--     That limit is enforced at the edge instead: `@qsim/contract` requires
--     `q` to be at least three characters, so there is no query shape that
--     can make this table scan.
--
-- Trigrams win here on the language argument alone. If a Phase 3 lessons
-- corpus ever wants real linguistic search, tsvector can be added beside this
-- rather than instead of it.
--
-- The extension goes in `extensions`, which is where Supabase puts them and
-- where its search_path already looks. Not in `public`: PostgREST publishes
-- functions in `public` as RPC endpoints, and the previous migration exists
-- precisely to keep anonymous callers out of that schema. The operator class
-- is written schema-qualified below so the index does not depend on whatever
-- search_path the migration runner happens to have.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA "extensions";

-- ── The keyset indexes ────────────────────────────────────────────────────
--
-- §7's `Circuit_visibility_starCount_idx` covers the ordering but not the
-- tie-breaks, and cursor pagination orders by the whole tuple. Most circuits
-- have zero stars, so an index that stops at `starCount` leaves Postgres
-- sorting nearly the entire gallery on every page.

-- CreateIndex
CREATE INDEX "Circuit_visibility_starCount_createdAt_id_idx" ON "Circuit"("visibility", "starCount" DESC, "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Circuit_visibility_createdAt_id_idx" ON "Circuit"("visibility", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Circuit_title_trgm_idx" ON "Circuit" USING GIN ("title" "extensions".gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Circuit_description_trgm_idx" ON "Circuit" USING GIN ("description" "extensions".gin_trgm_ops);

-- The join table's primary key is (circuitId, tagId), which answers "what
-- tags does this circuit have" and cannot answer the gallery's question,
-- "which circuits carry this tag" — a composite key is not probeable by its
-- second column. Without this, every `?tag=` request scans the join table.

-- CreateIndex
CREATE INDEX "CircuitTag_tagId_idx" ON "CircuitTag"("tagId");

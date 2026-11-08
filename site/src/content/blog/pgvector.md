---
title: "pgvector: self-hosted vector search in Postgres"
description: "Set up pgvector on self-hosted Postgres: install it in Docker, store embeddings, pick HNSW or IVFFlat, filter results, and tune for speed and memory."
date: 2026-11-08
category: Databases
keywords: pgvector, pgvector docker, postgres vector search, self-hosted vector database, pgvector hnsw
---

You are adding semantic search or retrieval to an app, and every tutorial points you at a dedicated vector database. Before you add a new system to run, back up and secure, check whether the database you already have can do the job. With pgvector, PostgreSQL stores embeddings next to your rows and searches them with real indexes. This guide shows how to run pgvector on self-hosted Postgres, model the data, choose an index, filter results correctly, and tune memory, plus where a dedicated engine still makes sense.

## Why pgvector instead of a separate vector database

pgvector is an open-source PostgreSQL extension that adds a `vector` type, distance operators and approximate nearest-neighbor indexes. The case for it is mostly operational:

- **One database to run.** Backups, access control, monitoring and upgrades you already do cover your vectors too.
- **Transactions and joins.** An embedding is written in the same transaction as the document it describes, and a search can join to users, permissions and tenants in plain SQL.
- **No sync job.** With a separate vector store, you keep two systems consistent, and deletes are where that breaks.

The case against it is scale and specialization. Past tens of millions of vectors, or when you need features like built-in hybrid ranking, quantization pipelines and multi-node sharding, a dedicated engine such as Qdrant, Weaviate or Milvus can be the better tool. For most apps, the first million documents fit comfortably in Postgres.

## Run Postgres with pgvector in Docker

The official `postgres` image does not include pgvector. The pgvector project publishes images built on top of it:

```yaml
services:
  db:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    shm_size: 512mb
    networks:
      - internal

volumes:
  pgdata:

networks:
  internal:
```

Pin a specific tag in production. The project also publishes tags that include the pgvector version (for example `0.8.1-pg17`), which pin both the Postgres major and the extension.

If you already run the official `postgres` image and want to keep your data volume, build a small image on top of the same major version:

```dockerfile
FROM postgres:17.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-pgvector \
 && rm -rf /var/lib/apt/lists/*
```

The package comes from the PostgreSQL apt repository the official image already uses. Then enable the extension once per database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

Use version 0.8 or later. It added iterative index scans, which fix the most common filtering problem described below.

## Store embeddings

Size the column to your embedding model's output. OpenAI's `text-embedding-3-small` returns 1,536 dimensions by default; many open models return 384, 768 or 1,024.

```sql
CREATE TABLE documents (
  id         bigserial PRIMARY KEY,
  tenant_id  bigint NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  embedding  vector(1536) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

For retrieval, chunk long documents into passages of a few hundred tokens and store one row per chunk with a reference to the parent document. One embedding for a 40-page PDF matches nothing well.

Insert from your app with any Postgres driver. The vector literal is a bracketed list:

```sql
INSERT INTO documents (tenant_id, title, body, embedding)
VALUES (42, 'Refund policy', 'Refunds are issued within 14 days...', '[0.0123, -0.0456, ...]');
```

Most languages have a small pgvector helper package (`pgvector` for Python, Node.js, Go and Ruby, among others) that converts arrays for you.

### Save memory with halfvec

A `vector` stores 4 bytes per dimension, so 1,536 dimensions take about 6 KB per row before the index. The `halfvec` type stores 2 bytes per dimension with a negligible loss in recall for most embedding models. You can keep full precision in the table and index at half precision:

```sql
CREATE INDEX ON documents
  USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops);
```

Queries must then use the same cast for the planner to pick the index.

## Query: distance operators

pgvector adds three main operators. Use the one that matches how your model was trained; for most text embedding models that is cosine.

| Operator | Distance | Index operator class |
| --- | --- | --- |
| `<->` | Euclidean (L2) | `vector_l2_ops` |
| `<=>` | Cosine | `vector_cosine_ops` |
| `<#>` | Negative inner product | `vector_ip_ops` |

A nearest-neighbor query orders by distance and limits:

```sql
SELECT id, title, 1 - (embedding <=> $1) AS similarity
FROM documents
ORDER BY embedding <=> $1
LIMIT 10;
```

The `ORDER BY ... LIMIT` shape is what lets Postgres use a vector index. A `WHERE embedding <=> $1 < 0.3` without that shape scans the whole table.

## HNSW or IVFFlat?

Without an index, pgvector does an exact scan: perfect recall, linear time. That is fine for a few thousand rows. Beyond that, add an approximate index.

| | HNSW | IVFFlat |
| --- | --- | --- |
| Query speed | Faster at the same recall | Slower |
| Build time | Slower | Faster |
| Memory during build | Higher | Lower |
| Needs data before building | No | Yes, it trains lists on existing rows |
| Handles inserts after build | Well | Recall drifts as data changes |
| Main tuning knobs | `m`, `ef_construction`, `hnsw.ef_search` | `lists`, `ivfflat.probes` |

Choose HNSW unless build time or memory is the constraint. It works on an empty table and keeps good recall as rows arrive.

```sql
-- Give the build enough memory, and use several workers
SET maintenance_work_mem = '2GB';
SET max_parallel_maintenance_workers = 4;

CREATE INDEX CONCURRENTLY documents_embedding_hnsw
  ON documents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

`CONCURRENTLY` keeps the table writable during the build. If `maintenance_work_mem` is too small for the graph, pgvector logs a notice and the build becomes much slower; size it to the index, and make sure the container's memory limit and `shm_size` allow it.

At query time, `hnsw.ef_search` trades speed for recall. The default is 40. Raise it per session or per transaction when quality matters more than latency:

```sql
SET LOCAL hnsw.ef_search = 100;
```

## Filtering without losing results

The most common pgvector surprise: you filter by tenant and get back fewer results than your `LIMIT`, or none at all.

```sql
SELECT id, title
FROM documents
WHERE tenant_id = 42
ORDER BY embedding <=> $1
LIMIT 10;
```

An approximate index returns its top `ef_search` candidates first, and Postgres applies the `WHERE` after. If tenant 42 owns 1% of the rows, most candidates are filtered away. Three fixes, in order of preference:

1. **Iterative index scans (pgvector 0.8+).** The index keeps scanning until enough rows pass the filter:

```sql
SET hnsw.iterative_scan = relaxed_order;
```

2. **Partial indexes** for a small number of large, stable segments, such as one per language: `CREATE INDEX ... WHERE lang = 'en'`.
3. **Partitioning** by tenant when tenants are few and large, so each partition has its own index.

A plain B-tree index on `tenant_id` also helps. For tenants with few rows, the planner may skip the vector index and do an exact scan of that tenant's rows, which is both correct and fast.

## Hybrid search: vectors plus keywords

Vector search misses exact terms like product codes and names. Postgres already has full-text search, so you can combine both and merge the rankings with reciprocal rank fusion:

```sql
WITH semantic AS (
  SELECT id, row_number() OVER (ORDER BY embedding <=> $1) AS rank
  FROM documents ORDER BY embedding <=> $1 LIMIT 50
),
keyword AS (
  SELECT id, row_number() OVER (
    ORDER BY ts_rank_cd(to_tsvector('english', body), query) DESC) AS rank
  FROM documents, plainto_tsquery('english', $2) AS query
  WHERE to_tsvector('english', body) @@ query
  LIMIT 50
)
SELECT id, sum(1.0 / (60 + rank)) AS score
FROM (SELECT * FROM semantic UNION ALL SELECT * FROM keyword) AS hits
GROUP BY id
ORDER BY score DESC
LIMIT 10;
```

In production, store the `tsvector` in a generated column with a GIN index instead of computing it per query. The [self-hosted RAG stack](/blog/rag-stack-self-hosted/) guide puts this into a full retrieval pipeline.

## Operating pgvector in production

- **Memory.** HNSW indexes perform best when they fit in RAM. Check the size with `SELECT pg_size_pretty(pg_relation_size('documents_embedding_hnsw'));` and keep `shared_buffers` plus the OS cache comfortably above it.
- **Backups.** Embeddings are part of your data; `pg_dump` includes them. They are also expensive to regenerate, so keep backups even if you could re-embed in theory. See Postgres backup to S3.
- **Re-embedding.** When you change models, the dimensions and the vector space change. Add a new column, backfill it, build its index, switch queries, then drop the old column.
- **Upgrades.** After upgrading the extension package, run `ALTER EXTENSION vector UPDATE;` in each database.

The broader Postgres setup (tuning, roles, monitoring) is in [self-host PostgreSQL](/blog/self-host-postgresql/).

## pgvector on LogiStack

LogiStack is an open-source PaaS for your own servers. Its managed PostgreSQL databases (17, 16 and 15) run the official `postgres` image, which does not include pgvector. You have two ways to run it:

- **The [PostgreSQL with 80+ extensions template](/templates/postgres-extensor/).** It deploys Postgres 18 with pgvector, PostGIS, TimescaleDB, pg_cron and many more preinstalled, on a persistent volume, with a generated password. Run `CREATE EXTENSION vector;` and start.
- **A Docker image service** with `pgvector/pgvector:pg17` and a volume for the data directory, from **New service** › **Docker image** ([docs](/docs/deploy/from-image/)).

Both are regular services rather than managed databases, so back up their volume with a [backup policy](/docs/data/backups/) (turn on the option that stops the service while archiving, for a consistent copy), or run `pg_dump` on a cron with a [schedule](/docs/data/schedules/) that runs in a fresh container.

If you outgrow Postgres for vectors, the [Qdrant template](/templates/qdrant/) runs a dedicated vector engine with an API key on the same server.

## FAQ

### Is pgvector fast enough for production?

For most apps, yes. With an HNSW index that fits in memory, queries over a few million vectors return in milliseconds. Dedicated engines pull ahead at much larger scale or with heavy filtering and quantization needs.

### Should I use HNSW or IVFFlat in pgvector?

HNSW in most cases: faster queries, good recall as data changes, and no need to load data before building. IVFFlat builds faster with less memory, which helps when you rebuild very large indexes often.

### Why does my filtered pgvector query return too few rows?

The approximate index returns a fixed number of candidates and the `WHERE` clause filters them afterward. On pgvector 0.8 or later, turn on iterative scans with `SET hnsw.iterative_scan = relaxed_order`. Partial indexes or partitioning help for large, fixed segments.

### Does the official Postgres Docker image include pgvector?

No. Use the `pgvector/pgvector` images, an image that bundles many extensions, or build a small image that installs the `postgresql-<major>-pgvector` package on top of the official one.

### How many dimensions can pgvector index?

The `vector` type can index up to 2,000 dimensions, and `halfvec` up to 4,000. For larger embeddings, index a `halfvec` cast or reduce dimensions in the model if it supports it.

To try this on your own hardware, [install LogiStack](/#install), deploy the extensions template, and run your first similarity query in a few minutes.

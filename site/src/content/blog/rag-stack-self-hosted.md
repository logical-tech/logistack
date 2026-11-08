---
title: "A self-hosted RAG stack with Postgres, pgvector and Ollama"
description: "Build a self-hosted RAG stack on your own servers: Postgres with pgvector, a local embedding model, an open LLM, ingestion, hybrid search and deployment."
date: 2026-11-08
category: AI
keywords: self-hosted rag stack, rag with pgvector, self-hosted rag, local rag pipeline, postgres vector search, rag ollama
---

You want a chatbot that answers from your own documents: the handbook, the support tickets, the contracts. You also do not want those documents, or the questions people ask about them, sent to a third-party API. A self-hosted RAG stack solves that with four parts you can run on one server: Postgres with pgvector to store and search chunks, an embedding model to turn text into vectors, an LLM to write the answer, and a small app that glues them together. This guide builds each part, with SQL and Python you can run, and shows how to deploy it.

## The parts of a self-hosted RAG stack

Retrieval-augmented generation is two pipelines that share a database.

| Part | Job | Self-hosted choice in this guide |
| --- | --- | --- |
| Store | Keep chunks, their vectors and metadata; search them | Postgres with the pgvector extension |
| Embedding model | Turn text into a vector, for documents and questions | `nomic-embed-text` served by Ollama |
| LLM | Read the retrieved chunks and write the answer | An 8B instruct model on Ollama, or vLLM on a GPU |
| Ingestion | Parse, chunk, embed and upsert documents | A Python worker or scheduled job |
| Query app | Embed the question, retrieve, build the prompt, call the LLM | A small API |

Everything runs on your servers. The only network calls leave your private network when you choose to make them.

## Why Postgres and pgvector

Dedicated vector databases such as Qdrant, Weaviate and Chroma are good products. For most RAG stacks, Postgres is still the better first choice:

- **One database.** Your chunks sit next to users, tenants and permissions. A query can filter by `tenant_id` or document access in the same SQL statement as the vector search.
- **Transactions.** Replacing a document's chunks is one transaction. Readers never see half an update.
- **Hybrid search for free.** Postgres full-text search runs beside vector search in one query.
- **Tooling you already have.** Backups, replicas, migrations and monitoring work as they do for any Postgres database.

A dedicated engine starts to pay off at tens of millions of vectors, with very high query rates, or when you need features such as built-in multi-vector search. Our [pgvector guide](/blog/pgvector/) covers index types, tuning and that threshold in depth, so this post stays on the full stack.

## Pick an embedding model

The embedding model decides retrieval quality more than any other choice. Things to weigh:

- **Language.** English-only models are smaller. For mixed languages, use a multilingual model such as `bge-m3`.
- **Dimensions.** More dimensions mean more storage and slightly slower search. 768 to 1024 is a sensible range.
- **Context length.** The model truncates long inputs, so your chunks must fit.
- **Speed on your hardware.** Embedding models are small. A CPU embeds thousands of chunks per hour, which is enough for most document sets.

Serve the model with Ollama, which already runs on your box for the LLM:

```bash
docker exec ollama ollama pull nomic-embed-text
curl http://127.0.0.1:11434/api/embed \
  -d '{"model":"nomic-embed-text","input":["search_query: How many vacation days do I get?"]}'
```

`nomic-embed-text` returns 768 dimensions and expects a task prefix: `search_document: ` for chunks and `search_query: ` for questions. Other models have their own conventions; read the model card.

Once you choose a model, keep it. Vectors from different models are not comparable, so a switch means re-embedding everything.

## Pick the LLM

The generator reads maybe 3,000 to 6,000 tokens of retrieved context and writes a short answer. An 8B instruct model handles that well on a CPU server for a small team, and a GPU makes it fast. For many concurrent users, serve it with a batching server. Our [vLLM vs Ollama comparison](/blog/vllm-vs-ollama/) helps you choose, and our guide to deploying AI models covers memory sizing.

## The schema

```sql
create extension if not exists vector;

create table documents (
  id         text primary key,
  tenant_id  text not null,
  title      text not null,
  source_url text,
  updated_at timestamptz not null default now()
);

create table chunks (
  id           bigserial primary key,
  document_id  text not null references documents(id) on delete cascade,
  tenant_id    text not null,
  ordinal      int  not null,
  content      text not null,
  embedding    vector(768) not null,
  tsv          tsvector generated always as (to_tsvector('english', content)) stored
);

create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_tenant_idx on chunks (tenant_id);
```

The `tenant_id` column on each chunk is the point: permission checks happen in the database, before anything reaches the model. An answer can never quote a document the user could not open.

## Ingestion: parse, chunk, embed, upsert

Ingestion is a batch job. Run it as a worker on a queue when documents arrive, or on a schedule for a nightly sync.

```python title="ingest.py"
import os, httpx, psycopg
from pgvector.psycopg import register_vector

OLLAMA = os.environ.get("OLLAMA_URL", "http://ollama:11434")

def chunk(text: str, size: int = 1200, overlap: int = 200) -> list[str]:
    # Split on paragraphs, then pack paragraphs into chunks of about `size` characters.
    parts, out, buf = text.split("\n\n"), [], ""
    for p in parts:
        if len(buf) + len(p) > size and buf:
            out.append(buf.strip())
            buf = buf[-overlap:]
        buf += "\n\n" + p
    if buf.strip():
        out.append(buf.strip())
    return out

def embed(texts: list[str]) -> list[list[float]]:
    r = httpx.post(f"{OLLAMA}/api/embed", timeout=300,
                   json={"model": "nomic-embed-text",
                         "input": [f"search_document: {t}" for t in texts]})
    r.raise_for_status()
    return r.json()["embeddings"]

def ingest(doc_id: str, tenant_id: str, title: str, text: str) -> None:
    pieces = chunk(text)
    vectors = embed(pieces)
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        register_vector(conn)
        with conn.transaction():
            conn.execute(
                """insert into documents (id, tenant_id, title) values (%s, %s, %s)
                   on conflict (id) do update set title = excluded.title, updated_at = now()""",
                (doc_id, tenant_id, title))
            conn.execute("delete from chunks where document_id = %s", (doc_id,))
            for i, (content, vec) in enumerate(zip(pieces, vectors)):
                conn.execute(
                    """insert into chunks (document_id, tenant_id, ordinal, content, embedding)
                       values (%s, %s, %s, %s, %s)""",
                    (doc_id, tenant_id, i, content, vec))
```

Practical rules for chunking:

- **Respect structure.** Split on headings and paragraphs before characters. A chunk that starts mid-sentence retrieves badly.
- **Keep titles.** Prepend the document title and section heading to each chunk's text. It helps both search and the model's answer.
- **Batch embeddings.** Send dozens of chunks per request, not one.
- **Replace, do not append.** When a document changes, delete its chunks and insert new ones in one transaction, as above.

For PDFs and office files, extract text with a parser such as `pypdf`, Unstructured or Apache Tika before chunking.

## Retrieval: hybrid search in one query

Vector search finds paraphrases. Keyword search finds exact terms, such as error codes and product names, that embeddings blur. Combine them with reciprocal rank fusion:

```sql
with semantic as (
  select id, row_number() over (order by embedding <=> %(qvec)s) as rank
  from chunks
  where tenant_id = %(tenant)s
  order by embedding <=> %(qvec)s
  limit 20
),
keyword as (
  select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as rank
  from chunks, websearch_to_tsquery('english', %(qtext)s) q
  where tenant_id = %(tenant)s and tsv @@ q
  order by ts_rank_cd(tsv, q) desc
  limit 20
)
select c.document_id, c.content,
       coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as score
from semantic s
full outer join keyword k on s.id = k.id
join chunks c on c.id = coalesce(s.id, k.id)
order by score desc
limit 6;
```

Six chunks of about 1,200 characters each leave plenty of room in an 8B model's context for instructions and the answer.

## Generation: answer with sources

```python title="ask.py"
from ingest import OLLAMA, httpx

def ask(question: str, tenant_id: str) -> str:
    qvec = httpx.post(f"{OLLAMA}/api/embed", timeout=60,
                      json={"model": "nomic-embed-text",
                            "input": [f"search_query: {question}"]}).json()["embeddings"][0]
    rows = search(qvec, question, tenant_id)  # runs the SQL above
    context = "\n\n".join(f"[{i+1}] ({r[0]}) {r[1]}" for i, r in enumerate(rows))
    prompt = (
        "Answer the question using only the sources below. Cite sources as [n]. "
        "If the sources do not contain the answer, say you don't know.\n\n"
        f"Sources:\n{context}\n\nQuestion: {question}"
    )
    r = httpx.post(f"{OLLAMA}/api/chat", timeout=180, json={
        "model": "llama3.1:8b", "stream": False,
        "messages": [{"role": "user", "content": prompt}]})
    return r.json()["message"]["content"]
```

The instruction to say "I don't know" matters as much as the retrieval. Without it, a model fills gaps with plausible inventions.

## Measure before you tune

Write 30 to 50 real questions with the document that should answer each. Then measure:

- **Retrieval hit rate.** Is the right document in the top 6? If not, fix chunking, the embedding model or hybrid weights before touching the prompt.
- **Answer quality.** Read the answers. Check citations point at the right chunk.

Re-run the set after every change. Without it, you tune by anecdote.

## Deploying the RAG stack with LogiStack

LogiStack is an open-source self-hosted PaaS on Docker Swarm. The stack above maps to a handful of services in one project:

- **Postgres with pgvector.** LogiStack's managed Postgres runs the official `postgres` image, which does not include pgvector. Use the [PostgreSQL with 80+ Extensions](/templates/postgres-extensor/) template instead: PostgreSQL 18 with pgvector, `pg_cron` and other extensions preinstalled, with its data in a volume.
- **Ollama.** The [Ollama with Open WebUI](/templates/ollama-with-open-webui/) template keeps the Ollama API internal, so only services in the same environment reach it, and gives you a chat UI for testing models.
- **Your query API** from Git, built from a Dockerfile, with a domain and HTTPS. See [deploy from Git](/docs/deploy/from-git/).
- **Ingestion** as a worker service with no domain, or as a [schedule](/docs/data/schedules/) that runs inside the API service with its environment, for a nightly sync.
- **Backups** of the database volume on a cron, encrypted and sent to any S3 destination. See [backups](/docs/data/backups/).
- **Private access.** Keep the internal UI on your tailnet, or put an IP allow list or a sign-in gateway in front of the domain at the proxy.

The constraint to know: service settings cover CPU and memory, not GPUs. A CPU server runs embeddings and an 8B model fine for a team. For GPU generation, run the LLM elsewhere and point the API at it.

If you would rather not write the app, AnythingLLM and Open WebUI both ship document chat with their own retrieval, deployable from the same catalog.

## FAQ

### Do I need a vector database for RAG?

No. Postgres with pgvector stores and searches vectors well into the millions of chunks, with filtering, transactions and backups you already know. Move to a dedicated vector database when scale or specific features demand it, not by default.

### Can a self-hosted RAG stack run without a GPU?

Yes. Embedding models are small and run well on CPUs, and an 8B quantized LLM answers on a modern CPU at a speed acceptable for internal use. Add a GPU when many people query at once or you want a larger model.

### Which embedding model should I use?

Start with a well-known open model that fits your languages, such as `nomic-embed-text` for English or `bge-m3` for multilingual content, and measure retrieval on your own questions. Changing models later means re-embedding every chunk.

### How big should chunks be?

A few hundred to about 1,000 tokens, split on paragraphs and headings, with a small overlap. Smaller chunks retrieve more precisely; larger ones carry more context. Test both against your question set.

### How do I keep users from seeing documents they should not?

Store the permission key, such as a tenant or group id, on every chunk and filter on it in the retrieval SQL. The model never sees text the user could not open, so it cannot leak it.

A private RAG stack is a database, two models and a small app, and all of it fits on a server you own. [Install LogiStack](/#install), deploy the pgvector template and Ollama, and ship the API from Git.

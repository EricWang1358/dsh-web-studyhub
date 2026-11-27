# Scoped hybrid retrieval

## Run

From `packages/studyhub-spring`, use Node 22+ and JDK 21.

```sh
node studyhub-retrieval/fetch-model.mjs studyhub-retrieval/target/model
mvn -pl studyhub-retrieval test "-Dstudyhub.real-model=true"
mvn -pl studyhub-contract-tests -am test "-Dstudyhub.real-model=true"
```

Start the Spring gateway with `--studyhub.retrieval.model-dir=<absolute model directory>` to enable these endpoints. The gateway verifies both files before initializing a local inference session. The model and tokenizer together occupy 135,391,039 bytes. The track builds and starts without downloading weights when retrieval is unused. The pinned distributions are listed in [model.properties](src/main/resources/io/studyhub/retrieval/model.properties). The encoder uses the model's tokenizer, attention-mask mean pooling and L2 normalization over up to 128 tokens. The full submitted page is indexed for BM25. [Model and usage](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)

| Method and path | Parameters | Result |
| --- | --- | --- |
| `PUT /api/retrieval/source` | Query parameters `libraryId`, `courseId`, `sourceId`. Body is UTF-8 `text/plain`. | `{"changed":true}` for a new or updated page. An identical page returns `false`. |
| `GET /api/retrieval/search` | `libraryId`, `courseId`, `query` and optional `limit` from 1 to 100. | Ranked objects with `sourceId`, `text`, fused `score`, `lexicalRank` and `vectorRank`. |
| `DELETE /api/retrieval/source` | `libraryId`, `courseId`, `sourceId`. | `{"deleted":true}` if a page was present. Concurrent, superseded indexing returns HTTP 409. |

Send the gateway's `X-Study-Token` header on each request and URL-encode each parameter. `studyhub.retrieval.max-page-bytes` defaults to 262144. The endpoint checks both declared length and bytes actually received. Search accepts up to 2048 UTF-16 code units. `studyhub.retrieval.max-concurrent` bounds concurrent indexing and search requests. `studyhub.retrieval.inference-threads` sets ONNX CPU threads per session. Both default to 2. Busy workers return HTTP 429. The API stores the derived SQLite database under the platform data directory at `retrieval/pages.sqlite`.

## Index behavior

FTS5 stores normalized words plus unigrams and adjacent bigrams for unspaced CJK text. SQL applies the library and course predicates before the lexical top-k limit. A scope's HNSW graph is constructed exclusively from rows for that library, course and model fingerprint. Updates atomically commit the text, FTS posting, vector and revision to SQLite. A source version prevents a slow embedding from resurrecting a concurrently deleted page. Each query uses one committed snapshot while fusing the two rankings with reciprocal rank fusion (`1 / (60 + rank)`). A source ID resolves within its own scope.

The process retains the four most recently queried scope graphs. The first query after a restart, eviction, or change to that scope rebuilds its graph from persisted vectors. This rebuild and warm-query latency are measured separately. The Java packages for ONNX Runtime 1.20.0 and DJL tokenizers 0.40.0 contain binaries for Linux x86-64/AArch64 and Windows x86-64. A Windows ARM-native JVM requires separately built JNI binaries. The SQLite database stores portable little-endian float vectors.

Real inference and SQLite isolation tests ran on Windows 11 x86-64 with Oracle JDK 21.0.4 and Ubuntu 22.04 x86-64 under WSL with Temurin 21.0.13.1. The Windows gateway contract suite also indexed a Chinese page and retrieved it using an English query over authenticated HTTP, checked foreign-library isolation and deleted the page.

The final desktop JAR also ran offline in an emulated Linux ARM64 Ubuntu container using an AArch64 Temurin 21.0.13+9 JVM. The 384-dimensional English embedding had cosine similarity 0.96759 to its Chinese translation and 0.01431 to an unrelated passage. The English query ranked the Chinese passage first without a lexical match and excluded an exact match in another course. After reopening SQLite, the expected Chinese passage ranked first in both FTS5 and HNSW. The x86-64 Docker host supplied ARM64 emulation. The latency measurements below are from Windows x86-64.

## Reproduce the benchmark

```sh
mvn -pl studyhub-retrieval test "-Dstudyhub.real-model=true" "-Dstudyhub.benchmark=true" "-Dstudyhub.benchmark.pages=10000"
```

The benchmark loads all non-merged entries (58 currently; 57 in the 2026-11-26 run below) from the repository's agent-lessons taxonomy. It adds actual Markdown passages from the repository to reach 1,000 and 10,000 entries in one course. Twelve hand-labeled Chinese and English questions each have one designated taxonomy entry. Recall@10 counts queries that return that entry, and MRR@10 weights its position. Other relevant passages receive no credit under this known-item criterion. The BM25 control searches the same FTS5 postings. Warm p95 includes tokenization, local inference, both searches, fusion and reading the resulting text. It uses 36 requests per size. The first-query measurement includes constructing a fresh graph.

## Windows measurement

The 2026-11-26 run used Windows 11 x86-64, Ryzen 9 7945HX, Oracle JDK 21.0.4 and CPU inference with two intra-op threads. RSS is the full benchmark JVM working set sampled after each query series using JFR's `jdk.ResidentSetSize`. Indexing time includes all committed page embeddings and postings up to the indicated size. Each HNSW graph first builds on demand.

| Passages | BM25 Recall@10 | BM25 MRR@10 | Hybrid Recall@10 | Hybrid MRR@10 | Warm p95 | First query | Indexing | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 57 | 0.5833 | 0.5167 | 1.0000 | 0.7167 | 10.72 ms | 0.26 s | 1.94 s | 751.7 MiB |
| 1,000 | 0.4167 | 0.2639 | 0.7500 | 0.3497 | 12.95 ms | 0.70 s | 16.61 s | 843.4 MiB |
| 10,000 | 0.2500 | 0.2083 | 0.2500 | 0.2500 | 75.68 ms | 21.39 s | 171.63 s | 1,349.1 MiB |

At 10,000 passages BM25 and hybrid each recovered 3 of 12 designated entries. Hybrid placed all three first. The 21.39-second first query includes reconstructing the course's HNSW graph from its SQLite vectors. The measurements describe repository passages and these twelve questions.

## Implementation receipt

WP-S4 reads the existing Node isolation cases in `tests/retrieval-library-isolation.test.mjs`. Documents belong to a library, course and source together. The search index is derived data. Reindexing and deletion target an exact key, and the source library remains the owner of each page. Tests exercise colliding IDs and text across both scope coordinates (C18/C20/C22/C51/C58).

FTS terms and persisted vectors originate from the same page revision. Before computing a new embedding the index checks the text and model identity. Closures must release JDBC, tokenizer and inference resources. The model download is explicit, versioned, time-bounded and verified before use. The benchmark separates first-index cost from repeated searches (C13/C19/C28/C32/C33/C35/C48).

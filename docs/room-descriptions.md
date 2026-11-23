# Geographic room description database

## Municipal lookup

The current artifact is `artifacts/room-descriptions/geochalk-gazetteer-v1-20261123-municipal.sqlite`. At five characters, a containing municipality is selected using the requested room center. This build adds California incorporated-place boundaries from the U.S. Census Bureau, so `9q8yy` resolves to San Francisco. Areas without a containing municipality still fall back to a parent anchor.

## Precision-7 build baseline

The original precision-7 artifact occupies **76,038,144 bytes (72.52 MiB)**, retains **1,082,400 precomputed anchors**, and took **140 seconds** to build from normalized inputs. Its local index contains 178,954 point entries and 79 polygon components from 41 [DataSF Analysis Neighborhoods](https://data.sf.gov/d/p5b7-5n3h). Seven-character rooms resolve on demand from the local index and eight-character rooms inherit that name. The [regeneration instructions](../packages/room-descriptions/README.md) cover additional neighborhood and city boundaries.

## November 21 baseline

Rebuilt locally on 2026-11-21 from the cached GeoNames, OSMNames and Natural Earth source snapshots downloaded on 2026-11-16. The complete [Python implementation and regeneration instructions](../packages/room-descriptions/README.md) are in `packages/room-descriptions`. The Node API now serves a read-only geoname lookup for room headings. CDK includes the local SQLite artifact in the Lambda bundle when it is present during synthesis.

## Artifact

`artifacts/room-descriptions/geochalk-gazetteer-v1-20261121.sqlite` is the read-only runtime database. Generated data is ignored by Git.

- Named places: **1,000,000**, selected from **1,316,867** canonical records after deduplication.
- Anchors: **1,082,400**, exactly 32 + 1,024 + 32,768 + 1,048,576. No initial level-5 entries.
- SQLite size: **60,313,600 bytes**, or **60.31 MB / 57.52 MiB**.
- Generation time from normalized inputs: **113.94 seconds**, including staging, deduplication, selection, indexing, ANALYZE, VACUUM and integrity/coverage checks. Downloads and normalization are additional.
- SHA-256: `10ad7e9f093b84d90ec478c328e2ea6ff0b214619944b30cbbb39fe5640e665e`.

## Lookup benchmark

10,000 deterministic random precision-5 requests, including recursive level-4 lookup. Times include input validation. These are local machine measurements, not Lambda latency guarantees.

| Operation                                      |     Median |        p95 |
| ---------------------------------------------- | ---------: | ---------: |
| LRU disabled, reused connection                |  19.417 μs |  26.541 μs |
| Warm LRU, reused connection                    |   2.042 μs |   2.333 μs |
| Open connection + lookup + close (100 samples) | 165.980 μs | 366.292 μs |

The OS page cache was not flushed. Fresh-connection measurements represent application-cold lookups, **not physical cold-disk reads**. Runtime does not import build dependencies or make network calls.

Environment: numpy 2.5.5, python 3.13.18, scipy 1.18.1, shapely 2.2.0, sqlite 3.54.1. Build versions are pinned in `requirements-build.lock` and recorded inside SQLite metadata.

## Actual sample descriptions

These are generated from the requested room geometry; they are not copied from the illustrative requirements. All entries below use precision 5 with its parent anchor. The parent can name a different nearby town rather than the exact city/neighborhood requested.

| Sample location  | Generated description                         |
| ---------------- | --------------------------------------------- |
| San Francisco    | 7.3 square miles northeast of Daly City       |
| Outer Richmond   | 7.3 square miles northwest of Daly City       |
| New York         | 7 square miles around New York City           |
| London           | 5.7 square miles southeast of Finchley        |
| Tokyo            | 7.5 square miles northwest of Shinagawa       |
| Rural California | 7.3 square miles around Bishop                |
| Sahara           | 8.4 square miles north of Jabal Bin Ghunaymah |
| Pacific          | 9.2 square miles northeast of Polynesia       |
| Dateline east    | 9.2 square miles southwest of Pacific Ocean   |
| Dateline west    | 9.2 square miles west of Pacific Ocean        |
| High north       | 0.16 square miles north of Arctic Ocean       |
| High south       | 0.16 square miles south of West Antarctica    |

## Validation and limitations

- All 20 unit/integration tests passed, including two identical full-coverage synthetic builds producing identical SQLite bytes, an optional exact level-5 build, read-only enforcement, fallback, thread reuse, indexed SQL, no-network operation, source ingestion and geometry.
- Full real database integrity and reference checks passed. Complete unique key intervals prove every level-1–4 room exists; every one of the 33,554,432 level-5 prefixes therefore has an existing parent. The validator also checked 10,000 sampled lookups and global named scenarios.
- Both SQL joins use `INTEGER PRIMARY KEY` lookup. The published database contains no build spatial indexes or source provenance payloads.
- OSM source: **OSMNames v2.0.4, an older snapshot**, filtered to the six requested settlement/neighborhood types. This should be refreshed with current OSM PBF/JSONL before relying on current neighborhood coverage. GeoNames cities1000 and Natural Earth v5.1.2 are also included; exact source digests are in the manifest.
- Geographic deduplication and bounded nearest-candidate ranking are heuristics. Generalized regional boundaries improve coarse anchors, but runtime point-only records never assert `in`. Population/type are build-only; runtime Place returns `population=None`, `kind="unknown"` per the compact schema.
- The public `GET /api/rooms/:prefix/geoname` route returns the read-only gazetteer anchor and falls back to shorter prefixes when needed. Room prefixes longer than four characters currently use their precision-4 parent anchor because the initial database precomputes levels 1–4 only. The Python package separately supports optional exact precision-5 anchors.
- Production Lambda packaging includes the SQLite file when it exists locally during CDK synthesis. Generated databases remain ignored by Git, so a deploy from another machine must provide the database artifact before synthesis.

# Geographic room descriptions

A Python offline builder and a standard-library-only, read-only runtime. The existing TypeScript/Lambda application is not changed by installing this package.

```python
from geochalk_geo import configure, get_geoname, get_room_description

configure("/data/geochalk-gazetteer-v1-20261116.sqlite", cache_size=100_000)
place = get_geoname("9q8yy")
print(place.name, place.latitude, place.longitude, place.importance)
print(get_room_description("9q8yy"))
print(get_room_description("9q8yy", "meters"))
```

Alternatively set `GEOCHALK_GAZETTEER` to the database path, or use an explicit `Gazetteer(path)` context manager. Only lowercase geohashes of length 1–5 are accepted; `_`, uppercase letters, and precision 6+ are rejected. Units are exactly `miles` or `meters` (not `kilometers`).

## Install and test

Requires Python 3.11+. Build dependencies are NumPy, SciPy and Shapely; none are imported by the runtime.

```sh
python3.13 -m venv packages/room-descriptions/.venv
. packages/room-descriptions/.venv/bin/activate
pip install -e 'packages/room-descriptions[build]'
python -m unittest discover -s packages/room-descriptions/tests -v
```

The tests build a complete 1,082,400-anchor synthetic database, check byte-for-byte reproducibility, read-only failures, integer-primary-key query plans, recursive fallback, exact level-5 overrides, cache equality, threads, no-network operation, geometry, ingestion and spatial deduplication. They do not require downloading sources or AWS credentials.

## First run: synthetic end-to-end build

```sh
mkdir -p artifacts/room-descriptions
geochalk-geo-build packages/room-descriptions/fixtures/synthetic.jsonl \
  --output artifacts/room-descriptions/synthetic-v1.sqlite \
  --build-date 2026-11-16T00:00:00Z
geochalk-geo-validate artifacts/room-descriptions/synthetic-v1.sqlite \
  --output artifacts/room-descriptions/synthetic-v1.validation.json
```

Outputs must not already exist. Builds publish only after integrity and coverage checks; failed work files remain for diagnosis. Use a new output filename to retry or explicitly remove your failed generated work files. Raw downloads and all databases are ignored by Git.

## Real sources and regeneration

The supplied downloader fetches:

- [GeoNames cities1000](https://download.geonames.org/export/dump/): populated places, population and feature codes. It is a rolling dump; retain its exact downloaded bytes/checksum for reproducibility. Attribution: GeoNames, CC BY 4.0.
- [OSMNames v2.0.4](https://osmnames.org/download/): a 1.44 GB compressed, older global OSM-derived snapshot, filtered to `city`, `town`, `village`, `suburb`, `quarter`, `neighbourhood`. Includes place nodes, ways and relations with representative coordinates. This is **not current OSM**. Attribute OpenStreetMap contributors and OSMNames; the derived database is distributed under ODbL.
- [Natural Earth v5.1.2](https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2): countries at 1:110m, states/provinces, geographic regions and marine polygons at 1:10m. Public domain. These are generalized geographic features, not authoritative legal boundaries.

```sh
python packages/room-descriptions/scripts/download_sources.py artifacts/room-descriptions/sources
geochalk-geo-normalize geonames artifacts/room-descriptions/sources/cities1000.zip \
  --output artifacts/room-descriptions/geonames.jsonl
geochalk-geo-normalize osmnames artifacts/room-descriptions/sources/osmnames-v2.0.4.tsv.gz \
  --output artifacts/room-descriptions/osm.jsonl
geochalk-geo-normalize natural-earth artifacts/room-descriptions/sources/countries.geojson \
  --region-kind country --output artifacts/room-descriptions/countries.jsonl
geochalk-geo-normalize natural-earth artifacts/room-descriptions/sources/states.geojson \
  --region-kind state --output artifacts/room-descriptions/states.jsonl
geochalk-geo-normalize natural-earth artifacts/room-descriptions/sources/regions.geojson \
  --region-kind region --output artifacts/room-descriptions/regions.jsonl
geochalk-geo-normalize natural-earth artifacts/room-descriptions/sources/oceans.geojson \
  --region-kind ocean --output artifacts/room-descriptions/oceans.jsonl

geochalk-geo-build \
  artifacts/room-descriptions/geonames.jsonl \
  artifacts/room-descriptions/osm.jsonl \
  artifacts/room-descriptions/countries.jsonl \
  artifacts/room-descriptions/states.jsonl \
  artifacts/room-descriptions/regions.jsonl \
  artifacts/room-descriptions/oceans.jsonl \
  --source-manifest artifacts/room-descriptions/sources/sources.json \
  --build-date 2026-11-16T00:00:00Z \
  --output artifacts/room-descriptions/geochalk-gazetteer-v1-20261116.sqlite

geochalk-geo-validate artifacts/room-descriptions/geochalk-gazetteer-v1-20261116.sqlite \
  --samples 10000 --output artifacts/room-descriptions/geochalk-gazetteer-v1-20261116.validation.json
```

Normalization streams the OSMNames gzip without expanding the multi-GB TSV onto disk. Streets are rejected before parsing their sometimes very large address fields. Empty or symbol-only names are counted and rejected. All other malformed records fail the import. Normalized JSONL publishes atomically; a `.partial` file is never accepted as a finished output. Download manifests record URLs, versions, sizes, SHA-256 and retrieval date. Natural Earth sometimes repeats IDs across features; normalization retains both the original `ne_id` and a dataset/ID/component identifier.

### Current OSM alternatives

For a newer snapshot, process local OSM PBF files or exported JSONL instead of OSMNames. Do not run a million-place query against a public interactive Overpass instance.

```sh
pip install -e 'packages/room-descriptions[pbf]'
geochalk-geo-normalize pbf /data/places.osm.pbf --output /data/osm-current.jsonl
```

The streaming PBF adapter reads **place nodes only**, so it does not allocate a planet-sized node-location cache. To include area-only places, use the provided OSMNames importer or `osm-jsonl` with ways/relations and a representative `center`. The JSONL adapter accepts Overpass-style records (`id`, `type`, `tags`, `lat`/`lon` or `center`) and Geoapify locality records (`osm_id`, `osm_type`, `location: [lon, lat]`). Keep the input's timestamp and license in the source manifest. Regional snapshots are useful for tests but do not provide global coverage by themselves.

### Normalized records and provenance

Each JSONL record contains `source`, `source_id`, `name`, `latitude`, `longitude`, `kind`, optional `population`, `prominence` in [0,1], and optional GeoJSON polygon geometry. Additional aliases, original IDs, feature codes and source dates survive in the build database's `raw.body`.

Stable normalization uses Unicode NFKD, case folding and alphanumeric names. Deduplication merges equal normalized names within 2 km for settlements and 0.5 km for neighborhoods; incompatible feature families and distant namesakes remain separate. Distances wrap at the dateline. GeoNames is processed before OSM, then source IDs establish a deterministic order; merged importance/population take the maximum. This is deliberately conservative: alternate spellings beyond accent/case/punctuation differences can remain separate. It does not equate all places named Springfield.

`*.build.sqlite` retains raw source records, canonical population/type, spatial build data, many-to-one provenance links and the IDs selected for publication. It is not a runtime dependency. The runtime `Place` dataclass exposes the requested fields, but `population=None` and `kind="unknown"` because the specified compact runtime schema omits those build-only attributes. Name, coordinates, importance and ID come from SQLite.

The default cap is 1,000,000 places. Keep all regional supplements, then choose settlements in rounds across precision-3 geographic buckets, ordered by importance and stable ID within each bucket. If fewer genuine unique places are supplied, publish that actual count and report it—never duplicate or fabricate places to reach a quota.

## Selection and geometry

The build constructs per-level SciPy KD-trees on 3D unit-sphere vectors. Chord distance is monotonic with great-circle distance, so antimeridian and polar neighbors work without geohash-prefix assumptions. Select up to the 32 nearest eligible candidates and minimize:

```text
(distance_km / sqrt(cell_area_km2)) + 0.25 * (1 - importance)
```

Importance is a configurable weighted combination of log population, type and prominence metadata. Distance remains the primary term. This is an explicitly bounded candidate heuristic, not a claim of a global optimum over every place's importance score. Equal scores break on stable place ID. Trees use one worker and sorted input for deterministic results.

Type pools favor regions/countries/oceans at levels 1–2, cities/metropolitan places at 3, cities/towns and villages with known population >=1,000 at 4, and neighborhoods/suburbs/villages/towns at 5. If no eligible place type exists, the builder falls back to the available settlement pool. For remote cells beyond `max(100 km, 3 * cell scale)` from an eligible settlement, select a regional/ocean anchor. Regional polygon containment uses an STRtree; at coarse levels extent size is matched to cell scale, with point-distance fallback when no boundary covers the center. Generalized extents improve anchor selection but are not used to assert legal containment.

Use `--config path.json` to override `BuildConfig` fields: `target_places`, `candidates`, `importance_weight`, population/type/prominence weights, `type_scores`, dedup radii and remote thresholds. Source manifests and full configuration are recorded in metadata.

Cell area uses exactly the specified sphere with radius **6,371,008.8 m**, integrating sine latitude between geohash parallels. It does not use planar width-times-height or a constant area per precision. Miles means square miles. Meters means square meters below 1,000,000 m², otherwise square kilometers. Formatting rounds half-up to roughly two significant digits and never displays zero for a positive cell area.

Bearing is from the selected place to the **requested** room center, not its fallback parent's center. `around` means the point is in the cell or within 10% of its linear scale; `near` covers nearby points or unstable polar/antipodal bearings; other cases use eight compass directions. The runtime never says `in`, because its compact point-only tables cannot prove boundary containment. Large region labels still have representative-point relationship limitations.

## SQLite and precision-5 behavior

Runtime content is the specified `places` and `room_anchors` tables, plus a small `metadata` table and SQLite's `ANALYZE` statistics. No spatial index, source records, geometry or formatted text ships in the runtime database. Both runtime IDs use `INTEGER PRIMARY KEY`.

Geohash keys use a sentinel bit: start at integer 1 and shift left five bits for each geohash character, adding the character value. Thus `0` is 32 and `00` is 1,024; leading zeros and differing lengths never collide. Each precision occupies a separate contiguous key interval.

The initial build has exactly **1,082,400 anchors** for levels 1–4 and no level-5 anchors. Every valid level-5 prefix therefore resolves through its populated level-4 parent. That parent anchor **is not necessarily the nearest place** to the level-5 room. Exact lookup is attempted before recursive fallback and results are held in a bounded LRU (default 100,000 entries). Future offline builds can add `--exact-prefix 9q8yy` (repeatable) to select and persist selected level-5 anchors using the local-type spatial tree. Runtime requests never write them.

`ANALYZE`, `VACUUM`, `integrity_check`, foreign-key checks and complete per-level counts run before publication. A count equal to the size of each key interval, combined with unique integer keys and verified referenced places, proves coverage for every level-1–4 prefix and consequently every level-5 parent fallback. Validators also sample globally and verify query plans use primary-key lookups.

Reproducibility requires identical source bytes, normalized inputs, configuration, explicit build date, Python/SQLite and scientific-library versions. The SQLite artifact is deterministic under that environment; timing metrics in the external manifest are naturally not. No current wall-clock timestamp is injected into the database.

## Runtime concurrency and deployment

One `Gazetteer` shares a read-only SQLite connection serialized by an RLock; the LRU uses the same lock. It is safe for threads, with one process-level instance. For higher parallelism, instantiate one per worker process. Do not reuse a connection inherited through fork; the runtime detects it. Configure during worker startup, and close at shutdown. Database access uses `mode=ro` and `PRAGMA query_only=ON`; missing paths fail instead of creating an empty database. Runtime has no network implementation or build dependency.

For AWS Lambda, the straightforward deployment is a Python container image containing the finished SQLite file and the runtime package. Create the `Gazetteer` once at module initialization, then reuse it across invocations. The repository's current chat Lambda is Node.js; this package does not silently replace it or add a subprocess/network call to room reads. Integration needs a separate decision about a Python service or a corresponding Node SQLite reader.

AWS currently allows a **250 MB uncompressed ZIP including layers**, versus **10 GB uncompressed for a container image**. A 60–120 MB database may fit in a ZIP with a small runtime, but the whole deployment must be measured; do not assume every ZIP/layer composition fits. An EFS mount with read-only IAM/POSIX permissions is another option, with VPC/network setup and network-file read latency to measure. Never mutate a mounted live artifact: publish a new version and deploy a new path. Packaging the DB inside an image avoids runtime source/API/network downloads. Sources: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [filesystem access](https://docs.aws.amazon.com/lambda/latest/dg/configuration-filesystem.html).

## Artifacts, licensing and measurements

Publish the versioned `.sqlite`, `.manifest.json`, validation results, source manifest and `ATTRIBUTION.md` together. Keep raw inputs and `.build.sqlite` separately for regeneration/audits. Do not add the databases or source dumps to Git. A versioned object-store key or container image digest should be immutable; verify the manifest SHA-256 when installing. No production AWS resources are modified by these scripts.

See [measured results](../../docs/room-descriptions.md) for the real build count, size and timings. Latencies distinguish uncached LRU queries, warmed LRU queries and opening a fresh connection. The operating-system page cache is not flushed, so fresh-connection timings are not presented as physical cold-disk latency.

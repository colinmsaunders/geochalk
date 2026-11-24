# Geographic room descriptions

A Python offline builder and read-only Python runtime. The generated SQLite file is also read by GeoChalk's Node API through Node's built-in SQLite support; the Lambda bundle includes the database when the local artifact exists during synthesis.

```python
from geochalk_geo import configure, get_geoname, get_room_description

configure("/data/geochalk-gazetteer-v1-20261123-municipal.sqlite", cache_size=100_000)
place = get_geoname("9q8yy")
print(place.name, place.latitude, place.longitude, place.importance)
print(get_room_description("9q8yy"))
print(get_room_description("9q8yy", "meters"))
```

Alternatively set `GEOCHALK_GAZETTEER` to the database path, or use an explicit `Gazetteer(path)` context manager. The runtime accepts lowercase geohashes of length 1–8. Units are exactly `miles` or `meters`.

At precision 5, the city or municipality containing the room center supplies the name. Rooms without a containing municipality still use their parent anchor. At precision 7, lookup uses the smallest containing neighborhood polygon, the nearest neighborhood point within 1 km, a containing city boundary, or the existing parent anchor, in that order. For point matches inside a known city, candidates outside that city are excluded. Precision 8 inherits the precision-7 name. An explicit stored anchor wins at its own precision. Older artifacts still resolve via parent anchors.

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
  --build-date 2026-11-21T00:00:00Z
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
curl -fL https://data.sf.gov/resource/j2bu-swwd.geojson \
  -o artifacts/room-descriptions/sources/datasf-neighborhoods.geojson
geochalk-geo-normalize place-boundaries \
  artifacts/room-descriptions/sources/datasf-neighborhoods.geojson \
  --boundary-source datasf-j2bu-swwd --name-field nhood \
  --output artifacts/room-descriptions/datasf-neighborhoods.jsonl
curl -fLG 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2026/MapServer/28/query' \
  --data-urlencode "where=STATE = '06'" --data-urlencode 'outFields=BASENAME,GEOID' \
  --data 'outSR=4326&f=geojson&geometryPrecision=5&maxAllowableOffset=0.0001' \
  -o artifacts/room-descriptions/sources/census-california-places.geojson
geochalk-geo-normalize place-boundaries \
  artifacts/room-descriptions/sources/census-california-places.geojson \
  --boundary-source us-census-tiger-2026-ca --boundary-kind city --name-field BASENAME \
  --output artifacts/room-descriptions/census-california-places.jsonl

geochalk-geo-build \
  artifacts/room-descriptions/geonames.jsonl \
  artifacts/room-descriptions/osm.jsonl \
  artifacts/room-descriptions/countries.jsonl \
  artifacts/room-descriptions/states.jsonl \
  artifacts/room-descriptions/regions.jsonl \
  artifacts/room-descriptions/oceans.jsonl \
  artifacts/room-descriptions/datasf-neighborhoods.jsonl \
  artifacts/room-descriptions/census-california-places.jsonl \
  --source-manifest artifacts/room-descriptions/sources/sources.json \
  --build-date 2026-11-23T00:00:00Z \
  --output artifacts/room-descriptions/geochalk-gazetteer-v1-20261123-municipal.sqlite

geochalk-geo-validate artifacts/room-descriptions/geochalk-gazetteer-v1-20261123-municipal.sqlite \
  --samples 10000 --output artifacts/room-descriptions/geochalk-gazetteer-v1-20261123-municipal.validation.json
```

Normalization streams the OSMNames gzip without expanding the multi-GB TSV onto disk. Streets are rejected before parsing their sometimes very large address fields. Empty or symbol-only names are counted and rejected. All other malformed records fail the import. Normalized JSONL publishes atomically; a `.partial` file is never accepted as a finished output. Download manifests record URLs, versions, sizes, SHA-256 and retrieval date. Natural Earth sometimes repeats IDs across features; normalization retains both the original `ne_id` and a dataset/ID/component identifier.

### Current OSM alternatives

The fine lookup uses [DataSF Analysis Neighborhoods](https://data.sf.gov/d/p5b7-5n3h) for San Francisco and place points for cities without neighborhood polygons. California municipal boundaries come from the [U.S. Census Bureau TIGERweb incorporated places layer](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2026/MapServer/28). To add city boundaries, normalize a WGS84 GeoJSON FeatureCollection with `place-boundaries --boundary-kind city --boundary-source <dataset-id>`. Use `--name-field` to select the feature property containing the name. Split polygons at the antimeridian before import.

For a newer snapshot, process local OSM PBF files or exported JSONL instead of OSMNames. Do not run a million-place query against a public interactive Overpass instance.

```sh
pip install -e 'packages/room-descriptions[pbf]'
geochalk-geo-normalize pbf /data/places.osm.pbf --output /data/osm-current.jsonl
```

The streaming PBF adapter reads **place nodes only**, so it does not allocate a planet-sized node-location cache. To include area-only places, use the provided OSMNames importer or `osm-jsonl` with ways/relations and a representative `center`. The JSONL adapter accepts Overpass-style records (`id`, `type`, `tags`, `lat`/`lon` or `center`) and Geoapify locality records (`osm_id`, `osm_type`, `location: [lon, lat]`). Keep the input's timestamp and license in the source manifest. Regional snapshots are useful for tests but do not provide global coverage by themselves.

### Normalized records and provenance

Each JSONL record contains `source`, `source_id`, `name`, `latitude`, `longitude`, `kind`, optional `population`, `prominence` in [0,1], and optional GeoJSON polygon geometry. Additional aliases, original IDs, feature codes and source dates survive in the build database's `raw.body`.

Stable normalization uses Unicode NFKD, case folding and alphanumeric names. Deduplication merges equal normalized names within 2 km for settlements and 0.5 km for neighborhoods; incompatible feature families and distant namesakes remain separate. Distances wrap at the dateline. GeoNames is processed before OSM, then source IDs establish a deterministic order; merged importance/population take the maximum. This is deliberately conservative: alternate spellings beyond accent/case/punctuation differences can remain separate. It does not equate all places named Springfield.

`*.build.sqlite` retains raw source records, canonical population/type, spatial build data, many-to-one provenance links and the IDs selected for publication. The published database provides names, coordinates, importance and IDs. Python also returns the kind for fine matches.

The default cap is 1,000,000 places. Keep all regional supplements, then choose settlements in rounds across precision-3 geographic buckets, ordered by importance and stable ID within each bucket. If fewer genuine unique places are supplied, publish that actual count and report it—never duplicate or fabricate places to reach a quota.

## Selection and geometry

The build constructs per-level SciPy KD-trees on 3D unit-sphere vectors. Chord distance is monotonic with great-circle distance, so antimeridian and polar neighbors work without geohash-prefix assumptions. Select up to the 32 nearest eligible candidates and minimize:

```text
(distance_km / sqrt(cell_area_km2)) + 0.25 * (1 - importance)
```

Importance is a configurable weighted combination of log population, type and prominence metadata. Distance remains the primary term. This is an explicitly bounded candidate heuristic, not a claim of a global optimum over every place's importance score. Equal scores break on stable place ID. Trees use one worker and sorted input for deterministic results.

Type pools favor regions/countries/oceans at levels 1–2, cities/metropolitan places at 3, cities/towns and villages with known population >=1,000 at 4, and neighborhoods/suburbs/villages/towns at 5. If no eligible place type exists, the builder falls back to the available settlement pool. For remote cells beyond `max(100 km, 3 * cell scale)` from an eligible settlement, select a regional/ocean anchor. Regional polygon containment uses an STRtree; at coarse levels extent size is matched to cell scale, with point-distance fallback when no boundary covers the center. Generalized extents improve anchor selection but are not used to assert legal containment.

Use `--config path.json` to override `BuildConfig` fields: `target_places`, `candidates`, `importance_weight`, population/type/prominence weights, `type_scores`, dedup radii and remote thresholds. Source manifests and full configuration are recorded in metadata.

Cell area integrates sine latitude between geohash parallels on a sphere with radius **6,371,008.8 m**. The default `unit="miles"` uses square feet below 1 square mile and square miles otherwise. Use `unit="meters"` for square meters below 1 square kilometer and square kilometers otherwise. Formatting rounds half-up to two significant digits.

For precomputed anchors, bearing is from the selected place to the **requested** room center. `around` means the point is in the cell or within 10% of its linear scale. `near` covers nearby points or unstable polar/antipodal bearings, and other cases use eight compass directions. Precision-7 descriptions say `in` for a polygon containing the room center and `near` for a nearby point.

## SQLite and precision

The published database contains `places`, `room_anchors`, `metadata`, and SQLite's `ANALYZE` statistics. The `fine_features` table stores local point references and polygon components. Its `fine_index` R-tree limits lookups to nearby points and overlapping polygon bounds. The full offline staging index and source records stay in the build database.

Geohash keys use a sentinel bit: start at integer 1 and shift left five bits for each geohash character, adding the character value. Thus `0` is 32 and `00` is 1,024; leading zeros and differing lengths never collide. Each precision occupies a separate contiguous key interval.

The standard build has exactly **1,082,400 anchors** for levels 1–4. A level-5 prefix without a stored anchor or a containing municipality resolves through its populated level-4 parent. Exact lookup comes first and results are held in a bounded LRU (default 100,000 entries). Offline builds can add `--exact-prefix 9q8yy` (repeatable) to persist a specific level-5 anchor using the local-type spatial tree.

`ANALYZE`, `VACUUM`, `integrity_check`, foreign-key checks and complete per-level counts run before publication. A count equal to the size of each key interval, combined with unique integer keys and verified referenced places, proves coverage for every level-1–4 prefix and consequently every level-5 parent fallback. Validators also sample globally and verify query plans use primary-key lookups.

Reproducibility requires identical source bytes, normalized inputs, configuration, explicit build date, Python/SQLite and scientific-library versions. The SQLite artifact is deterministic under that environment; timing metrics in the external manifest are naturally not. No current wall-clock timestamp is injected into the database.

## Runtime concurrency and deployment

One `Gazetteer` shares a read-only SQLite connection serialized by an RLock; the LRU uses the same lock. It is safe for threads, with one process-level instance. For higher parallelism, instantiate one per worker process. Do not reuse a connection inherited through fork; the runtime detects it. Configure during worker startup, and close at shutdown. Database access uses `mode=ro` and `PRAGMA query_only=ON`; missing paths fail instead of creating an empty database. Runtime has no network implementation or build dependency.

The chat Lambda uses its own Node SQLite reader and reuses the connection across invocations. CDK bundles `artifacts/room-descriptions/geochalk-gazetteer-v1-20261123-municipal.sqlite` when present at synthesis time.

AWS currently allows a **250 MB uncompressed ZIP including layers**, versus **10 GB uncompressed for a container image**. A 60–120 MB database may fit in a ZIP with a small runtime, but the whole deployment must be measured; do not assume every ZIP/layer composition fits. An EFS mount with read-only IAM/POSIX permissions is another option, with VPC/network setup and network-file read latency to measure. Never mutate a mounted live artifact: publish a new version and deploy a new path. Packaging the DB inside an image avoids runtime source/API/network downloads. Sources: [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [filesystem access](https://docs.aws.amazon.com/lambda/latest/dg/configuration-filesystem.html).

## Artifacts, licensing and measurements

Publish the versioned `.sqlite`, `.manifest.json`, validation results, source manifest and `ATTRIBUTION.md` together. Keep raw inputs and `.build.sqlite` separately for regeneration/audits. Do not add the databases or source dumps to Git. A versioned object-store key or container image digest should be immutable; verify the manifest SHA-256 when installing. No production AWS resources are modified by these scripts.

See [measured results](../../docs/room-descriptions.md) for the real build count, size and timings. Latencies distinguish uncached LRU queries, warmed LRU queries and opening a fresh connection. The operating-system page cache is not flushed, so fresh-connection timings are not presented as physical cold-disk latency.

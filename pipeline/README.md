# Digital Twin Earth Forecast Engine

The forecast engine integrated into Digital Twin Earth 2.0. It retains native NetCDF forecasts and publishes browser-readable numeric grids and manifests directly to the globe UI.

> **License and readiness notice.** GraphCast code is Apache-2.0; the published model weights are CC BY-NC-SA 4.0 (non-commercial). Treat generated outputs accordingly. This ERA5T path is experimental, not an operational forecast service, and not a source of weather warnings.

## Quick start (macOS CPU)

```bash
cd "/Users/stevenabraham/Documents/Digital Twin 2.0"
npm run pipeline:setup
source pipeline/.venv/bin/activate
```

If an earlier install was already created, refresh its demo dependencies once:

```bash
python -m pip install -e 'pipeline[graphcast,era5,dev]'
```

Run the official GraphCast Small demo and retain its prediction plus initialization state (the first run downloads the official source and artifacts to `~/.cache/forecast-engine`; nothing is committed):

```bash
forecast-engine run-sample --output-dir pipeline/output/sample-run
```

Publish numeric UI data into the static UI's data directory (this does not modify UI source). Publishing requires the separately retained initialization state so every run begins at T+0:

```bash
forecast-engine publish --native pipeline/output/sample-run/forecast.nc \
  --initialization-state pipeline/output/sample-run/initialization.nc \
  --publish-dir pipeline/output/era5t-graphcast-small/published
```

Validate and sample native data:

```bash
forecast-engine validate-run --run-dir pipeline/output/era5t-graphcast-small/published/models/google-graphcast-small/runs/<run-id>
forecast-engine sample-city --native pipeline/output/sample-run/forecast.nc --latitude 40.713 --longitude -74.006 --lead-hours 6
```

See [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md), [architecture.md](docs/architecture.md), and [input-adapters.md](docs/input-adapters.md).

## Experimental ECMWF HRES import test

This is an isolated pre-inference check for the public ECMWF HRES feed; it does
not modify the sample pipeline or publish UI data. Install its optional GRIB
reader/downloader dependencies, then audit a currently retained HRES run:

```bash
python -m pip install -e '.[hres]'
forecast-engine hres-audit --initialization-time 2026-07-10T12:00:00Z
```

The command downloads forecast step 0 and reports the available fields, levels,
and grid shape. A passing result establishes only that the input can advance to
the conversion/inference proof; it does not claim that the model has run yet.

## Manual ERA5T GraphCast Small pipeline

After configuring CDS credentials and accepting the ERA5 licences, run the full
delayed-data pipeline manually. It discovers the latest ERA5T source time,
retrieves atmospheric/surface/precipitation data, prepares the 1-degree input,
runs eight six-hour forecast frames, validates them, and publishes the prepared
ERA5T initialization state at T+0 followed by the GraphCast predictions at T+6
through T+48:

```bash
pipeline/.venv/bin/python pipeline/scripts/run_admin_pipeline.py \
  --mode full --compute-device cpu --execution-id manual-001 --steps 8 \
  --work-dir pipeline/output/era5t-graphcast-small \
  --publish-dir pipeline/output/era5t-graphcast-small/published
```

`--compute-device` accepts `cpu`, `gpu_l4` (NVIDIA CUDA), or `gpu_amd`
(AMD Radeon AI PRO R9700 via ROCm). Install `pipeline[gpu]` for the pinned L4
CUDA backend or `pipeline[amd-gpu]` after installing a compatible ROCm 7 runtime.
The requested target and the selected JAX backend/device are written to the run log.

The finished `.bin` snapshots are published under
`pipeline/output/era5t-graphcast-small/published/`. The Node server exposes this
directory at `/forecasts/`, and the `/admin/` page accounts for every retained
snapshot and native artifact.

## Deployment boundary

`forecast_engine.publish` and `forecast_engine.schemas` are model-neutral. A future `nvidia-<model-name>` provider can publish to the same catalog, but must own its inference and input adapters. No NVIDIA dependencies or placeholder model records are included here.

## Browser data contract

The engine does not publish palette-colored PNG weather layers. Each completed
run keeps GraphCast predictions unchanged in `native/forecast.nc`, preserves
the prepared base state separately in `native/initialization.nc`, and writes
one headerless Float32 binary snapshot per lead at
`data/ui-surface/t+{leadHours}.bin`. JSON UI-surface snapshots are no longer
produced or supported; forecast manifests use `schemaVersion: "2.0"`.

Every snapshot contains every field available for that run, normally
`temperature`, `rain`, `pressure`, `windU`, and `windV`. Fields are concatenated
in the exact order of `uiSurface.fields`; each field contains
`grid.width × grid.height` explicit little-endian IEEE-754 Float32 values. The
within-field order remains row-major, north-to-south then west-to-east, and
missing cells are Float32 NaN. Units remain C, mm per 6 h, hPa, and m s-1.

For field index `i`, the byte offset is
`i × grid.width × grid.height × 4`. A complete file is
`uiSurface.fields.length × grid.width × grid.height × 4` bytes. Every manifest
file entry records the lead, relative `.bin` path, exact byte length, and
lowercase SHA-256 checksum. Layers use `encoding: "ui-grid-float32-le"` and
their `dataField` selects a field inside the shared file.

`leadTimesHours` always starts with `0`. The T+0 file is an ERA5T analysis/base
state, not a GraphCast prediction. Its rain field is the six-hour accumulation
ending at T0 (T-6 through T0). T+6 and every later rain frame are GraphCast
forecast accumulations for their preceding six-hour intervals; for example,
T+6 covers T0 through T+6. Every UI frame uses the same fields, units, grid
orientation, field-major layout, and Float32 NaN handling.

Load a snapshot with `response.arrayBuffer()`. This portable access path makes
endianness explicit:

```js
const buffer = await (await fetch(file.path)).arrayBuffer();
if (buffer.byteLength !== file.byteLength) throw new Error("Snapshot length mismatch");
const count = manifest.grid.width * manifest.grid.height;
const fieldIndex = manifest.uiSurface.fields.indexOf("temperature");
const fieldOffset = fieldIndex * count * 4;
const value = new DataView(buffer).getFloat32(fieldOffset + cellIndex * 4, true);
```

After confirming the client is little-endian, the UI can use a zero-copy
`new Float32Array(buffer, fieldOffset, count)` view instead. Check missing data
with `Number.isNaN(value)`. See
[docs/manifest-schema.md](docs/manifest-schema.md) for the complete contract,
endianness probe, checksum details, and frame semantics.

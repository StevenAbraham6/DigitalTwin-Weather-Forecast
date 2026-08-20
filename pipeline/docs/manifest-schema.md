# Forecast manifest schema 2.0

The Pydantic definition in `src/forecast_engine/schemas/contract.py` is the
canonical executable schema. Schema 2.0 is a hard cutover: UI-surface snapshots
are headerless Float32 binary files, and schema 1.0 JSON UI-surface snapshots
are not accepted or produced. The forecast manifest, root catalog, and latest
pointer all identify the published contract as schema 2.0 so a loader never
encounters mixed schema versions while resolving a run.

The forecast manifest retains the provider-qualified model ID, model facts,
initialization time, requested lead hours, frame provenance, equirectangular
grid, layers, units, rain semantics, and native NetCDF provenance. The
`leadTimesHours` array is unique and increasing and begins with `0`.

## Binary UI-surface contract

Every lead time has one `data/ui-surface/t+{leadHours}.bin` file. Every file in
a run contains every available field in the exact order declared by
`uiSurface.fields`; fields are not split across files. The complete
`uiSurface` object has this contract:

```json
{
  "id": "ui-surface",
  "encoding": "float32-le",
  "pathTemplate": "data/ui-surface/t+{leadHours}.bin",
  "layout": "field-major",
  "fields": [
    "temperature",
    "rain",
    "pressure",
    "windU",
    "windV"
  ],
  "bytesPerValue": 4,
  "gridOrder": "row-major: north-to-south, west-to-east",
  "noData": "IEEE-754 NaN",
  "units": {
    "temperature": "C",
    "rain": "mm per 6 h",
    "pressure": "hPa",
    "windU": "m s-1",
    "windV": "m s-1"
  },
  "files": [
    {
      "leadHours": 0,
      "path": "data/ui-surface/t+0.bin",
      "byteLength": 1303200,
      "sha256": "<64 lowercase hexadecimal characters>"
    }
  ]
}
```

`files` contains one entry for every value in `leadTimesHours`, in the same
order. Each entry's path must be the expansion of `pathTemplate`, `byteLength`
is the exact on-disk length, and `sha256` is the lowercase SHA-256 digest of the
complete file. The example size is for five fields on a 360 × 181 grid.

Each layer points into the same shared snapshot and identifies its field:

```json
{
  "id": "temperature",
  "label": "Temperature",
  "units": "C",
  "encoding": "ui-grid-float32-le",
  "dataTemplate": "data/ui-surface/t+{leadHours}.bin",
  "dataField": "temperature",
  "kind": "scalar",
  "sourceVariable": "2m_temperature",
  "valueRange": [-80.0, 50.0],
  "noData": "IEEE-754 NaN"
}
```

The file contains raw IEEE-754 Float32 values with explicit little-endian byte
order and no header. Within each field, values retain the existing flattened
row-major grid order: rows are north-to-south and columns are west-to-east.
Missing source cells remain IEEE-754 NaN.

For field index `i`:

```text
valuesPerField = grid.width × grid.height
fieldByteOffset = i × valuesPerField × 4
snapshotByteLength = uiSurface.fields.length × valuesPerField × 4
```

For example, the binary value at row `y`, column `x`, and field index `i`
starts at byte:

```text
((i × grid.height + y) × grid.width + x) × 4
```

Only fields genuinely available in the native forecast are declared. Once the
run's ordered field list is established, every snapshot contains all those
fields at identical offsets.

## Browser decoding

Fetch the file as an `ArrayBuffer`, verify its length against the matching
manifest `files` entry, and use the manifest field index to calculate offsets.
`DataView.getFloat32(offset, true)` is the portable decoding path because the
second argument explicitly requests little-endian decoding:

```js
const response = await fetch(file.path);
if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
const buffer = await response.arrayBuffer();
if (buffer.byteLength !== file.byteLength) throw new Error("Snapshot length mismatch");

const valuesPerField = manifest.grid.width * manifest.grid.height;
const fieldIndex = manifest.uiSurface.fields.indexOf("temperature");
if (fieldIndex < 0) throw new Error("Field is not available in this run");
const fieldByteOffset = fieldIndex * valuesPerField * 4;
const view = new DataView(buffer);
const value = view.getFloat32(fieldByteOffset + cellIndex * 4, true);
if (Number.isNaN(value)) {
  // Missing source cell.
}
```

On a confirmed little-endian client, a zero-copy typed view can expose a whole
field directly:

```js
const endianProbe = new ArrayBuffer(4);
new DataView(endianProbe).setUint32(0, 0x01020304, true);
const clientIsLittleEndian = new Uint8Array(endianProbe)[0] === 0x04;
if (!clientIsLittleEndian) throw new Error("Use DataView decoding on this client");

const values = new Float32Array(buffer, fieldByteOffset, valuesPerField);
```

The UI may also verify `sha256` with `crypto.subtle.digest("SHA-256", buffer)`
before decoding.

## Frame and provenance semantics

The manifest's `frames` array describes each lead. Lead 0 has
`frameType: "analysis"` and comes from the prepared initialization artifact in
`native/initialization.nc`. Positive leads have `frameType: "prediction"` and
come, without shifting, from GraphCast's prediction-only
`native/forecast.nc`.

For `total_precipitation_6hr`, T+0 means the six-hour analysis accumulation
ending at T0 (T-6 through T0). T+6 means the GraphCast forecast accumulation
from T0 through T+6, and later prediction frames cover their own preceding
six-hour forecast intervals. T+0 must never be described as a GraphCast
prediction.

# Digital Twin Earth 2.0

This project contains the Digital Twin Earth UI, controller, administration
page, and the integrated ERA5T → Google GraphCast Small forecast pipeline.

Install the local controller server once:

```bash
cd "/Users/stevenabraham/Documents/Digital Twin 2.0"
npm install
```

Then start the server:

```bash
npm start
```

Open `http://localhost:8080/admin/` and confirm whether this process is the
master or a slave. This confirmation is required after every server start;
the last node profile is retained to prefill the form.

Choose **Master** for the presentation computer. The master serves the globe
at `/`, the iPad controller, and the admin UI. Choose **Slave** for an execution
worker. A slave serves only `/admin/`, redirects `/` there, and requires the
master's IP address or URL. Every node also requires a unique display name, an
XE130c M8 or XE150c M8 model, and one or more configured CPU/GPU options.

The master accepts one to three registered slaves. All nodes must be able to
reach each other's configured HTTP ports over the local network.

## iPad controller

The project contains two browser applications:

- `/` is the authoritative Three.js globe display.
- `/controller/` is the touch-first iPad control surface.

Both are served by the same local Node process. On the globe, select the iPad
icon in the bottom control bar. Scan the displayed QR code with the iPad, or
open the controller URL shown by the server and enter the six-digit pairing
code. The presentation computer and iPad must be able to reach each other on
the same local network.

The iPad sends camera intent and semantic commands; the globe continues to
perform all rendering, forecast loading, and camera integration locally. The
globe publishes its confirmed source, layers, city, playback, and timeline
state back to the controller. A 220 ms camera-input timeout stops PTZ motion if
the iPad disconnects during a gesture.

If port 8080 is already occupied, stop the old server or choose another port:

```bash
PORT=8090 npm start
```

The terminal prints the corresponding local-network admin URL after the server
starts. Once configured as master, the iPad controller remains available at
`/controller/`.

## Pipeline administration

Use `http://localhost:8080/admin/` to run the pipeline, configure a recurring
schedule, review execution logs and stage timings, and inspect retained
snapshot storage. Schedules are persisted under `pipeline/admin-data/` and
resume whenever the node has been configured for the current server process.
Pipeline executions are serialized per node so a scheduled run cannot overlap
an active manual run on that node.

On a master, the execution-node selector contains the master and connected
slaves. Its compute choices are populated from the selected node's profile.
The master dispatches remote runs, displays their live progress and logs, and
combines every node's executions in one node-tagged history table. A slave can
also run or schedule its own executions from its local admin page.

Slaves report progress and completed execution records to the master. After a
successful run they upload the forecast manifest and UI-surface snapshot files
needed by the globe. Native NetCDF artifacts remain local to the execution
node. On the master globe, the former weather-data selector is a node selector;
choosing a node loads that node's latest transferred pipeline result.

The shared execution form controls the name, full or inference-only mode,
CPU, NVIDIA L4, or AMD Radeon AI PRO R9700 inference, and forecast-frame count for both **Run now**
and recurring schedules. A full run
downloads and prepares the latest base data; inference-only reuses the most
recent prepared ERA5T base state and skips those stages. Inference-only remains
unavailable until reusable base data exists. Schedules additionally store their
frequency and enabled state, and append a timestamp to the shared name.

CPU is the portable default. On an NVIDIA Linux server, install the pinned CUDA
12 JAX backend before selecting **GPU · NVIDIA L4** in the form:

```bash
pipeline/.venv/bin/python -m pip install -e 'pipeline[gpu]'
```

On an AMD Radeon AI PRO R9700 Linux server, install a compatible ROCm 7 runtime.
After the regular pipeline setup, replace the CPU JAX packages with the matched
ROCm JAX stack before selecting **GPU · AMD Radeon AI PRO R9700**:

```bash
npm run pipeline:setup:amd
```

The full ROCm runtime—not only the AMD display driver—must expose `/dev/kfd`,
`/opt/rocm`, and `libamdhip64.so.7`. The setup command checks these prerequisites
before downloading the JAX wheels and verifies the detected ROCm device afterward.

GPU selection is strict: if the selected CUDA or ROCm JAX backend cannot
initialize, the execution fails and records the requested target, JAX platform,
actual backend, device name, and backend error instead of silently using CPU.

Install the project-local Python environment once before the first run:

```bash
npm run pipeline:setup
```

ERA5T retrieval requires a valid CDS API configuration and accepted dataset
licences. The first admin run downloads the tested upstream source revision if
needed; model source and downloaded artifacts are cached outside the source
tree under the standard forecast-engine user cache.

## Forecast pipeline connection

The server maps `/forecasts/` directly to the integrated engine's stable publish
root at `pipeline/output/era5t-graphcast-small/published`; no cross-project
symbolic link is used. The engine creates versioned run directories and updates
its `latest` manifest pointer only after validation. The UI checks that pointer every minute and whenever
the page becomes visible, then reads the selected run's catalog, manifest, and
schema 2.0 `data/ui-surface/t+{leadHours}.bin` snapshots for temperature,
precipitation, pressure, and wind. Each snapshot contains every available field
as little-endian Float32 values in the field-major order declared by
`manifest.uiSurface.fields`. Missing values are IEEE-754 NaNs. The browser
validates the declared layout and byte length before exposing zero-copy typed
array views to the existing renderer. While an older schema 1.0 run remains the
latest published forecast, the UI can still read its JSON surface frames; new
schema 2.0 runs automatically use the binary path.

The UI loads frames as playback reaches them and retains them in its existing
in-memory cache. This binary-format cutover intentionally does not add
prefetching, persistent browser storage, or byte-budget eviction.

## Automatic city descent

Entering a city rotates the globe to the location and descends to about 2,000
miles above it. The selected city's weather card is sampled from the active
pipeline frame at the city coordinates.

To add high-resolution 2D satellite imagery at the selected city, enable the
Google Map Tiles API, restrict a browser API key to this application's origin,
and put it in `config.js`. The key is optional: the globe and pipeline layers
work without it. Keep Google attribution visible whenever those tiles are in
use.

Bundled NASA imagery:

- `nasa-blue-marble-hd.jpg`: Blue Marble: Next Generation, topography and bathymetry, stitched locally at 5120 x 2560 from NASA's January image tiles.
- `nasa-black-marble-2016.jpg`: Black Marble 2016, global night lights.

Sources: NASA Earth Observatory's Blue Marble: Next Generation and Earth at Night / Black Marble collections.

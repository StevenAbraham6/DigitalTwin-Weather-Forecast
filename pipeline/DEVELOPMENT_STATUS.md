# Development status

## Works now

- A typed CLI creates and validates provider-qualified forecast publications.
- Publishing converts verified native variables to browser-readable numeric JSON grids and records their scientific metadata.
- `sample-city` bilinearly samples NetCDF values, never display pixels.
- `run-sample` executes the upstream GraphCast demo after appending only an export cell. It uses the official GraphCast Small sample input/artifacts and writes the prediction-only `forecast.nc` plus a separate `initialization.nc` base-state artifact needed for T+0 publishing.

## Important limitations

- This is a reproducible **sample-data/demo** inference path. It is not a live or operational forecast.
- The upstream public project is currently named `google-deepmind/weathernext` (formerly `graphcast`); the pinned repository/demo is resolved at run time and recorded in provenance.
- The runner deliberately discovers variables in the produced dataset. The current official WeatherNext source defines GraphCast Small targets as 2 m temperature, mean sea-level pressure, total precipitation over 6 h, 10 m U/V wind, plus pressure-level temperature/geopotential/U/V/vertical velocity/specific humidity. It publishes only recognized surface variables actually present in a produced dataset. No moisture layer is fabricated; pressure-level fields remain native only.
- The UI product is numeric JSON, not PNG. The UI should create its own textures/visual styling from these grids and sample the same grids for city readouts.
- A real current forecast requires validated acquisition, regridding, unit/coordinate validation, and temporal preparation of operational inputs, including calculated solar forcing. `hres_operational` is intentionally not implemented.
- GraphCast’s upstream documentation says model weights are CC BY-NC-SA 4.0; they are not cleared for commercial use. Dataset terms may impose additional restrictions.

## Verified locally

The contract/publishing/validation tests run without downloading model weights. A full model smoke run requires network access, upstream Python/JAX compatibility for the local Mac, and potentially substantial CPU time and memory.

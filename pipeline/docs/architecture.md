# Architecture and UI handoff

The forecast engine is independent of `/Users/stevenabraham/Documents/Digital Twin Earth`. It writes static files only; it never changes that UI's HTML, JavaScript, or CSS.

```text
prepared base state -----------------------> native/initialization.nc --+
Google provider input + GraphCast inference -> native/forecast.nc ------+-> publisher
                                                                         -> UI T+0 analysis + T+6... predictions
                                                                         -> manifest / catalog / latest pointer
```

`catalog.json` is the future model-selector entry point. Each catalog record names one provider-qualified model ID and its own latest manifest. A UI must discover available layers from the selected run manifest—never assume rain, moisture, pressure, or wind exists.

Every exported UI data product is a global equirectangular numeric grid with -180° to +180° left-to-right and +90° to -90° top-to-bottom. The manifest states dimensions, native-grid facts, units, source variable, value range, no-data policy, and whether each frame is an analysis or prediction. GraphCast output remains prediction-only in `native/forecast.nc`; the prepared T0 state remains in `native/initialization.nc`. The UI should use the shared field-major Float32 file at `data/ui-surface/t+{leadHours}.bin` for both texture generation and location readouts.

The current Three.js UI can be served statically and therefore can load this directory with normal relative HTTP requests once it adds a loader. It currently creates synthetic textures and synthetic city values in the browser. The numeric `ui-surface` product is designed to replace that synthetic sampling function without asking the browser to parse NetCDF.

## Contract

The versioned forecast manifest schema is represented by `forecast_engine.schemas.contract` and serialized as `schemaVersion: "2.0"`. Its UI payload is headerless little-endian Float32 binary. The root catalog and small `latest/manifest.json` pointer are also stamped schema 2.0, keeping the loader-facing publication consistent from discovery through run loading. A completed run is written below `models/<model-id>/runs/<run-id>/`, and the root catalog lists only successfully published models. Publishing is deliberately model-neutral. A future NVIDIA provider publishes a distinct `nvidia-*` model record and calls the same publisher after its own validated inference/input path.

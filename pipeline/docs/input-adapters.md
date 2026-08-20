# Input adapter design

Adapters are the boundary between a data source and provider-specific model preparation. They must return a source identity, run classification, and validated source path. They must not silently interpolate, fabricate variables, or relabel a historical analysis as a forecast.

## `sample`

Implemented by the official GraphCast demo runner. It uses supplied source data, checkpoint, and normalization artifacts. Its output is always `sample_demo` and is never current operational weather.

## `era5t_graphcast_small`

An experimental, delayed-data path for local GraphCast Small development. It authenticates to CDS at runtime, queries the current ERA5T temporal extent, and retrieves the required pressure/surface source fields for two six-hourly states. It normalizes coordinates to 1°, calculates 6-hour precipitation and solar forcing, and must pass a checkpoint smoke test before it may publish UI data. The prepared T0 state is passed to publishing separately from GraphCast's prediction dataset and becomes the T+0 analysis frame. Its precipitation is the six-hour accumulation ending at T0; it is not a prediction. ERA5T timestamps must always be shown as source time; they are not current forecasts.

## `hres_operational`

Intentionally a precise non-functioning placeholder. Required work: obtain licensed HRES/fc0 data; select the model family/checkpoint actually trained for it; acquire all required state fields and temporal history; implement deterministic regridding and unit conversion; generate solar forcing for each target lead; validate latency, completeness, coordinate ordering, pressure levels, and accumulated-field semantics; backtest against held-out runs; add monitoring, retries, data-age guards, and alert/legal disclaimers. Until every item is implemented and tested, no command may call its output a current forecast.

Other providers (including a future NVIDIA model) implement their own adapters behind the same publish contract; they do not inherit GraphCast assumptions.

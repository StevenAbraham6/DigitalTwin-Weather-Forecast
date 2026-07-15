# Digital Twin Earth 2.0

This frontend renders the Earth and visualizes the numeric grids published by
the separate **Digital Twin Google Pipeline**. It does not run or modify the
forecast model.

Start it from this folder with a static web server:

```bash
cd "/Users/stevenabraham/Documents/Digital Twin 2.0"
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Forecast pipeline connection

`forecasts` is a symbolic link to the forecast assets currently published by
`/Users/stevenabraham/Documents/Digital Twin Earth/forecasts`. That preserves
the existing pipeline contract without changing the backend. The UI reads the
same catalog, manifest, and `data/ui-surface/t+{leadHours}.json` grids for
temperature, precipitation, pressure, and wind.

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

# Digital Twin Earth 2.0

This frontend renders the Earth and visualizes the numeric grids published by
the separate **Digital Twin Google Pipeline**. It does not run or modify the
forecast model.

Install the local controller server once:

```bash
cd "/Users/stevenabraham/Documents/Digital Twin 2.0"
npm install
```

Then start the display and controller host:

```bash
npm start
```

Open `http://localhost:8080` on the presentation computer. The Node server
replaces the prior static Python server because it serves both browser apps and
routes their live WebSocket messages.

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

The terminal prints the corresponding local-network controller URL after the
server starts.

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

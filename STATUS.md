# Status

Current state of the in-progress UI/map work. Updated 2026-05-31.

## Recently addressed

- **Hover infobox position** — the popup now appears next to the hovered marker
  (edge-flipping at the map borders) instead of pinned bottom-left, and stays
  open while the pointer is over it so its callsign links are clickable
  (`MapController` hover-intent + `_positionPopup`).
- **Infobox layout** — rewritten as a compact stack of rows (`onPopupRequest` in
  `main.js`); the old blank lines came from mixing `<br>` with block-level
  `<small>` elements and are gone.
- **"Shadow time is spot time"** — hovering a spot now shifts the night shadow to
  that spot's time and reverts on leave (`setNightForSpot` / `setSunBaseTime`).
- **Map projection switcher** — new Display Option to switch between Mercator,
  azimuthal equidistant, and Lambert azimuthal equal-area. Azimuthal projections
  are centered on the entered callsign's locator. Implemented with proj4
  (`src/utils/projection.js`) + `MapController.setProjection`.

## Projection details

The pieces we project ourselves all reproject correctly in every mode:

- Markers and great-circle lines go through `fromLonLat(.., projection)`.
- The night shadow stays a per-pixel WebGL model (sun altitude / twilight); the
  fragment shader gained the azimuthal inverse (`aeqd`/`laea`) alongside the
  Mercator one, so it is *not* downgraded to a flat terminator polygon.
- The Maidenhead grid draws a subdivided global graticule in azimuthal world
  views.

## Known issue

- **Basemap in azimuthal modes** — OpenLayers reprojects the OpenFreeMap vector
  tiles via `VectorTileLayer` + the view projection, but there is an **upstream
  OpenLayers bug** in vector-tile reprojection (reproducible on OpenLayers' own
  `vector-tiles-reprojected` example). Until that is fixed upstream, the basemap
  tiles may render incorrectly in azimuthal modes; the overlays above are
  unaffected. A bug report against OpenLayers is being filed.

## Not yet verified

- Live browser verification of the three projection modes is still pending
  (local tooling issue at the time of writing).

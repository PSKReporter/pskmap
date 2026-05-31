import Map from 'ol/Map';
import View from 'ol/View';
import { defaults as defaultControls } from 'ol/control/defaults';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat, toLonLat, get as getProjection } from 'ol/proj';
import { apply } from 'ol-mapbox-style';
import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import { Style, Stroke } from 'ol/style';
import { GreatCircle } from 'arc';
import SunSource from './layers/SunSource';
import MaidenheadSource from './layers/MaidenheadSource';
import MarkerManager from './MarkerManager';
import { getAzimuthalProjection, PROJ_TYPE, EARTH_RADIUS } from './utils/projection';
import pskStyle from '../psk-basic-3.json';

class MapController {
    constructor(targetId) {
        this.targetId = targetId;
        this.map = null;
        this.markerSource = new VectorSource();
        this.lineSource = new VectorSource();
        this.onPopupRequest = null;
        this.hideLines = false;
        this.linesAlways = false;
        this._hideTimer = null;
        this._popupFeature = null;
        this._sunTimeOverride = null;
        this._sunBaseTime = null;   // sun time to revert to when not hovering a spot
        this.nightForSpot = false;

        // Projection state. Markers, lines, the night shadow and the grid all
        // follow this.projection so the map can switch between Mercator and the
        // azimuthal projections.
        this.projection = getProjection('EPSG:3857');
        this.projKind = 'mercator';
        this.projType = PROJ_TYPE.mercator;
        this.projCenter = [0, 0];        // [lon, lat] in degrees
        this._projCenterRounded = null;

        // Desired overlay state, re-applied whenever the sun/grid layers are
        // rebuilt for a new projection.
        this._showSun = true;
        this._showGrid = false;
        this._obscureFactor = 0.65;

        this.layers = {};
        this.initMap();
    }

    setHideLines(hide) {
        this.hideLines = hide;
        this.updateLinesVisibility();
    }

    setLinesAlways(always) {
        this.linesAlways = always;
        this.updateLinesVisibility();
    }

    updateLinesVisibility() {
        if (this.layers.lines) {
            this.layers.lines.setVisible(!this.hideLines);
        }
    }

    // Override the time used by the sun layer. Pass null to use current time.
    setSunTimeOverride(timestampMs) {
        this._sunTimeOverride = timestampMs;
        if (this.sunSource) this.sunSource.changed();
    }

    // Base sun time used when not hovering a spot (e.g. time of the latest report).
    setSunBaseTime(timestampMs) {
        this._sunBaseTime = timestampMs;
        this.setSunTimeOverride(timestampMs);
    }

    // When enabled, hovering a spot sets the night shadow to that spot's time.
    setNightForSpot(on) {
        this.nightForSpot = on;
        if (!on) {
            this._sunBaseTime = null;
            this.setSunTimeOverride(null);
        }
    }

    getViewState() {
        if (!this.map) return null;
        const view = this.map.getView();
        const center = toLonLat(view.getCenter(), this.projection);
        return { lng: center[0], lat: center[1], zoom: view.getZoom() };
    }

    setViewState(lat, lng, zoom) {
        if (!this.map) return;
        this.map.getView().setCenter(fromLonLat([lng, lat], this.projection));
        this.map.getView().setZoom(zoom);
    }

    // Switch the map projection. `kind` is 'mercator' | 'aeqd' | 'laea';
    // azimuthal projections are centered on centerLonLat ([lon, lat] degrees).
    // No-op if neither the kind nor (for azimuthal) the rounded center changed.
    setProjection(kind, centerLonLat) {
        kind = kind || 'mercator';
        const center = (centerLonLat && isFinite(centerLonLat[0]) && isFinite(centerLonLat[1]))
            ? [centerLonLat[0], centerLonLat[1]]
            : [0, 20];

        if (kind === this.projKind) {
            if (kind === 'mercator') return;
            const rLon = Math.round(center[0] * 2) / 2;
            const rLat = Math.round(center[1] * 2) / 2;
            if (this._projCenterRounded &&
                this._projCenterRounded[0] === rLon && this._projCenterRounded[1] === rLat) {
                return;
            }
        }

        let projection;
        if (kind === 'mercator') {
            projection = getProjection('EPSG:3857');
            this.projType = PROJ_TYPE.mercator;
            this.projCenter = [0, 0];
            this._projCenterRounded = null;
        } else {
            projection = getAzimuthalProjection(kind, center[1], center[0]);
            this.projType = PROJ_TYPE[kind];
            this.projCenter = [center[0], center[1]];
            this._projCenterRounded = [Math.round(center[0] * 2) / 2, Math.round(center[1] * 2) / 2];
        }
        this.projection = projection;
        this.projKind = kind;

        const prevZoom = this.map.getView() ? this.map.getView().getZoom() : 2;
        this.map.setView(new View({
            projection,
            center: fromLonLat(center, projection),
            zoom: kind === 'mercator' ? prevZoom : 3
        }));

        // Old marker/line geometries are in the previous projection; drop them
        // (the caller repopulates via a fresh search) and rebuild the overlays
        // that are bound to a projection.
        this.clearMarkers();
        this._buildSunGridLayers();
    }

    fitToMarkers() {
        if (!this.map) return;
        const extent = this.markerSource.getExtent();
        if (!extent || extent[0] === Infinity) return;
        this.map.getView().fit(extent, {
            padding: [60, 60, 60, 60],
            maxZoom: 10,
            duration: 500
        });
    }

    addLine(startLon, startLat, endLon, endLat, color) {
        if (this.hideLines) return;

        const start = { x: startLon, y: startLat };
        const end = { x: endLon, y: endLat };

        try {
            const generator = new GreatCircle(start, end);
            const path = generator.Arc(100, { offset: 10 });
            if (!path.geometries) return;

            const style = new Style({
                stroke: new Stroke({ color: this._normalizeLineColor(color), width: 2 })
            });
            const addSegment = (coords) => {
                if (coords.length < 2) return;
                const feature = new Feature({ geometry: new LineString(coords) });
                feature.setStyle(style);
                this.lineSource.addFeature(feature);
            };

            if (this.projKind === 'mercator') {
                // Stitch arc segments across the antimeridian seam by carrying a
                // longitude offset, so the line doesn't streak across the map.
                const coords = [];
                let lonOffset = 0;
                let lastLon = startLon;
                path.geometries.forEach(geom => {
                    if (!geom || !geom.coords) return;
                    for (let i = 0; i < geom.coords.length; i++) {
                        if (Math.abs(lastLon - geom.coords[i][0]) > 300) {
                            lonOffset += geom.coords[i][0] > 0 ? -360 : 360;
                        }
                        lastLon = geom.coords[i][0];
                        coords.push(fromLonLat([geom.coords[i][0] + lonOffset, geom.coords[i][1]], this.projection));
                    }
                });
                addSegment(coords);
            } else {
                // Azimuthal projections have no antimeridian seam; project each
                // sub-arc directly and drop points near the antipodal blow-up.
                path.geometries.forEach(geom => {
                    if (!geom || !geom.coords) return;
                    const coords = geom.coords
                        .map(c => fromLonLat([c[0], c[1]], this.projection))
                        .filter(p => isFinite(p[0]) && isFinite(p[1]));
                    addSegment(coords);
                });
            }
        } catch (e) {
            console.warn('Failed to draw great-circle line', e);
        }
    }

    _normalizeLineColor(color) {
        if (!color) return 'rgba(128, 128, 128, 0.8)';
        if (typeof color !== 'string') return 'rgba(128, 128, 128, 0.8)';
        let hex = color;
        if (!hex.startsWith('#')) hex = '#' + hex;
        if (!/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(hex)) return 'rgba(128, 128, 128, 0.8)';
        if (hex.length === 4) {
            hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        }
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, 0.9)`;
    }

    async initMap() {
        this.map = new Map({
            target: this.targetId,
            controls: defaultControls({
                rotate: false,
                attributionOptions: {
                    collapsible: false
                }
            }),
            view: new View({
                center: fromLonLat([0, 20]),
                zoom: 2
            })
        });

        try {
            await apply(this.map, pskStyle);
        } catch (e) {
            console.error('Failed to apply map style', e);
        }

        // Layer order is controlled by zIndex (not add order) so the sun/grid
        // layers can be rebuilt for a new projection without disturbing the
        // basemap (zIndex 0) or the lines/markers above them.
        this.layers.lines = new VectorLayer({ source: this.lineSource, zIndex: 30 });
        this.layers.markers = new VectorLayer({ source: this.markerSource, renderMode: 'image', zIndex: 40 });
        this.map.addLayer(this.layers.lines);
        this.map.addLayer(this.layers.markers);

        this._buildSunGridLayers();

        this.addHoverHandler();
    }

    // (Re)create the projection-bound overlays — the WebGL night shadow and the
    // Maidenhead grid — in the current projection, preserving desired state.
    _buildSunGridLayers() {
        if (this.layers.sun) this.map.removeLayer(this.layers.sun);
        if (this.layers.grid) this.map.removeLayer(this.layers.grid);

        const projection = this.projection;
        const [lon0, lat0] = this.projCenter;

        this.sunSource = new SunSource({
            projection,
            obscureFactor: this._obscureFactor,
            getCurrentTime: () => this._sunTimeOverride ?? Date.now(),
            projType: this.projType,
            centerLat: lat0,
            centerLon: lon0,
            earthRadius: EARTH_RADIUS
        });
        this.layers.sun = new ImageLayer({
            source: this.sunSource,
            opacity: 0.5,
            visible: this._showSun,
            zIndex: 10
        });

        this.maidenheadSource = new MaidenheadSource({ projection });
        this.layers.grid = new ImageLayer({
            source: this.maidenheadSource,
            visible: this._showGrid,
            zIndex: 20
        });

        this.map.addLayer(this.layers.sun);
        this.map.addLayer(this.layers.grid);
    }

    setLayerVisibility(name, visible) {
        if (name === 'sun') this._showSun = visible;
        if (name === 'grid') this._showGrid = visible;
        if (this.layers[name]) {
            this.layers[name].setVisible(visible);
        }
    }

    setObscureFactor(factor) {
        this._obscureFactor = factor;
        if (this.sunSource) this.sunSource.setObscureFactor(factor);
    }

    clearMarkers() {
        this.markerSource.clear();
        this.clearLines();
    }

    clearLines() {
        this.lineSource.clear();
    }

    addHoverHandler() {
        // Keep the popup open while the pointer is over it, so its links are clickable.
        const popupEl = document.getElementById('popup');
        if (popupEl) {
            popupEl.addEventListener('mouseenter', () => this._cancelHide());
            popupEl.addEventListener('mouseleave', () => this._scheduleHide());
        }

        this.map.on('pointermove', (evt) => {
            if (evt.dragging) {
                this.hidePopup();
                return;
            }
            const pixel = this.map.getEventPixel(evt.originalEvent);
            const feature = this.map.forEachFeatureAtPixel(pixel, (f) => {
                if (f.get('senderLat') || f.get('callsign') || f.get('receiverCallsign')) {
                    return f;
                }
                return null;
            }, {
                layerFilter: (layer) => layer === this.layers.markers
            });

            if (feature) {
                this._cancelHide();
                this.map.getTargetElement().style.cursor = 'pointer';

                // Only (re)render when we move onto a different marker, so the
                // popup stays anchored and doesn't flicker as the pointer jitters.
                if (feature !== this._popupFeature) {
                    this._popupFeature = feature;
                    const props = feature.getProperties();
                    const anchor = this.map.getPixelFromCoordinate(feature.getGeometry().getCoordinates());
                    this.showPopup(props, anchor || pixel);

                    const sLat = parseFloat(props.senderLat ?? props.sender_lat);
                    const sLon = parseFloat(props.senderLng ?? props.sender_lng);
                    const rLat = parseFloat(props.receiverLat ?? props.receiver_lat);
                    const rLon = parseFloat(props.receiverLng ?? props.receiver_lng);
                    if (!this.hideLines && !this.linesAlways && !props.isEnteredCallsign && !isNaN(sLat) && !isNaN(sLon) && !isNaN(rLat) && !isNaN(rLon)) {
                        this.clearLines();
                        this.addLine(sLon, sLat, rLon, rLat, props.color);
                    }

                    if (this.nightForSpot) {
                        const ts = parseInt(props.flowStartSeconds || props.lastSenderTime);
                        if (ts > 0) this.setSunTimeOverride(ts * 1000);
                    }
                }
            } else {
                this.map.getTargetElement().style.cursor = '';
                this._scheduleHide();
            }
        });

        this.map.on('click', () => {
            this._cancelHide();
            this.hidePopup();
        });
    }

    _cancelHide() {
        if (this._hideTimer) {
            clearTimeout(this._hideTimer);
            this._hideTimer = null;
        }
    }

    _scheduleHide() {
        if (this._hideTimer) return;
        // Short grace period so the pointer can travel from the marker into the popup.
        this._hideTimer = setTimeout(() => {
            this._hideTimer = null;
            this.hidePopup();
        }, 400);
    }

    showPopup(properties, pixel) {
        const popup = document.getElementById('popup');
        const content = document.getElementById('popup-content');
        if (this.onPopupRequest && popup && content) {
            const html = this.onPopupRequest(properties);
            if (html) {
                content.innerHTML = html;
                popup.style.display = 'block';
                if (pixel) this._positionPopup(popup, pixel);
            }
        }
    }

    // Place the popup next to the anchor pixel, flipping at the map edges.
    _positionPopup(popup, pixel) {
        const size = this.map.getSize() || [0, 0];
        const margin = 14;
        const pad = 8;
        const pw = popup.offsetWidth;
        const ph = popup.offsetHeight;

        let left = pixel[0] + margin;
        if (left + pw > size[0] - pad) left = pixel[0] - pw - margin;
        if (left < pad) left = pad;

        let top = pixel[1] + margin;
        if (top + ph > size[1] - pad) top = pixel[1] - ph - margin;
        if (top < pad) top = pad;

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.right = 'auto';
        popup.style.bottom = 'auto';
    }

    hidePopup() {
        const popup = document.getElementById('popup');
        if (popup) popup.style.display = 'none';
        this._popupFeature = null;
        if (!this.linesAlways) this.clearLines();
        if (this.nightForSpot) this.setSunTimeOverride(this._sunBaseTime);
    }

    addMarker(lon, lat, options = {}) {
        const pos = fromLonLat([lon, lat], this.projection);
        const feature = MarkerManager.createMarkerFeature(pos, options);
        this.markerSource.addFeature(feature);
        return feature;
    }

    updateSunLayer() {
        this.sunSource.changed();
    }

    updateGrid() {
        this.maidenheadSource.changed();
    }
}

export default MapController;

import proj4 from 'proj4';
import { register } from 'ol/proj/proj4';
import { get as getProjection } from 'ol/proj';

// WGS84 sphere radius used by the +datum=WGS84 azimuthal defs below and by the
// matching inverse math in the night-shadow shader.
export const EARTH_RADIUS = 6378137;

// proj4 projection family per UI kind.
const PROJ4_NAME = { aeqd: 'aeqd', laea: 'laea' };

// Numeric code the night-shadow shader uses to pick its inverse formula.
export const PROJ_TYPE = { mercator: 0, aeqd: 1, laea: 2 };

/**
 * Register (once) and return an OpenLayers projection for an azimuthal map
 * centered on lat0/lon0. The center is rounded so panning/refreshing with the
 * same callsign reuses one projection instead of spawning a new one each time.
 *
 * @param {'aeqd'|'laea'} kind
 * @param {number} lat0  center latitude in degrees
 * @param {number} lon0  center longitude in degrees
 */
export function getAzimuthalProjection(kind, lat0, lon0) {
    const family = PROJ4_NAME[kind];
    if (!family) throw new Error(`Unknown azimuthal projection: ${kind}`);

    const la = Math.round(lat0 * 2) / 2;
    const lo = Math.round(lon0 * 2) / 2;
    const code = `PSK:${kind.toUpperCase()}:${la}_${lo}`;

    const existing = getProjection(code);
    if (existing) return existing;

    proj4.defs(code, `+proj=${family} +lat_0=${la} +lon_0=${lo} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs +type=crs`);
    register(proj4);

    const proj = getProjection(code);
    // Disc radius: AEQD maps the antipode to R*pi; LAEA maps it to 2R.
    const radius = kind === 'laea' ? 2 * EARTH_RADIUS : Math.PI * EARTH_RADIUS;
    proj.setExtent([-radius, -radius, radius, radius]);
    proj.setWorldExtent([-180, -90, 180, 90]);
    return proj;
}

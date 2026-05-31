import ImageCanvasSource from 'ol/source/ImageCanvas';
import * as olProj from 'ol/proj';
import * as olExtent from 'ol/extent';

class MaidenheadSource extends ImageCanvasSource {
    constructor(options = {}) {
        super({
            attributions: options.attributions,
            projection: options.projection || "EPSG:3857",
            resolutions: options.resolutions,
            state: options.state,
            canvasFunction: (extent, resolution, pixelRatio, size, projection) => {
                return this.drawMaidenheadGrid(extent, resolution, pixelRatio, size, projection);
            }
        });

        this.alpha = "ABCDEFGHIJKLMNOPQRSTUVWX";
        this.lalpha = "abcdefghijklmnopqrstuvwx";
        this.digit = "0123456789";
        this.scales = [this.alpha, this.digit, this.lalpha, this.digit, this.lalpha];
        this.rounding = this.scales.reduce((acc, s) => acc * s.length, 1);
    }

    get1grid(scale, v) {
        v = v / scale + 90;
        v = v % 180;
        if (v < 0) v += 180;
        if (v >= 179.99998) v -= 180;
        v = v / 240;

        let result = '';
        v += 0.5 / this.rounding;

        for (let i = 0; i < this.scales.length; i++) {
            v = v * this.scales[i].length;
            result += this.scales[i].charAt(Math.floor(v));
            v = v - Math.floor(v);
        }
        return result;
    }

    getGridLabel(ll, level) {
        const lat = this.get1grid(1, ll[1]);
        const lng = this.get1grid(2, ll[0]);
        let result = '';
        // Build the label pair by pair: e.g. level 0 -> "FN", level 1 -> "FN42", level 2 -> "FN42hn"
        for (let i = 0; i <= level; i++) {
            result += lng.charAt(i) + lat.charAt(i);
        }
        return result;
    }

    toLonLatWithoutWrap(coordinate, projection) {
        const result = olProj.toLonLat(coordinate, projection);
        const projExtent = projection.getExtent();
        if (coordinate[0] < projExtent[0] || coordinate[0] >= projExtent[2]) {
            const offset = Math.floor((coordinate[0] - projExtent[0]) / (projExtent[2] - projExtent[0]));
            result[0] += offset * 360;
        }
        return result;
    }

    roundDownToMultiple(val, divisor) {
        let offset = val % divisor;
        if (offset < 0) offset += divisor;
        return val - offset;
    }

    roundUpToMultiple(val, divisor) {
        let offset = val % divisor;
        if (offset < 0) offset += divisor;
        return val - offset + divisor;
    }

    drawMaidenheadGrid(extent, resolution, pixelRatio, size, projection) {
        const canvas = document.createElement('canvas');
        canvas.width = size[0];
        canvas.height = size[1];

        const isMercator = projection.getCode() === 'EPSG:3857';

        // Keep the grid visible up to very high zoom-out levels. Azimuthal world
        // views have much larger resolutions, so allow more before bailing out.
        if (resolution > (isMercator ? 150000 : 400000)) return canvas;

        const ctx = canvas.getContext('2d');
        const rp = resolution / pixelRatio;
        const offset = [extent[0] / rp, extent[3] / rp];

        ctx.font = `${pixelRatio * 11}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
        ctx.strokeStyle = 'rgba(120, 120, 120, 0.25)';
        ctx.fillStyle = 'rgba(100, 100, 100, 0.8)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 1;

        // In an azimuthal projection the visible area is a disc, not a lon/lat
        // rectangle, so the extent-walking logic below doesn't apply at world
        // scale. Draw a subdivided global graticule that reprojects naturally.
        if (!isMercator && resolution >= 100) {
            this.drawGlobalGraticule(ctx, projection, rp, offset, size, resolution);
            return canvas;
        }

        const projExtent = projection.getExtent();
        const clippedExtent = extent.slice();
        if (clippedExtent[1] < projExtent[1]) clippedExtent[1] = projExtent[1];
        if (clippedExtent[3] > projExtent[3]) clippedExtent[3] = projExtent[3];

        const tl_ll = this.toLonLatWithoutWrap(olExtent.getTopLeft(clippedExtent), projection);
        const br_ll = this.toLonLatWithoutWrap(olExtent.getBottomRight(clippedExtent), projection);

        let level = 0;
        let stepLon = 20;
        let stepLat = 10;

        // Transitions: Subsquares (6 chars) -> Squares (4 chars) -> Fields (2 chars)
        if (resolution < 100) {
            level = 2;
            stepLon = 1 / 12; // 5 arc-minutes
            stepLat = 1 / 24; // 2.5 arc-minutes
        } else if (resolution < 5000) {
            level = 1;
            stepLon = 2;
            stepLat = 1;
        }

        const tl_ll_r = [this.roundDownToMultiple(tl_ll[0], stepLon), this.roundUpToMultiple(tl_ll[1], stepLat)];
        const br_ll_r = [this.roundUpToMultiple(br_ll[0], stepLon), this.roundDownToMultiple(br_ll[1], stepLat)];

        ctx.font = `${pixelRatio * 11}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
        ctx.strokeStyle = 'rgba(120, 120, 120, 0.25)';
        ctx.lineWidth = 1;

        ctx.beginPath();
        const drawLine = (from, to) => {
            const c1 = olProj.fromLonLat(from, projection);
            const c2 = olProj.fromLonLat(to, projection);
            ctx.moveTo(c1[0] / rp - offset[0], offset[1] - c1[1] / rp);
            ctx.lineTo(c2[0] / rp - offset[0], offset[1] - c2[1] / rp);
        };

        // Draw vertical lines
        for (let lon = tl_ll_r[0]; lon <= br_ll_r[0]; lon += stepLon) {
            drawLine([lon, tl_ll_r[1]], [lon, br_ll_r[1]]);
        }
        // Draw horizontal lines
        for (let lat = br_ll_r[1]; lat <= tl_ll_r[1]; lat += stepLat) {
            drawLine([tl_ll_r[0], lat], [br_ll_r[0], lat]);
        }
        ctx.stroke();

        // Draw Labels
        ctx.fillStyle = 'rgba(100, 100, 100, 0.8)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let lon = tl_ll_r[0]; lon < br_ll_r[0]; lon += stepLon) {
            for (let lat = tl_ll_r[1]; lat > br_ll_r[1]; lat -= stepLat) {
                const midLon = lon + stepLon / 2;
                const midLat = lat - stepLat / 2;
                const cc_coord = olProj.fromLonLat([midLon, midLat], projection);

                const label = this.getGridLabel([midLon, midLat], level);
                ctx.fillText(label,
                    cc_coord[0] / rp - offset[0],
                    offset[1] - cc_coord[1] / rp);
            }
        }

        return canvas;
    }

    // Draw a full lon/lat graticule for azimuthal world views. Lines are
    // subdivided so they follow the projection's curvature, and points that
    // fail to project (near the antipodal singularity) break the path.
    drawGlobalGraticule(ctx, projection, rp, offset, size, resolution) {
        // Coarser when zoomed out, finer (squares) when zoomed in a bit.
        const fine = resolution < 5000;
        const stepLon = fine ? 2 : 20;
        const stepLat = fine ? 1 : 10;
        const level = fine ? 1 : 0;
        const sub = fine ? 0.5 : 2;   // sampling step along each line, degrees

        const toPixel = (lon, lat) => {
            const c = olProj.fromLonLat([lon, lat], projection);
            if (!isFinite(c[0]) || !isFinite(c[1])) return null;
            const px = c[0] / rp - offset[0];
            const py = offset[1] - c[1] / rp;
            // Reject points projected wildly outside the canvas (antipode blow-up).
            if (px < -size[0] || px > 2 * size[0] || py < -size[1] || py > 2 * size[1]) return null;
            return [px, py];
        };

        const stroke = (a, b, along) => {
            ctx.beginPath();
            let pen = false;
            for (let v = a; v <= b + 1e-6; v += sub) {
                const p = along(Math.min(v, b));
                if (!p) { pen = false; continue; }
                if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; }
                else ctx.lineTo(p[0], p[1]);
            }
            ctx.stroke();
        };

        // Meridians
        for (let lon = -180; lon <= 180; lon += stepLon) {
            stroke(-89, 89, (lat) => toPixel(lon, lat));
        }
        // Parallels
        for (let lat = -80; lat <= 80; lat += stepLat) {
            stroke(-180, 180, (lon) => toPixel(lon, lat));
        }

        // Labels at cell centers
        for (let lon = -180; lon < 180; lon += stepLon) {
            for (let lat = -80; lat < 80; lat += stepLat) {
                const midLon = lon + stepLon / 2;
                const midLat = lat + stepLat / 2;
                const p = toPixel(midLon, midLat);
                if (!p || p[0] < 0 || p[0] > size[0] || p[1] < 0 || p[1] > size[1]) continue;
                ctx.fillText(this.getGridLabel([midLon, midLat], level), p[0], p[1]);
            }
        }
    }
}

export default MaidenheadSource;

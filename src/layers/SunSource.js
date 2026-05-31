import ImageCanvasSource from 'ol/source/ImageCanvas';
import * as olProj from 'ol/proj';
import * as olExtent from 'ol/extent';

class SunSource extends ImageCanvasSource {
    constructor(options = {}) {
        super({
            attributions: options.attributions,
            projection: options.projection || "EPSG:3857",
            resolutions: options.resolutions,
            state: options.state,
            canvasFunction: (extent, resolution, pixelRatio, size, projection) => {
                return this.doRender(extent, resolution, pixelRatio, size, projection);
            }
        });

        this.canvasElement_ = document.createElement('canvas');
        this.obscureFactor = options.obscureFactor || 0.65;
        this.getCurrentTime = options.getCurrentTime || (() => Date.now());

        // Per-pixel inverse projection: 0 = Web Mercator, 1 = azimuthal
        // equidistant, 2 = Lambert azimuthal equal-area. The azimuthal
        // variants are centered on (centerLat, centerLon), in radians.
        this.projType = options.projType || 0;
        this.centerLat = (options.centerLat || 0) * Math.PI / 180;
        this.centerLon = (options.centerLon || 0) * Math.PI / 180;
        this.earthRadius = options.earthRadius || 6378137;

        this.initializeWebGL();
    }

    setObscureFactor(factor) {
        this.obscureFactor = factor;
        this.changed();
    }

    setProjectionParams(projType, centerLatDeg, centerLonDeg) {
        this.projType = projType;
        this.centerLat = (centerLatDeg || 0) * Math.PI / 180;
        this.centerLon = (centerLonDeg || 0) * Math.PI / 180;
        this.changed();
    }

    initializeWebGL() {
        const gl = this.canvasElement_.getContext('webgl', { alpha: true, preserveDrawingBuffer: true });
        if (!gl) return;

        this.gl = gl;
        this.createShaderProgram();
        this.initBuffers();
    }

    createShaderProgram() {
        const gl = this.gl;
        const vertexSrc = `
            attribute vec2 a_position;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0, 1);
                v_texCoord = a_position * 0.5 + 0.5;
            }
        `;

        const fragmentSrc = `
            precision highp float;
            varying vec2 v_texCoord;
            uniform vec2 u_resolution;
            uniform vec4 u_extent; // minX, minY, maxX, maxY
            uniform float u_fEquationRad;
            uniform float u_fDeclination;
            uniform float u_fLocalTimeRad;
            uniform float u_obscureFactor;
            uniform float u_projType;   // 0 mercator, 1 aeqd, 2 laea
            uniform float u_lat0;       // azimuthal center, radians
            uniform float u_lon0;
            uniform float u_radius;     // earth radius, metres

            const float fTwilight = 0.018;
            const float PI_2 = 1.57079632679;

            // Simplified Mercator to Lat/Lon
            float yToLat(float y) {
                return 2.0 * atan(exp(y)) - PI_2;
            }

            void main() {
                // Map v_texCoord to actual coordinate in the view projection extent.
                float x = u_extent.x + v_texCoord.x * (u_extent.z - u_extent.x);
                float y = u_extent.y + v_texCoord.y * (u_extent.w - u_extent.y);

                float lat;
                float lon;
                if (u_projType < 0.5) {
                    // Web Mercator inverse.
                    lon = x / u_radius;
                    lat = yToLat(y / u_radius);
                } else {
                    // Azimuthal inverse, centered on (u_lat0, u_lon0).
                    float rho = sqrt(x * x + y * y);
                    if (rho < 1.0) {
                        lat = u_lat0;
                        lon = u_lon0;
                    } else {
                        float c;
                        if (u_projType < 1.5) {
                            c = rho / u_radius;                              // aeqd
                        } else {
                            c = 2.0 * asin(clamp(rho / (2.0 * u_radius), -1.0, 1.0)); // laea
                        }
                        if (c > 3.14159265) {
                            // Beyond the antipode there is no ground to shade.
                            discard;
                        }
                        float sinc = sin(c);
                        float cosc = cos(c);
                        lat = asin(clamp(cosc * sin(u_lat0) + (y * sinc * cos(u_lat0)) / rho, -1.0, 1.0));
                        lon = u_lon0 + atan(x * sinc, rho * cos(u_lat0) * cosc - y * sin(u_lat0) * sinc);
                    }
                }

                float fSolarTimeRad = u_fLocalTimeRad + u_fEquationRad + lon;
                float cc = cos(u_fDeclination) * cos(lat);
                float t = (sin(u_fDeclination) * sin(lat)) - (cc * cos(fSolarTimeRad));
                float fAltitude = asin(clamp(t, -1.0, 1.0));

                float obs = 0.0;
                if (fAltitude < -fTwilight) {
                    obs = 1.0;
                } else if (fAltitude < fTwilight) {
                    obs = clamp(1.0 - (fAltitude + fTwilight) / (2.0 * fTwilight), 0.0, 1.0);
                }
                
                gl_FragColor = vec4(0.0, 0.0, 0.0, u_obscureFactor * obs);
            }
        `;

        const vs = this.compileShader(gl.VERTEX_SHADER, vertexSrc);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentSrc);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);
    }

    initBuffers() {
        const gl = this.gl;
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        const positions = [
            -1, -1,
            1, -1,
            -1, 1,
            -1, 1,
            1, -1,
            1, 1,
        ];
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    }

    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }

    doRender(extent, resolution, pixelRatio, size, projection) {
        const canvas = this.canvasElement_;
        if (canvas.width !== size[0] || canvas.height !== size[1]) {
            canvas.width = size[0];
            canvas.height = size[1];
        }

        const gl = this.gl;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const currentTime = this.getCurrentTime();
        const situation = this.getSituation(currentTime);

        gl.useProgram(this.program);

        const posLoc = gl.getAttribLocation(this.program, "a_position");
        gl.enableVertexAttribArray(posLoc);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.uniform2f(gl.getUniformLocation(this.program, "u_resolution"), canvas.width, canvas.height);
        gl.uniform4f(gl.getUniformLocation(this.program, "u_extent"), extent[0], extent[1], extent[2], extent[3]);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_fEquationRad"), situation.fEquationRad);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_fDeclination"), situation.fDeclination);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_fLocalTimeRad"), situation.fLocalTimeRad);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_obscureFactor"), this.obscureFactor);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_projType"), this.projType);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_lat0"), this.centerLat);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_lon0"), this.centerLon);
        gl.uniform1f(gl.getUniformLocation(this.program, "u_radius"), this.earthRadius);

        gl.drawArrays(gl.TRIANGLES, 0, 6);

        return canvas;
    }

    getSituation(currentTime) {
        const JD = (currentTime / 86400000) + 2440587.5;
        const D = JD - 2451545.0;
        const g = this.degToRad((357.529 + 0.98560028 * D) % 360);
        const q = this.degToRad((280.459 + 0.98564736 * D) % 360);
        const L = q + this.degToRad(1.915) * Math.sin(g) + this.degToRad(0.020) * Math.sin(2 * g);
        const e = this.degToRad(23.439 - 0.00000036 * D);
        const RA = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
        const d = Math.asin(Math.sin(e) * Math.sin(L));
        const EqT = q / this.degToRad(15) - (RA * 180 / Math.PI / 15);

        return {
            fDeclination: d,
            fEquationRad: (((EqT + 12) % 24 - 12) * Math.PI / 180.0) * 60.0 / 4.0,
            fLocalTimeRad: (currentTime % 86400000) / (1000 * 3600.0) * (Math.PI / 180.0) * 60.0 / 4.0
        };
    }

    degToRad(deg) { return deg * Math.PI / 180; }
}

export default SunSource;

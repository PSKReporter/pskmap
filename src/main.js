import 'bootstrap/dist/css/bootstrap.min.css';
import 'ol/ol.css';
import { Modal } from 'bootstrap';
import MapController from './MapController';
import MarkerManager from './MarkerManager';
import { parseLocator } from './utils/locator';
import { initBandmap, getBand, getColorForFreq, getColorsForBands, BAND_COLORS } from './utils/bands';

const BASE_URL = '';

document.addEventListener('DOMContentLoaded', async () => {
    const mapController = new MapController('map');
    const reccntSpan = document.getElementById('reccnt');
    const activeMonitorsSpan = document.getElementById('active-monitors');
    const goBtn = document.getElementById('go-btn');
    const infoBar = document.getElementById('info-bar');
    const monitoringStatus = document.getElementById('monitoring-status');
    const bandDistribution = document.getElementById('band-distribution');

    let currentCallsign = '';
    let refreshTimer = null;
    let lastReports = [];  // stored after each search for logbook/ADIF

    let currentReccnt = 0;
    let reccntRate = 0; // records per ms
    let lastReccntUpdate = Date.now();
    let lastDisplayedReccnt = 0;
    let lastDomWrite = 0;

    function updateReccnt(newTotal) {
        if (!newTotal) return;
        if (!currentReccnt) {
            currentReccnt = newTotal;
            lastDisplayedReccnt = Math.floor(currentReccnt);
            reccntSpan.textContent = lastDisplayedReccnt.toLocaleString();
            lastReccntUpdate = Date.now();
            return;
        }
        if (newTotal > currentReccnt) {
            reccntRate = (newTotal - currentReccnt) / 300000;
        }
    }

    function animateReccnt(now) {
        requestAnimationFrame(animateReccnt);
        if (reccntRate <= 0) return;
        const dt = Math.min(now - lastReccntUpdate, 1000);
        lastReccntUpdate = now;
        currentReccnt += reccntRate * dt;
        // Throttle DOM writes to 20fps — avoids triggering MutationObservers at 60fps
        if (now - lastDomWrite < 50) return;
        lastDomWrite = now;
        const display = Math.floor(currentReccnt);
        if (display !== lastDisplayedReccnt) {
            lastDisplayedReccnt = display;
            reccntSpan.textContent = display.toLocaleString();
        }
    }

    requestAnimationFrame(animateReccnt);

    // --- Helper Functions ---

    function escapeHTML(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatTimeAgo(seconds) {
        if (seconds < 60) return `${Math.floor(seconds)} seconds`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes`;
        return `${Math.floor(seconds / 3600)} hours`;
    }

    function calculateDistance(lat1, lon1, lat2, lon2, unit) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const d = R * c;
        // "auto" uses km for non-US/UK, miles for US/UK — here we approximate
        // by checking if unit is explicitly set; otherwise use km as the neutral default
        if (unit === 'miles') return (d * 0.621371).toFixed(0) + ' mi';
        return d.toFixed(0) + ' km';
    }

    function calculateBearing(lat1, lon1, lat2, lon2) {
        const toRad = d => d * Math.PI / 180;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
    }

    function updateBandDistribution(stats, total) {
        if (!stats) return;
        let html = '';
        const sortedBands = Object.entries(stats).sort(([, a], [, b]) => b - a);
        sortedBands.forEach(([band, count]) => {
            const color = BAND_COLORS[band] || '808080';
            html += `<span title="${escapeHTML(band)}" style="color: #${color}; border-left: 4px solid #${color}; padding-left: 4px; border-radius: 2px; font-weight: 500;">${count} on ${escapeHTML(band)}</span>`;
        });
        bandDistribution.innerHTML = html;
        activeMonitorsSpan.textContent = `There are ${total.toLocaleString()} active monitors:`;
    }

    async function updateGlobalStats() {
        try {
            const response = await fetch(`${BASE_URL}/api/monitor-stats`);
            const data = await response.json();
            if (data && data.stats) {
                updateBandDistribution(data.stats, data.total);
                infoBar.classList.remove('d-none');
            }
            if (data && data.lastSequenceNumber) {
                updateReccnt(data.lastSequenceNumber);
            }
        } catch (e) { console.error('Stats fetch failed', e); }
    }

    // --- Band & Mode Loading ---

    const loadBands = async () => {
        try {
            const response = await fetch(`${BASE_URL}/api/bands`);
            const bandsData = await response.json();
            if (bandsData) initBandmap(bandsData);
            const selectBand = document.getElementById('selectband');
            if (Array.isArray(bandsData)) {
                bandsData.forEach(item => {
                    const opt = document.createElement('option');
                    opt.value = item[0];
                    opt.textContent = item[0];
                    selectBand.appendChild(opt);
                });
            }
        } catch (e) { console.error('Error loading bands', e); }
    };

    const loadModes = async () => {
        try {
            const response = await fetch(`${BASE_URL}/api/modes`);
            const modesData = await response.json();
            const selectMode = document.getElementById('selectmode');
            if (Array.isArray(modesData.modes)) {
                selectMode.innerHTML = '<option value="all">All modes</option>';
                modesData.modes.forEach(item => {
                    const opt = document.createElement('option');
                    opt.value = item.mode;
                    opt.textContent = item.mode;
                    selectMode.appendChild(opt);
                });
            }
        } catch (e) { console.error('Error loading modes', e); }
    };

    // Wait for bands/modes before applying hash params so selects have their options
    await Promise.all([loadBands(), loadModes()]);

    // --- Permalink: read ---

    function readHashParams() {
        const hash = window.location.hash.slice(1);
        if (!hash) return null;
        try { return new URLSearchParams(hash); } catch { return null; }
    }

    function applyHashParamsToForm(params) {
        const set = (id, key) => {
            const val = params.get(key);
            if (val === null) return;
            const el = document.getElementById(id);
            if (el) el.value = val;
        };
        set('callsign', 'callsign');
        set('selectband', 'band');
        set('selectmode', 'mode');
        set('selecttimerange', 'timerange');
        set('selecttxrx', 'txrx');
        set('selectwhat', 'what');
        set('selectsigs', 'sigs');
    }

    function applyHashParamsToOptions(params, options) {
        Object.keys(DEFAULT_OPTIONS).forEach(key => {
            const val = params.get(key);
            if (val === null) return;
            if (typeof DEFAULT_OPTIONS[key] === 'boolean') {
                options[key] = val === '1' || val === 'true';
            } else if (typeof DEFAULT_OPTIONS[key] === 'number') {
                options[key] = parseFloat(val);
            } else {
                options[key] = val;
            }
        });
        // Sync to form elements
        Object.keys(options).forEach(key => {
            const el = document.getElementById(key);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = options[key];
            else el.value = options[key];
        });
    }

    // --- Permalink: write ---

    document.getElementById('permalink').addEventListener('click', (e) => {
        e.preventDefault();
        const params = new URLSearchParams();
        params.set('callsign', document.getElementById('callsign').value);
        params.set('band', document.getElementById('selectband').value);
        params.set('mode', document.getElementById('selectmode').value);
        params.set('timerange', document.getElementById('selecttimerange').value);
        params.set('txrx', document.getElementById('selecttxrx').value);
        params.set('what', document.getElementById('selectwhat').value);
        params.set('sigs', document.getElementById('selectsigs').value);
        Object.entries(currentOptions).forEach(([k, v]) => params.set(k, String(v)));
        const vs = mapController.getViewState();
        if (vs) params.set('mapCenter', `${vs.lat.toFixed(4)},${vs.lng.toFixed(4)},${vs.zoom.toFixed(2)}`);
        window.location.hash = params.toString();
        navigator.clipboard?.writeText(window.location.href).catch(() => {});
    });

    // --- Display Options ---

    const DEFAULT_OPTIONS = {
        'show-grid': false,
        'show-night': true,
        'night-for-spot': false,
        'hide-faint': false,
        'hide-no-reports': false,
        'show-tx': false,
        'show-snr': false,
        'suppress-bad-qrg': false,
        'hide-lines': false,
        'lines-always': false,
        'no-auto-pan': false,
        'hide-time': false,
        'hide-stats': false,
        'hide-max': false,
        'tx-filter': 'all',
        'worked-timeout': 'none',
        'sparkly-minutes': 10,
        'dist-unit': 'auto',
        'night-darkness': 0.65,
        'projection': 'mercator'
    };

    function loadOptions() {
        const saved = localStorage.getItem('psk-options');
        const options = saved ? { ...DEFAULT_OPTIONS, ...JSON.parse(saved) } : { ...DEFAULT_OPTIONS };
        Object.keys(options).forEach(key => {
            const el = document.getElementById(key);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = options[key];
            else el.value = options[key];
        });
        return options;
    }

    function saveOptions() {
        const options = {};
        Object.keys(DEFAULT_OPTIONS).forEach(key => {
            const el = document.getElementById(key);
            if (!el) return;
            options[key] = el.type === 'checkbox' ? el.checked : el.value;
        });
        localStorage.setItem('psk-options', JSON.stringify(options));
        return options;
    }

    function applyOptions(options) {
        mapController.setLayerVisibility('grid', options['show-grid']);
        mapController.setLayerVisibility('sun', options['show-night']);

        mapController.setObscureFactor(parseFloat(options['night-darkness']));

        mapController.setNightForSpot(options['night-for-spot']);

        MarkerManager.setShowSNR(options['show-snr']);
        MarkerManager.setWorkedTimeout(options['worked-timeout']);
        MarkerManager.setSparklyMinutes(parseInt(options['sparkly-minutes']));

        mapController.setHideLines(options['hide-lines']);
        mapController.setLinesAlways(options['lines-always']);

        const statsBar = document.getElementById('stats-bar');
        const header = document.querySelector('header');
        const footer = document.querySelector('footer');

        if (options['hide-max']) {
            header?.classList.add('d-none');
            footer?.classList.add('d-none');
            statsBar?.classList.add('d-none');
            infoBar?.classList.add('d-none');
            document.getElementById('floating-options')?.classList.remove('d-none');
        } else {
            header?.classList.remove('d-none');
            footer?.classList.remove('d-none');
            document.getElementById('floating-options')?.classList.add('d-none');
            if (!options['hide-stats']) statsBar?.classList.remove('d-none');
            else statsBar?.classList.add('d-none');
        }
    }

    // Apply hash params first, then saved options (hash takes precedence)
    const hashParams = readHashParams();
    let currentOptions = loadOptions();
    if (hashParams) {
        applyHashParamsToForm(hashParams);
        applyHashParamsToOptions(hashParams, currentOptions);
    }
    applyOptions(currentOptions);

    const optionsLink = document.getElementById('show-options');
    const optionsEl = document.getElementById('optionsModal');
    const optionsModal = new Modal(optionsEl);
    const saveOptionsBtn = document.getElementById('save-options');

    const openOptionsModal = (e) => { e?.preventDefault(); optionsModal.show(); };
    optionsLink.addEventListener('click', openOptionsModal);
    document.getElementById('floating-options').addEventListener('click', openOptionsModal);

    saveOptionsBtn.addEventListener('click', () => {
        currentOptions = saveOptions();
        applyOptions(currentOptions);
        performSearch();
        optionsModal.hide();
    });

    // --- Monitor Display ---

    const showMonitors = async () => {
        const response = await fetch(`${BASE_URL}/api/monitors/full`);
        const data = await response.json();
        mapController.clearMarkers();
        data.monitors.forEach(monitor => {
            let coords = parseLocator(monitor.locator);
            mapController.addMarker(coords[0], coords[1], {
                color: getColorsForBands(monitor.bands.split(',')),
                marking: 'monitor',
                isLarge: true,
                data: monitor
            });
        });
    };

    // --- Callsign Input Validation ---

    const callsignInput = document.getElementById('callsign');
    callsignInput.addEventListener('input', () => {
        const filtered = callsignInput.value.toUpperCase().replace(/[^A-Z0-9\/\-]/g, '');
        if (filtered !== callsignInput.value) callsignInput.value = filtered;
    });
    callsignInput.addEventListener('keypress', (e) => {
        if (e.key.length === 1 && !/^[A-Za-z0-9\/\-]$/.test(e.key)) e.preventDefault();
    });

    // --- Search ---

    const performSearch = async () => {
        const callsign = document.getElementById('callsign').value.trim() || 'ZZZZZ';
        const band = document.getElementById('selectband').value;
        const mode = document.getElementById('selectmode').value;
        const timerange = document.getElementById('selecttimerange').value;
        const txrx = document.getElementById('selecttxrx').value;
        const what = document.getElementById('selectwhat').value;
        const sigs = document.getElementById('selectsigs').value;

        currentCallsign = callsign;
        goBtn.disabled = true;
        goBtn.textContent = 'Searching...';

        try {
            const rronly = currentOptions['show-tx'] ? '' : '&rronly=1';
            let query = `flowStartSeconds=-${timerange}&statistics=1&json=1${rronly}&statistics=1`;

            if (txrx === 'rx') {
                query += `&receiverCallsign=${encodeURIComponent(callsign)}`;
            } else if (txrx === 'tx') {
                query += `&senderCallsign=${encodeURIComponent(callsign)}`;
            } else {
                query += `&callsign=${encodeURIComponent(callsign)}`;
            }

            if (what && what !== 'callsign') query += `&modify=${what}`;
            if (sigs === 'ctry') query += `&uctry=1`;
            if (band && band !== 'all') query += `&band=${band}`;
            if (mode && mode !== 'all') query += `&mode=${mode}`;

            const response = await fetch(`${BASE_URL}/cgi-bin/pskquery5.pl?${query}`);
            const data = await response.json();

            infoBar.classList.remove('d-none');

            const reports = data ? (data.receptionReport || data.receptionReports || []) : [];
            let latestReportTime = 0;
            let enteredCallsignLoc = null;
            const enrichedReports = [];
            // Markers/lines are collected first, then placed once the projection
            // (centered on the entered callsign) is settled — projecting them up
            // front would use the previous projection's center.
            const markerSpecs = [];
            const lineSpecs = [];

            reports.forEach(rx => {
                // Suppress bad QRG
                if (currentOptions['suppress-bad-qrg'] && (!rx.frequency || getBand(rx.frequency) === 'unknown')) return;

                // tx-filter: only show markers with LoTW/eQSL as selected
                const txFilter = currentOptions['tx-filter'];
                if (txFilter !== 'all') {
                    const hasLotw = rx.lotw == '1' || rx.senderLotwUpload;
                    const hasEqsl = rx.eqsl == '1' || rx.senderEqslAuthGuar === 'A';
                    if (txFilter === 'lotw' && !hasLotw) return;
                    if (txFilter === 'eqsl' && !hasEqsl) return;
                    if (txFilter === 'lotw-eqsl' && !hasLotw && !hasEqsl) return;
                }

                let loc = null;
                let otherLoc = null;
                if (txrx === 'rx') {
                    loc = rx.senderLocator;
                    otherLoc = rx.receiverLocator;
                } else if (txrx === 'tx') {
                    loc = rx.receiverLocator;
                    otherLoc = rx.senderLocator;
                } else {
                    if (callsign && rx.receiverCallsign && rx.receiverCallsign.toUpperCase() === callsign.toUpperCase()) {
                        loc = rx.senderLocator;
                        otherLoc = rx.receiverLocator;
                    } else {
                        loc = rx.receiverLocator || rx.senderLocator || rx.locator;
                        otherLoc = rx.senderLocator || rx.receiverLocator;
                    }
                }

                let coords = parseLocator(loc);
                let lat = coords ? coords[1] : NaN;
                let lng = coords ? coords[0] : NaN;

                if (isNaN(lat) || isNaN(lng)) {
                    lat = parseFloat(rx.senderLat || rx.receiverLat || rx.lat);
                    lng = parseFloat(rx.senderLng || rx.receiverLng || rx.lng);
                }

                if (!isNaN(lat) && !isNaN(lng)) {
                    let isLarge = false;
                    if (callsign && txrx === 'rx') {
                        isLarge = false;
                        if (!enteredCallsignLoc) {
                            const oCoords = parseLocator(otherLoc);
                            let oLat = oCoords ? oCoords[1] : parseFloat(rx.receiverLat || rx.lat);
                            let oLng = oCoords ? oCoords[0] : parseFloat(rx.receiverLng || rx.lng);
                            if (!isNaN(oLat) && !isNaN(oLng)) {
                                enteredCallsignLoc = { lng: oLng, lat: oLat, data: { ...rx, receiverCallsign: callsign, receiverLocator: otherLoc } };
                            }
                        }
                    } else if (callsign && txrx === 'tx') {
                        isLarge = true;
                        if (!enteredCallsignLoc) {
                            const oCoords = parseLocator(otherLoc);
                            let oLat = oCoords ? oCoords[1] : parseFloat(rx.senderLat || rx.lat);
                            let oLng = oCoords ? oCoords[0] : parseFloat(rx.senderLng || rx.lng);
                            if (!isNaN(oLat) && !isNaN(oLng)) {
                                enteredCallsignLoc = { lng: oLng, lat: oLat, data: { ...rx, senderCallsign: callsign, senderLocator: otherLoc } };
                            }
                        }
                    } else if (callsign && (txrx === 'all' || !txrx)) {
                        isLarge = false;
                        if (!enteredCallsignLoc) {
                            const oCoords = parseLocator(otherLoc);
                            let oLat = oCoords ? oCoords[1] : NaN;
                            let oLng = oCoords ? oCoords[0] : NaN;
                            if (isNaN(oLat)) oLat = parseFloat(rx.receiverCallsign?.toUpperCase() === callsign.toUpperCase() ? rx.receiverLat : rx.senderLat) || rx.lat;
                            if (isNaN(oLng)) oLng = parseFloat(rx.receiverCallsign?.toUpperCase() === callsign.toUpperCase() ? rx.receiverLng : rx.senderLng) || rx.lng;
                            if (!isNaN(oLat) && !isNaN(oLng)) {
                                enteredCallsignLoc = { lng: oLng, lat: oLat, data: { ...rx } };
                            }
                        }
                    }

                    const markerColor = rx.color || getColorForFreq(rx.frequency);
                    const senderCoords = parseLocator(rx.senderLocator);
                    const receiverCoords = parseLocator(rx.receiverLocator);
                    const markerData = {
                        ...rx,
                        color: markerColor,
                        ...(senderCoords && { senderLng: senderCoords[0], senderLat: senderCoords[1] }),
                        ...(receiverCoords && { receiverLng: receiverCoords[0], receiverLat: receiverCoords[1] })
                    };
                    enrichedReports.push(markerData);

                    markerSpecs.push({
                        lng, lat,
                        options: {
                            color: markerColor,
                            marking: rx.lotw == '1' ? 'lotw' : (rx.eqsl == '1' ? 'eqsl' : null),
                            isLarge,
                            data: markerData
                        }
                    });

                    if (currentOptions['lines-always']) {
                        const otherCoords = parseLocator(otherLoc);
                        if (otherCoords) {
                            lineSpecs.push({ lng, lat, oLng: otherCoords[0], oLat: otherCoords[1], color: markerColor });
                        }
                    }

                    const time = parseInt(rx.flowStartSeconds || rx.lastSenderTime);
                    if (time > latestReportTime) latestReportTime = time;
                }
            });

            lastReports = enrichedReports;

            // Settle the projection before placing markers. Azimuthal modes
            // center on the entered callsign's locator (falling back to the
            // first marker, then the current view center).
            const projKind = currentOptions['projection'] || 'mercator';
            let projCenter = null;
            if (enteredCallsignLoc) projCenter = [enteredCallsignLoc.lng, enteredCallsignLoc.lat];
            else if (markerSpecs.length) projCenter = [markerSpecs[0].lng, markerSpecs[0].lat];
            else { const vs = mapController.getViewState(); if (vs) projCenter = [vs.lng, vs.lat]; }
            mapController.setProjection(projKind, projCenter);

            mapController.clearMarkers();
            markerSpecs.forEach(m => mapController.addMarker(m.lng, m.lat, m.options));
            lineSpecs.forEach(l => mapController.addLine(l.lng, l.lat, l.oLng, l.oLat, l.color));

            if (!reports.length) {
                await showMonitors();
            }

            updateReccnt(data.lastSequenceNumber);

            if (enteredCallsignLoc && callsign) {
                const isLargeEntered = txrx === 'rx' || txrx === 'all' || !txrx;
                const d = enteredCallsignLoc.data;
                const color = d.color || getColorForFreq(d.frequency);
                mapController.addMarker(enteredCallsignLoc.lng, enteredCallsignLoc.lat, {
                    color,
                    marking: d.lotw == '1' ? 'lotw' : (d.eqsl == '1' ? 'eqsl' : null),
                    isLarge: isLargeEntered,
                    data: { ...d, isEnteredCallsign: true }
                });
            }

            // Auto pan/zoom to fit markers
            if (!currentOptions['no-auto-pan']) {
                mapController.fitToMarkers();
            }

            // Night-for-spot: base the shadow on the latest report; hovering a
            // spot temporarily shifts it to that spot's time (see MapController).
            if (currentOptions['night-for-spot'] && latestReportTime > 0) {
                mapController.setSunBaseTime(latestReportTime * 1000);
            }

            // Update monitoring status
            let statusHtml = `Monitoring <strong>${escapeHTML(callsign === 'ZZZZZ' ? 'anyone' : callsign)}</strong>`;
            if (latestReportTime > 0) {
                const ago = (Date.now() / 1000) - latestReportTime;
                statusHtml += ` (last report ${formatTimeAgo(ago)} ago).`;
            }
            statusHtml += ` Automatic refresh in 5 minutes.`;

            if (data.statistics) {
                const s = data.statistics;
                const markerType = txrx === 'rx' ? 'transmitters' : (txrx === 'tx' ? 'receivers' : 'stations');
                statusHtml += `<br>Markers are the ${reports.length} ${markerType}`;
                if (callsign && callsign !== 'ZZZZZ') {
                    statusHtml += txrx === 'rx' ? ` heard at ${escapeHTML(callsign)}` : (txrx === 'tx' ? ` seen by ${escapeHTML(callsign)}` : ` associated with ${escapeHTML(callsign)}`);
                }
                if (s.day) {
                    statusHtml += ` (${s.day.reports || 0} reports, ${s.day.countries || 0} countries last 24h`;
                    if (s.week) statusHtml += `; ${s.week.reports || 0} reports, ${s.week.countries || 0} countries last week`;
                    statusHtml += `).`;
                }
            }
            monitoringStatus.innerHTML = statusHtml;

            // Show logbook link once we have reports
            if (enrichedReports.length > 0) {
                document.getElementById('show-logbook').classList.remove('d-none');
            }

            // Restore map position from permalink (overrides auto-fit)
            if (hashParams?.has('mapCenter')) {
                const parts = hashParams.get('mapCenter').split(',');
                if (parts.length === 3) {
                    mapController.setViewState(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
                }
                // Only apply once on first load
                hashParams.delete('mapCenter');
            }

        } catch (error) {
            console.error('Search failed', error);
        } finally {
            goBtn.disabled = false;
            goBtn.textContent = 'Go!';
        }
    };

    // Initial search
    performSearch();

    let lastSearchTime = Date.now();
    goBtn.addEventListener('click', () => {
        performSearch();
        lastSearchTime = Date.now();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(() => {
            if (!document.hidden) {
                performSearch();
                lastSearchTime = Date.now();
            }
        }, 300000);
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            if (refreshTimer && Date.now() - lastSearchTime > 300000) {
                performSearch();
                lastSearchTime = Date.now();
            }
            updateGlobalStats();
        }
    });

    updateGlobalStats();
    setInterval(() => { if (!document.hidden) updateGlobalStats(); }, 60000);

    // --- Infobox ---

    mapController.onPopupRequest = (props) => {
        const isMonitor = !props.senderCallsign;
        const unit = currentOptions['dist-unit'];

        // Each entry is one line; `main` is normal text, `sub` is muted/small.
        // Building discrete <div>s (rather than <br>-separated text mixed with
        // block-level <small>s) avoids the stray blank lines the old layout had.
        const rows = [];
        const main = (h) => { if (h) rows.push(`<div class="pk-row">${h}</div>`); };
        const sub = (h) => { if (h) rows.push(`<div class="pk-sub">${h}</div>`); };

        // Clickable callsign link: clicking re-searches for that callsign
        const txLink = (cs) => `<a href="#" class="psk-cs-link" data-cs="${escapeHTML(cs)}" data-txrx="tx">${escapeHTML(cs)}</a>`;
        const rxLink = (cs) => `<a href="#" class="psk-cs-link" data-cs="${escapeHTML(cs)}" data-txrx="rx">${escapeHTML(cs)}</a>`;
        const loc = (l) => l ? ` <span class="text-muted">${escapeHTML(l)}</span>` : '';

        if (isMonitor) {
            const callsign = escapeHTML(props.callsign || props.receiverCallsign || 'Unknown');
            const locator = props.locator || props.receiverLocator || '';
            main(`<strong>Monitor ${callsign}</strong>${loc(locator)}`);
            sub(escapeHTML(props.regionName || props.region || props.DXCC || props.receiverDXCC || ''));
            sub(escapeHTML(props.decoderSoftware || ''));
        } else {
            const senderCs = props.senderCallsign || '';
            const receiverCs = props.receiverCallsign || '';

            // Path: transmitter heard by receiver.
            main(`<strong>${txLink(senderCs)}</strong>${loc(props.senderLocator)}`);
            if (receiverCs) main(`heard by ${rxLink(receiverCs)}${loc(props.receiverLocator)}`);
            sub(escapeHTML(props.senderDXCC || ''));

            // Distance + bearing (from receiver to sender)
            const sLat = parseFloat(props.senderLat);
            const sLon = parseFloat(props.senderLng);
            const rLat = parseFloat(props.receiverLat);
            const rLon = parseFloat(props.receiverLng);
            if (!isNaN(sLat) && !isNaN(sLon) && !isNaN(rLat) && !isNaN(rLon)) {
                const dist = calculateDistance(sLat, sLon, rLat, rLon, unit);
                const bearing = calculateBearing(rLat, rLon, sLat, sLon);
                sub(`${dist} &middot; bearing ${bearing}&deg;`);
            }

            // Frequency / mode / SNR on a single line.
            const sig = [];
            if (props.frequency) sig.push(`${(parseFloat(props.frequency) / 1000000).toFixed(3)} MHz`);
            if (props.mode) sig.push(escapeHTML(props.mode));
            const snr = props.sNR ?? props.snr;
            if (snr != null) sig.push(`SNR ${snr >= 0 ? '+' : ''}${snr} dB`);
            main(sig.join(' &middot; '));

            // Timestamp
            const timestamp = props.flowStartSeconds || props.lastSenderTime;
            if (timestamp) sub(new Date(timestamp * 1000).toUTCString());

            // Receiver station details
            if (props.receiverDecoderSoftware) sub(`Using ${escapeHTML(props.receiverDecoderSoftware)}`);
            if (props.receiverAntennaInformation) sub(`Antenna: ${escapeHTML(props.receiverAntennaInformation)}`);
            if (props.receiverRigInformation) sub(`Rig: ${escapeHTML(props.receiverRigInformation)}`);

            // QSL info
            if (props.senderLotwUpload) {
                const d = new Date(props.senderLotwUpload.replace(/-/g, '/'));
                sub(`Last LoTW upload: ${escapeHTML(d.toDateString())}`);
            }
            if (props.senderEqslAuthGuar === 'A') sub('eQSL Authenticity Guaranteed');
            if (props.worked) {
                const wd = new Date(props.worked * 1000);
                const band = props.workedFrequency ? ` (${escapeHTML(getBand(props.workedFrequency))})` : '';
                sub(`Worked: ${escapeHTML(wd.toUTCString())}${band}`);
            }
        }

        return rows.join('');
    };

    // Event delegation for callsign links in popup
    document.getElementById('popup-content').addEventListener('click', (e) => {
        const target = e.target.closest('.psk-cs-link');
        if (!target) return;
        e.preventDefault();
        const cs = target.dataset.cs;
        const txrx = target.dataset.txrx;
        document.getElementById('callsign').value = cs;
        document.getElementById('selecttxrx').value = txrx;
        document.getElementById('selectwhat').value = 'callsign';
        mapController.hidePopup();
        performSearch();
        lastSearchTime = Date.now();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(() => {
            if (!document.hidden) { performSearch(); lastSearchTime = Date.now(); }
        }, 300000);
    });

    // --- Logbook Panel ---

    let logbookSortState = { col: 'time', dir: -1 }; // newest first

    function renderLogbook() {
        const tbody = document.getElementById('logbook-tbody');
        if (!tbody) return;

        const sorted = [...lastReports].sort((a, b) => {
            let va, vb;
            switch (logbookSortState.col) {
                case 'time':        va = a.flowStartSeconds || 0;   vb = b.flowStartSeconds || 0;   break;
                case 'sender':      va = a.senderCallsign || '';     vb = b.senderCallsign || '';    break;
                case 'senderLoc':   va = a.senderLocator || '';      vb = b.senderLocator || '';     break;
                case 'receiver':    va = a.receiverCallsign || '';   vb = b.receiverCallsign || '';  break;
                case 'receiverLoc': va = a.receiverLocator || '';    vb = b.receiverLocator || '';   break;
                case 'freq':        va = a.frequency || 0;           vb = b.frequency || 0;          break;
                case 'mode':        va = a.mode || '';               vb = b.mode || '';              break;
                case 'snr':         va = a.sNR ?? -999;              vb = b.sNR ?? -999;             break;
                case 'dist':        va = _distForSort(a);            vb = _distForSort(b);           break;
                default:            va = 0; vb = 0;
            }
            if (va < vb) return -logbookSortState.dir;
            if (va > vb) return logbookSortState.dir;
            return 0;
        });

        const unit = currentOptions['dist-unit'];
        tbody.innerHTML = sorted.map(r => {
            const ts = r.flowStartSeconds || r.lastSenderTime || 0;
            const dt = new Date(ts * 1000);
            const timeStr = ts ? dt.toUTCString().replace(' GMT', '') : '';
            const freq = r.frequency ? (r.frequency / 1000000).toFixed(3) : '';
            const snr = r.sNR != null ? (r.sNR >= 0 ? `+${r.sNR}` : String(r.sNR)) : '';

            let dist = '';
            const sLat = parseFloat(r.senderLat), sLon = parseFloat(r.senderLng);
            const rLat = parseFloat(r.receiverLat), rLon = parseFloat(r.receiverLng);
            if (!isNaN(sLat) && !isNaN(sLon) && !isNaN(rLat) && !isNaN(rLon)) {
                dist = calculateDistance(sLat, sLon, rLat, rLon, unit);
            }

            const sender = escapeHTML(r.senderCallsign || '');
            const receiver = escapeHTML(r.receiverCallsign || '');
            return `<tr>
                <td class="text-nowrap">${escapeHTML(timeStr)}</td>
                <td><a href="#" class="psk-cs-link text-info" data-cs="${sender}" data-txrx="tx">${sender}</a></td>
                <td>${escapeHTML(r.senderLocator || '')}</td>
                <td><a href="#" class="psk-cs-link text-info" data-cs="${receiver}" data-txrx="rx">${receiver}</a></td>
                <td>${escapeHTML(r.receiverLocator || '')}</td>
                <td>${escapeHTML(freq)}</td>
                <td>${escapeHTML(r.mode || '')}</td>
                <td>${escapeHTML(snr)}</td>
                <td>${escapeHTML(dist)}</td>
            </tr>`;
        }).join('');

        document.getElementById('logbook-count').textContent = `(${sorted.length} records)`;

        // Update sort indicator on headers
        document.querySelectorAll('#logbook-table th.sortable').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
            if (th.dataset.col === logbookSortState.col) {
                th.classList.add(logbookSortState.dir === 1 ? 'sort-asc' : 'sort-desc');
            }
        });
    }

    function _distForSort(r) {
        const sLat = parseFloat(r.senderLat), sLon = parseFloat(r.senderLng);
        const rLat = parseFloat(r.receiverLat), rLon = parseFloat(r.receiverLng);
        if (isNaN(sLat) || isNaN(sLon) || isNaN(rLat) || isNaN(rLon)) return -1;
        const dLat = (rLat - sLat) * Math.PI / 180;
        const dLon = (rLon - sLon) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(sLat * Math.PI / 180) * Math.cos(rLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    document.getElementById('show-logbook').addEventListener('click', (e) => {
        e.preventDefault();
        const panel = document.getElementById('logbook-panel');
        panel.classList.remove('d-none');
        renderLogbook();
    });

    document.getElementById('close-logbook').addEventListener('click', () => {
        document.getElementById('logbook-panel').classList.add('d-none');
    });

    document.getElementById('logbook-table').addEventListener('click', (e) => {
        const th = e.target.closest('th.sortable');
        if (!th) return;
        const col = th.dataset.col;
        if (logbookSortState.col === col) {
            logbookSortState.dir *= -1;
        } else {
            logbookSortState = { col, dir: 1 };
        }
        renderLogbook();
    });

    // Event delegation for callsign links inside logbook
    document.getElementById('logbook-tbody').addEventListener('click', (e) => {
        const target = e.target.closest('.psk-cs-link');
        if (!target) return;
        e.preventDefault();
        document.getElementById('callsign').value = target.dataset.cs;
        document.getElementById('selecttxrx').value = target.dataset.txrx;
        document.getElementById('selectwhat').value = 'callsign';
        document.getElementById('logbook-panel').classList.add('d-none');
        performSearch();
        lastSearchTime = Date.now();
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(() => {
            if (!document.hidden) { performSearch(); lastSearchTime = Date.now(); }
        }, 300000);
    });

    // --- ADIF Download ---

    document.getElementById('adif-download').addEventListener('click', (e) => {
        e.preventDefault();
        let adif = '<ADIF_VER:5>3.1.0 <PROGRAMID:10>PSKReporter <EOH>\n';
        const field = (name, val) => {
            if (val == null || val === '') return '';
            const s = String(val);
            return `<${name}:${s.length}>${s} `;
        };
        lastReports.forEach(r => {
            if (!r.senderCallsign || !r.receiverCallsign) return;
            const ts = r.flowStartSeconds || r.lastSenderTime;
            if (!ts) return;
            const dt = new Date(ts * 1000);
            const date = dt.toISOString().slice(0, 10).replace(/-/g, '');
            const time = dt.toISOString().slice(11, 19).replace(/:/g, '');
            const bandName = getBand(r.frequency).toUpperCase();
            const freq = r.frequency ? (r.frequency / 1000000).toFixed(6) : '';
            adif += field('CALL', r.senderCallsign);
            adif += field('BAND', bandName !== 'UNKNOWN' ? bandName : '');
            adif += field('MODE', r.mode);
            adif += field('QSO_DATE', date);
            adif += field('TIME_ON', time);
            adif += field('FREQ', freq);
            adif += field('GRIDSQUARE', r.senderLocator);
            adif += field('MY_GRIDSQUARE', r.receiverLocator);
            if (r.sNR != null) adif += field('RST_RCVD', String(r.sNR));
            adif += '<EOR>\n';
        });
        const blob = new Blob([adif], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `pskmap-${new Date().toISOString().slice(0, 10)}.adif`;
        a.click();
        URL.revokeObjectURL(url);
    });

    window.addEventListener('resize', () => mapController.map.updateSize());
});

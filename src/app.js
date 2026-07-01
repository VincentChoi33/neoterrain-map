(function () {
  const DEFAULT_CENTER = [37.6865, 127.408];
  const METERS_PER_LAT = 111320;
  const SAM_API_STORAGE = "neoterrain_sam_api";
  const DEFAULT_SAM_API_URL = "https://arg-founder-production-attended.trycloudflare.com/sam/roi";
  const MAX_SAM_GRID_N = 500;
  const TARGET_CELL_M = 10;
  const ESRI_IMAGERY =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const ESRI_ATTRIBUTION =
    "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community";

  const state = {
    mode: "inspect",
    aoi: null,
    features: [],
    selectedFeatureId: null,
    opacity: 0.62,
    useReasonColors: true,
    samApiUrl: localStorage.getItem(SAM_API_STORAGE) || DEFAULT_SAM_API_URL,
    samStatus: "idle",
    analysisBusy: false,
    lastSamGrid: null
  };

  const el = {
    aoiStatus: document.getElementById("aoiStatus"),
    analysisStatus: document.getElementById("analysisStatus"),
    featureCount: document.getElementById("featureCount"),
    featureDetail: document.getElementById("featureDetail"),
    drawAoiBtn: document.getElementById("drawAoiBtn"),
    screenAoiBtn: document.getElementById("screenAoiBtn"),
    runAnalysisBtn: document.getElementById("runAnalysisBtn"),
    demoAnalysisBtn: document.getElementById("demoAnalysisBtn"),
    exportGeoJsonBtn: document.getElementById("exportGeoJsonBtn"),
    exportJsonBtn: document.getElementById("exportJsonBtn"),
    samApiUrl: document.getElementById("samApiUrl"),
    saveSamApiBtn: document.getElementById("saveSamApiBtn"),
    checkSamApiBtn: document.getElementById("checkSamApiBtn"),
    samStatus: document.getElementById("samStatus"),
    noGoToggle: document.getElementById("noGoToggle"),
    uncertainToggle: document.getElementById("uncertainToggle"),
    reasonToggle: document.getElementById("reasonToggle"),
    opacityRange: document.getElementById("opacityRange"),
    opacityValue: document.getElementById("opacityValue"),
    aoiSize: document.getElementById("aoiSize"),
    toast: document.getElementById("toast")
  };

  const map = L.map("map", {
    zoomControl: false,
    minZoom: 6,
    maxZoom: 21
  }).setView(DEFAULT_CENTER, 15);

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer(ESRI_IMAGERY, {
    maxZoom: 21,
    attribution: ESRI_ATTRIBUTION
  }).addTo(map);

  const aoiLayer = L.layerGroup().addTo(map);
  const maskLayer = L.layerGroup().addTo(map);

  let dragStart = null;
  let previewRect = null;
  let suppressNextClick = false;

  function metersPerLng(lat) {
    return METERS_PER_LAT * Math.cos((lat * Math.PI) / 180);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function distanceMeters(a, b) {
    const radius = 6371008.8;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function boundsFromCenter(center, sizeKm) {
    const halfM = (sizeKm * 1000) / 2;
    const latPad = halfM / METERS_PER_LAT;
    const lngPad = halfM / metersPerLng(center.lat);
    return L.latLngBounds(
      [center.lat - latPad, center.lng - lngPad],
      [center.lat + latPad, center.lng + lngPad]
    );
  }

  function setAoi(bounds, source) {
    state.aoi = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
      source
    };
    state.features = [];
    state.selectedFeatureId = null;
    state.lastSamGrid = null;
    drawAoi();
    renderMasks();
    updateUi();
  }

  function aoiBounds() {
    if (!state.aoi) return null;
    return L.latLngBounds([state.aoi.south, state.aoi.west], [state.aoi.north, state.aoi.east]);
  }

  function drawAoi() {
    aoiLayer.clearLayers();
    const bounds = aoiBounds();
    if (!bounds) return;
    L.rectangle(bounds, {
      className: "aoi-rectangle",
      color: "#ffffff",
      weight: 2,
      opacity: 0.86,
      fill: false,
      interactive: false
    }).addTo(aoiLayer);
  }

  function setDrawMode(active) {
    state.mode = active ? "draw-aoi" : "inspect";
    map.getContainer().style.cursor = active ? "crosshair" : "";
    el.drawAoiBtn.textContent = active ? "AOI 지정 중" : "AOI 지정";
    el.drawAoiBtn.classList.toggle("active", active);
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  function setSamStatus(status, message) {
    state.samStatus = status;
    const labels = {
      idle: "대기",
      saved: "저장됨",
      checking: "확인중",
      ready: "연결됨",
      queued: "작업 생성",
      running: "추론중",
      polling: "결과 대기",
      completed: "완료",
      failed: "실패"
    };
    el.samStatus.textContent = message || labels[status] || status;
  }

  function setBusy(active, message) {
    state.analysisBusy = active;
    el.runAnalysisBtn.disabled = active;
    el.demoAnalysisBtn.disabled = active;
    el.checkSamApiBtn.disabled = active;
    el.analysisStatus.textContent = message || (active ? "분석중" : state.features.length ? "완료" : "대기");
    el.runAnalysisBtn.textContent = active ? "분석 중..." : "분석 실행";
  }

  function hash(seed) {
    const x = Math.sin(seed * 999.17) * 43758.5453123;
    return x - Math.floor(x);
  }

  function colorForReason(reason, severity) {
    if (severity === "uncertain") return "#76818d";
    if (!state.useReasonColors) return "#d93f3f";
    return {
      water: "#2f7fbb",
      steep_slope: "#d93f3f",
      structure: "#9b72d9",
      wet_ground: "#d88738",
      dense_vegetation: "#2f8f5a",
      shadow_unknown: "#77808c"
    }[reason] || "#d93f3f";
  }

  function reasonLabel(reason) {
    return {
      water: "수계/물",
      steep_slope: "급경사",
      structure: "구조물",
      wet_ground: "습지/연약지반",
      dense_vegetation: "고밀도 식생",
      shadow_unknown: "그림자/불확실"
    }[reason] || reason;
  }

  function polygonAround(bounds, cx, cy, rx, ry, wobble, points = 26) {
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const latSpan = bounds.getNorth() - south;
    const lngSpan = bounds.getEast() - west;
    const out = [];
    for (let i = 0; i < points; i++) {
      const a = (Math.PI * 2 * i) / points;
      const n = 1 + Math.sin(i * 1.7 + cx * 9.1) * wobble + Math.cos(i * 2.3 + cy * 7.4) * wobble * 0.55;
      const x = cx + Math.cos(a) * rx * n;
      const y = cy + Math.sin(a) * ry * n;
      out.push([
        south + Math.max(0.01, Math.min(0.99, y)) * latSpan,
        west + Math.max(0.01, Math.min(0.99, x)) * lngSpan
      ]);
    }
    return out;
  }

  function bandPolygon(bounds, offset, width, angle, phase) {
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const latSpan = bounds.getNorth() - south;
    const lngSpan = bounds.getEast() - west;
    const normal = [Math.cos(angle + Math.PI / 2), Math.sin(angle + Math.PI / 2)];
    const dir = [Math.cos(angle), Math.sin(angle)];
    const center = [0.5 + normal[0] * offset, 0.5 + normal[1] * offset];
    const left = [];
    const right = [];
    for (let i = -4; i <= 14; i++) {
      const t = i / 10;
      const bend = Math.sin(t * Math.PI * 2 + phase) * 0.035;
      const x = center[0] + dir[0] * (t - 0.5) + normal[0] * bend;
      const y = center[1] + dir[1] * (t - 0.5) + normal[1] * bend;
      left.push([y + normal[1] * width, x + normal[0] * width]);
      right.unshift([y - normal[1] * width, x - normal[0] * width]);
    }
    return left.concat(right).map(([y, x]) => [
      south + Math.max(0.01, Math.min(0.99, y)) * latSpan,
      west + Math.max(0.01, Math.min(0.99, x)) * lngSpan
    ]);
  }

  function featureMeta(id, reason, severity, confidence, geometry, extra = {}) {
    return {
      id,
      severity,
      reason,
      reasonLabel: reasonLabel(reason),
      confidence,
      source: extra.source || ["satellite_segmentation", "dem_inference"],
      geometry,
      properties: extra.properties || {}
    };
  }

  function generateAnalysis() {
    const bounds = aoiBounds();
    if (!bounds) {
      toast("먼저 AOI를 지정하세요.");
      return;
    }

    const center = bounds.getCenter();
    const seed = Math.abs(center.lat * 91.7 + center.lng * 53.3 + bounds.getNorth() * 11.9);
    const features = [];
    let id = 1;

    const waterCount = 1 + Math.floor(hash(seed + 1) * 2);
    for (let i = 0; i < waterCount; i++) {
      const poly = bandPolygon(bounds, hash(seed + 10 + i) * 0.55 - 0.28, 0.025 + hash(seed + 13 + i) * 0.025, hash(seed + 20 + i) * Math.PI, seed + i);
      features.push(featureMeta(`ng-${id++}`, "water", "blocked", 0.82 + hash(seed + i) * 0.13, poly, {
        properties: { note: "선형 수계 또는 저수면 후보" }
      }));
    }

    const steepCount = 3 + Math.floor(hash(seed + 30) * 4);
    for (let i = 0; i < steepCount; i++) {
      const poly = polygonAround(
        bounds,
        0.12 + hash(seed + 40 + i) * 0.76,
        0.12 + hash(seed + 50 + i) * 0.76,
        0.06 + hash(seed + 60 + i) * 0.08,
        0.035 + hash(seed + 70 + i) * 0.06,
        0.18
      );
      features.push(featureMeta(`ng-${id++}`, "steep_slope", "blocked", 0.74 + hash(seed + 80 + i) * 0.18, poly, {
        properties: { slopeDeg: Math.round(28 + hash(seed + 90 + i) * 24) }
      }));
    }

    const wetCount = 2 + Math.floor(hash(seed + 100) * 3);
    for (let i = 0; i < wetCount; i++) {
      const poly = polygonAround(
        bounds,
        0.1 + hash(seed + 110 + i) * 0.8,
        0.1 + hash(seed + 120 + i) * 0.8,
        0.035 + hash(seed + 130 + i) * 0.05,
        0.035 + hash(seed + 140 + i) * 0.05,
        0.24
      );
      features.push(featureMeta(`ng-${id++}`, "wet_ground", "blocked", 0.62 + hash(seed + 150 + i) * 0.2, poly, {
        properties: { note: "저지대/습윤 지표 후보" }
      }));
    }

    const structureCount = 2 + Math.floor(hash(seed + 200) * 4);
    for (let i = 0; i < structureCount; i++) {
      const poly = polygonAround(
        bounds,
        0.1 + hash(seed + 210 + i) * 0.8,
        0.1 + hash(seed + 220 + i) * 0.8,
        0.018 + hash(seed + 230 + i) * 0.025,
        0.018 + hash(seed + 240 + i) * 0.025,
        0.06,
        8
      );
      features.push(featureMeta(`ng-${id++}`, "structure", "blocked", 0.7 + hash(seed + 250 + i) * 0.21, poly, {
        source: ["satellite_segmentation"],
        properties: { note: "건물/인공 구조물 후보" }
      }));
    }

    const uncertainCount = 3 + Math.floor(hash(seed + 300) * 3);
    for (let i = 0; i < uncertainCount; i++) {
      const poly = polygonAround(
        bounds,
        0.12 + hash(seed + 310 + i) * 0.76,
        0.12 + hash(seed + 320 + i) * 0.76,
        0.045 + hash(seed + 330 + i) * 0.055,
        0.03 + hash(seed + 340 + i) * 0.05,
        0.28
      );
      features.push(featureMeta(`ng-${id++}`, "shadow_unknown", "uncertain", 0.42 + hash(seed + 350 + i) * 0.18, poly, {
        source: ["satellite_shadow"],
        properties: { note: "그림자/구름/판독 불확실 영역" }
      }));
    }

    state.features = features;
    state.selectedFeatureId = features[0]?.id || null;
    renderMasks();
    updateUi();
    if (features[0]) showFeatureDetail(features[0]);
    toast("no-go 마스크 분석을 생성했습니다.");
  }

  function aoiMetrics(bounds) {
    const center = bounds.getCenter();
    const widthM = distanceMeters(
      { lat: center.lat, lng: bounds.getWest() },
      { lat: center.lat, lng: bounds.getEast() }
    );
    const heightM = distanceMeters(
      { lat: bounds.getSouth(), lng: center.lng },
      { lat: bounds.getNorth(), lng: center.lng }
    );
    const maxSideM = Math.max(widthM, heightM);
    const gridN = clamp(Math.round(maxSideM / TARGET_CELL_M), 64, MAX_SAM_GRID_N);
    const cellM = Math.max(TARGET_CELL_M, Math.round(maxSideM / gridN));
    return { center, widthM, heightM, maxSideM, gridN, cellM };
  }

  function currentSamRequestPayload() {
    const bounds = aoiBounds();
    const metrics = aoiMetrics(bounds);
    return {
      requestId: `neoterrain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      product: "NeoTerrainMap",
      center: { lat: metrics.center.lat, lng: metrics.center.lng },
      bbox: {
        south: bounds.getSouth(),
        west: bounds.getWest(),
        north: bounds.getNorth(),
        east: bounds.getEast()
      },
      meters: {
        width: Math.round(metrics.widthM),
        height: Math.round(metrics.heightM)
      },
      grid: {
        n: metrics.gridN,
        cellM: metrics.cellM
      },
      image: {
        source: "Esri World Imagery",
        zoom: clamp(Math.round(map.getZoom()), 15, 17),
        size: 1536
      }
    };
  }

  function absoluteUrl(url, baseUrl) {
    try {
      return new URL(url, baseUrl || window.location.href).toString();
    } catch {
      return url;
    }
  }

  async function fetchSamJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (/ngrok/i.test(url)) headers.set("ngrok-skip-browser-warning", "true");
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.statusUrl && !data.status_url) {
      throw new Error(data.message || data.error || `SAM 서버 ${response.status}`);
    }
    return { data, responseUrl: response.url || url };
  }

  function isSamGridPayload(data) {
    return Boolean(data?.meta?.bbox && data?.meta?.grid && Array.isArray(data?.cells));
  }

  async function resolveSamResponse(data, baseUrl) {
    if (isSamGridPayload(data)) return data;
    if (isSamGridPayload(data?.segmentation_grid)) return data.segmentation_grid;
    if (isSamGridPayload(data?.grid)) return data.grid;
    if (isSamGridPayload(data?.result?.segmentation_grid)) return data.result.segmentation_grid;

    const directResultUrl = data?.resultUrl || data?.result_url || data?.segmentationGridUrl || data?.segmentation_grid_url;
    if (directResultUrl) {
      const result = await fetchSamJson(absoluteUrl(directResultUrl, baseUrl), { cache: "no-store" });
      return resolveSamResponse(result.data, result.responseUrl);
    }

    const statusUrl = data?.statusUrl || data?.status_url || data?.pollUrl || data?.poll_url;
    if (!statusUrl) throw new Error("SAM 응답에 segmentation grid 또는 statusUrl이 없습니다.");

    const pollUrl = absoluteUrl(statusUrl, baseUrl);
    for (let attempt = 0; attempt < 180; attempt++) {
      setSamStatus("polling", `대기 ${attempt + 1}회`);
      await sleep(2000);
      const poll = await fetchSamJson(pollUrl, { cache: "no-store" });
      const status = String(poll.data?.status || poll.data?.state || "").toLowerCase();
      if (["failed", "error", "cancelled"].includes(status)) {
        throw new Error(poll.data?.message || poll.data?.error || "SAM inference failed");
      }
      if (["succeeded", "success", "complete", "completed", "done", "ready"].includes(status) || isSamGridPayload(poll.data)) {
        return resolveSamResponse(poll.data, poll.responseUrl);
      }
      const resultUrl = poll.data?.resultUrl || poll.data?.result_url || poll.data?.segmentationGridUrl || poll.data?.segmentation_grid_url;
      if (resultUrl) {
        const result = await fetchSamJson(absoluteUrl(resultUrl, poll.responseUrl), { cache: "no-store" });
        return resolveSamResponse(result.data, result.responseUrl);
      }
    }
    throw new Error("SAM polling timeout");
  }

  function classifySamRecord(record) {
    const cls = record.visionClass;
    if (record.water || record.stream || cls === "water" || cls === "stream") {
      return { severity: "blocked", reason: "water" };
    }
    if (record.building || record.built || cls === "built") {
      return { severity: "blocked", reason: "structure" };
    }
    if (record.forest || cls === "trees") {
      return { severity: "uncertain", reason: "dense_vegetation" };
    }
    if ((record.visionUnknownPct || 0) >= 75) {
      return { severity: "uncertain", reason: "shadow_unknown" };
    }
    return null;
  }

  function rectanglesForRecords(records, gridN) {
    const groups = new Map();
    for (const record of records) {
      const cls = classifySamRecord(record);
      if (!cls) continue;
      const key = `${cls.severity}|${cls.reason}`;
      if (!groups.has(key)) groups.set(key, new Map());
      const rows = groups.get(key);
      if (!rows.has(record.j)) rows.set(record.j, []);
      rows.get(record.j).push(record);
    }

    const rectangles = [];
    for (const [key, rows] of groups) {
      const [severity, reason] = key.split("|");
      const active = new Map();
      const orderedRows = Array.from(rows.keys()).sort((a, b) => a - b);
      for (const j of orderedRows) {
        const row = rows.get(j).sort((a, b) => a.i - b.i);
        const nextActive = new Map();
        let runStart = null;
        let previousI = null;
        let sumConfidence = 0;
        let count = 0;

        function closeRun() {
          if (runStart === null) return;
          const runEnd = previousI;
          const runKey = `${runStart}:${runEnd}`;
          const existing = active.get(runKey);
          if (existing && existing.j1 === j - 1) {
            existing.j1 = j;
            existing.confidenceSum += sumConfidence;
            existing.count += count;
            nextActive.set(runKey, existing);
          } else {
            nextActive.set(runKey, {
              severity,
              reason,
              i0: runStart,
              i1: runEnd,
              j0: j,
              j1: j,
              confidenceSum: sumConfidence,
              count
            });
          }
          runStart = null;
          previousI = null;
          sumConfidence = 0;
          count = 0;
        }

        for (const record of row) {
          if (runStart === null) runStart = record.i;
          if (previousI !== null && record.i !== previousI + 1) closeRun();
          if (runStart === null) runStart = record.i;
          previousI = record.i;
          sumConfidence += Number(record.visionConfidence || record.confidence || 0.55);
          count += 1;
        }
        closeRun();

        for (const [runKey, rect] of active) {
          if (!nextActive.has(runKey)) rectangles.push(rect);
        }
        active.clear();
        for (const [runKey, rect] of nextActive) active.set(runKey, rect);
      }
      for (const rect of active.values()) rectangles.push(rect);
    }
    return rectangles.filter(rect => rect.i0 >= 0 && rect.j0 >= 0 && rect.i1 < gridN && rect.j1 < gridN);
  }

  function rectangleToPolygon(rect, bbox, gridN) {
    const latSpan = bbox.north - bbox.south;
    const lngSpan = bbox.east - bbox.west;
    const west = bbox.west + (rect.i0 / gridN) * lngSpan;
    const east = bbox.west + ((rect.i1 + 1) / gridN) * lngSpan;
    const north = bbox.north - (rect.j0 / gridN) * latSpan;
    const south = bbox.north - ((rect.j1 + 1) / gridN) * latSpan;
    return [
      [north, west],
      [north, east],
      [south, east],
      [south, west]
    ];
  }

  function featuresFromSamGrid(grid) {
    const bbox = grid.meta.bbox;
    const gridN = Number(grid.meta.grid?.n || 500);
    const rectangles = rectanglesForRecords(grid.cells || [], gridN);
    return rectangles.map((rect, index) => featureMeta(
      `sam-${index + 1}`,
      rect.reason,
      rect.severity,
      clamp(rect.confidenceSum / Math.max(1, rect.count), 0.35, 0.96),
      rectangleToPolygon(rect, bbox, gridN),
      {
        source: ["sam3_1_segmentation"],
        properties: {
          cells: rect.count,
          note: rect.severity === "blocked" ? "SAM3.1 no-go 후보" : "SAM3.1 판독 불확실 후보"
        }
      }
    ));
  }

  async function runSamAnalysis() {
    const bounds = aoiBounds();
    if (!bounds) {
      toast("먼저 AOI를 지정하세요.");
      return;
    }
    const apiUrl = (el.samApiUrl.value || "").trim();
    if (!apiUrl) {
      setSamStatus("failed", "서버 없음");
      toast("SAM 서버 주소를 입력하세요.");
      return;
    }

    setBusy(true, "SAM 요청중");
    setSamStatus("queued");
    try {
      const payload = currentSamRequestPayload();
      const { data, responseUrl } = await fetchSamJson(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      setSamStatus("running");
      const grid = await resolveSamResponse(data, responseUrl);
      const features = featuresFromSamGrid(grid);
      state.lastSamGrid = grid;
      state.features = features;
      state.selectedFeatureId = features[0]?.id || null;
      renderMasks();
      updateUi();
      if (features[0]) showFeatureDetail(features[0]);
      setSamStatus("completed");
      toast(`SAM3.1 마스크 ${features.length}개를 표시했습니다.`);
    } catch (err) {
      console.warn("SAM analysis failed:", err);
      state.features = [];
      state.selectedFeatureId = null;
      state.lastSamGrid = null;
      renderMasks();
      updateUi();
      setSamStatus("failed");
      el.featureDetail.textContent = `SAM3.1 분석 실패: ${err.message || err}`;
      toast("SAM3.1 분석 실패");
    } finally {
      setBusy(false);
    }
  }

  async function checkSamApi() {
    const apiUrl = (el.samApiUrl.value || "").trim();
    if (!apiUrl) {
      toast("SAM 서버 주소를 입력하세요.");
      return;
    }
    setSamStatus("checking");
    try {
      const healthUrl = absoluteUrl("/healthz", apiUrl);
      const result = await fetchSamJson(healthUrl, { cache: "no-store" });
      if (result.data?.status !== "ok") throw new Error("healthz status is not ok");
      setSamStatus("ready");
      toast("SAM 서버 연결 확인됨");
    } catch (err) {
      setSamStatus("failed");
      toast(`SAM 서버 연결 실패: ${err.message || err}`);
    }
  }

  function polygonToGeoJsonCoordinates(latLngs) {
    return [latLngs.map(([lat, lng]) => [lng, lat]).concat([[latLngs[0][1], latLngs[0][0]]])];
  }

  function toGeoJson() {
    return {
      type: "FeatureCollection",
      name: "NeoTerrainMap no-go mask",
      metadata: {
        generatedAt: new Date().toISOString(),
        aoi: state.aoi,
        note: "No-go/uncertain terrain layer. Routing and vehicle passability are intentionally excluded."
      },
      features: state.features.map(feature => ({
        type: "Feature",
        id: feature.id,
        properties: {
          severity: feature.severity,
          reason: feature.reason,
          label: feature.reasonLabel,
          confidence: Number(feature.confidence.toFixed(3)),
          source: feature.source,
          ...feature.properties
        },
        geometry: {
          type: "Polygon",
          coordinates: polygonToGeoJsonCoordinates(feature.geometry)
        }
      }))
    };
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function shouldShow(feature) {
    if (feature.severity === "blocked" && !el.noGoToggle.checked) return false;
    if (feature.severity === "uncertain" && !el.uncertainToggle.checked) return false;
    return true;
  }

  function renderMasks() {
    maskLayer.clearLayers();
    const visible = state.features.filter(shouldShow);
    for (const feature of visible) {
      const color = colorForReason(feature.reason, feature.severity);
      const layer = L.polygon(feature.geometry, {
        color,
        weight: feature.id === state.selectedFeatureId ? 3 : 1.4,
        opacity: feature.id === state.selectedFeatureId ? 0.95 : 0.75,
        fillColor: color,
        fillOpacity: state.opacity,
        interactive: true
      }).addTo(maskLayer);
      layer.on("click", () => {
        state.selectedFeatureId = feature.id;
        showFeatureDetail(feature);
        renderMasks();
      });
      if ((visible.length <= 40 && feature.confidence >= 0.78) || feature.id === state.selectedFeatureId) {
        const center = layer.getBounds().getCenter();
        L.marker(center, {
          icon: L.divIcon({
            className: "mask-label",
            html: `${feature.severity === "blocked" ? "NO-GO" : "불확실"} ${Math.round(feature.confidence * 100)}%`
          }),
          interactive: false
        }).addTo(maskLayer);
      }
    }
  }

  function showFeatureDetail(feature) {
    const props = feature.properties || {};
    el.featureDetail.innerHTML = `
      <h3>${feature.severity === "blocked" ? "못 가는 영역" : "불확실 영역"}</h3>
      <dl>
        <dt>근거</dt><dd>${feature.reasonLabel}</dd>
        <dt>신뢰도</dt><dd>${Math.round(feature.confidence * 100)}%</dd>
        <dt>출처</dt><dd>${feature.source.join(", ")}</dd>
        ${props.slopeDeg ? `<dt>추정 경사</dt><dd>${props.slopeDeg}도</dd>` : ""}
        ${props.note ? `<dt>메모</dt><dd>${props.note}</dd>` : ""}
      </dl>
    `;
  }

  function updateUi() {
    const bounds = aoiBounds();
    el.aoiStatus.textContent = bounds ? "지정됨" : "미지정";
    if (!state.analysisBusy) el.analysisStatus.textContent = state.features.length ? "완료" : "대기";
    el.featureCount.textContent = `${state.features.length}개`;
    el.exportGeoJsonBtn.disabled = state.features.length === 0;
    el.exportJsonBtn.disabled = state.features.length === 0;
    if (!state.features.length) {
      el.featureDetail.textContent = bounds
        ? "분석 실행을 누르면 SAM3.1 no-go/uncertain 마스크가 생성됩니다."
        : "AOI를 지정하고 분석을 실행하세요. 마스크를 클릭하면 근거와 신뢰도가 표시됩니다.";
    }
  }

  function finishDragAoi(endLatLng) {
    if (!dragStart) return;
    const bounds = L.latLngBounds(dragStart, endLatLng);
    dragStart = null;
    if (previewRect) {
      previewRect.remove();
      previewRect = null;
    }
    setDrawMode(false);
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 0);
    if (bounds.getNorth() === bounds.getSouth() || bounds.getEast() === bounds.getWest()) return;
    setAoi(bounds, "draw");
    toast("AOI가 지정됐습니다.");
  }

  map.on("mousedown", event => {
    if (state.mode !== "draw-aoi") return;
    dragStart = event.latlng;
    map.dragging.disable();
  });

  map.on("mousemove", event => {
    if (!dragStart) return;
    const bounds = L.latLngBounds(dragStart, event.latlng);
    if (!previewRect) {
      previewRect = L.rectangle(bounds, {
        color: "#ffffff",
        weight: 2,
        dashArray: "8 6",
        fillColor: "#ffffff",
        fillOpacity: 0.08
      }).addTo(map);
    } else {
      previewRect.setBounds(bounds);
    }
  });

  map.on("mouseup", event => {
    if (!dragStart) return;
    map.dragging.enable();
    finishDragAoi(event.latlng);
  });

  el.drawAoiBtn.addEventListener("click", () => {
    setDrawMode(state.mode !== "draw-aoi");
    if (state.mode === "draw-aoi") toast("지도에서 드래그해서 AOI를 지정하세요.");
  });

  el.screenAoiBtn.addEventListener("click", () => {
    setAoi(map.getBounds(), "screen");
    toast("현재 화면을 AOI로 지정했습니다.");
  });

  map.on("click", event => {
    if (suppressNextClick) return;
    if (state.mode !== "draw-aoi") {
      const size = Number(el.aoiSize.value || 2);
      setAoi(boundsFromCenter(event.latlng, size), "click");
      toast(`${size}km AOI가 지정됐습니다.`);
    }
  });

  el.samApiUrl.value = state.samApiUrl;
  setSamStatus("idle");

  el.runAnalysisBtn.addEventListener("click", runSamAnalysis);
  el.demoAnalysisBtn.addEventListener("click", generateAnalysis);
  el.saveSamApiBtn.addEventListener("click", () => {
    state.samApiUrl = (el.samApiUrl.value || "").trim();
    localStorage.setItem(SAM_API_STORAGE, state.samApiUrl);
    setSamStatus("saved");
    toast("SAM 서버 주소를 저장했습니다.");
  });
  el.checkSamApiBtn.addEventListener("click", checkSamApi);
  el.noGoToggle.addEventListener("change", renderMasks);
  el.uncertainToggle.addEventListener("change", renderMasks);
  el.reasonToggle.addEventListener("change", event => {
    state.useReasonColors = event.target.checked;
    renderMasks();
  });
  el.opacityRange.addEventListener("input", event => {
    state.opacity = Number(event.target.value) / 100;
    el.opacityValue.textContent = `${event.target.value}%`;
    renderMasks();
  });
  el.exportGeoJsonBtn.addEventListener("click", () => downloadJson("neoterrain-nogo.geojson", toGeoJson()));
  el.exportJsonBtn.addEventListener("click", () => downloadJson("neoterrain-analysis.json", {
    aoi: state.aoi,
    features: state.features,
    geojson: toGeoJson()
  }));

  updateUi();
})();

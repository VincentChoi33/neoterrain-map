(function () {
  const DEFAULT_CENTER = [37.6865, 127.408];
  const METERS_PER_LAT = 111320;
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
    useReasonColors: true
  };

  const el = {
    aoiStatus: document.getElementById("aoiStatus"),
    analysisStatus: document.getElementById("analysisStatus"),
    featureCount: document.getElementById("featureCount"),
    featureDetail: document.getElementById("featureDetail"),
    drawAoiBtn: document.getElementById("drawAoiBtn"),
    screenAoiBtn: document.getElementById("screenAoiBtn"),
    runAnalysisBtn: document.getElementById("runAnalysisBtn"),
    exportGeoJsonBtn: document.getElementById("exportGeoJsonBtn"),
    exportJsonBtn: document.getElementById("exportJsonBtn"),
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
      if (feature.confidence >= 0.78 || feature.severity === "uncertain") {
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
        <dt>Source</dt><dd>${feature.source.join(", ")}</dd>
        ${props.slopeDeg ? `<dt>추정 경사</dt><dd>${props.slopeDeg}도</dd>` : ""}
        ${props.note ? `<dt>메모</dt><dd>${props.note}</dd>` : ""}
      </dl>
    `;
  }

  function updateUi() {
    const bounds = aoiBounds();
    el.aoiStatus.textContent = bounds ? "지정됨" : "미지정";
    el.analysisStatus.textContent = state.features.length ? "완료" : "대기";
    el.featureCount.textContent = `${state.features.length}개`;
    el.exportGeoJsonBtn.disabled = state.features.length === 0;
    el.exportJsonBtn.disabled = state.features.length === 0;
    if (!state.features.length) {
      el.featureDetail.textContent = bounds
        ? "분석 실행을 누르면 no-go/uncertain 마스크가 생성됩니다."
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

  el.runAnalysisBtn.addEventListener("click", generateAnalysis);
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

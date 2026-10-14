/* global maplibregl */
window.AotaiMap3D = (function () {
  let ready = false;
  let initStarted = false;
  let map = null;
  let gamePoints = [];
  let routeCoords = [];
  let cumKm = [];
  let playerIdx = 0;
  let weatherId = "clear";
  /** 0 = 全貌 · 1 = 近景跟随 */
  let mapZoom = 0.32;
  let followBearing = 0;

  const MAPLIBRE_CSS =
    "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css";
  const MAPLIBRE_JS =
    "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js";
  const IMAGERY_URL =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

  let libPromise = null;

  const WEATHER_FOG = {
    clear: { color: "rgb(186, 210, 235)", h: 0.08, range: [2, 12], opacity: 0 },
    cloud: { color: "rgb(170, 190, 210)", h: 0.12, range: [1.5, 10], opacity: 0.08 },
    fog: { color: "rgb(200, 205, 215)", h: 0.35, range: [0.4, 6], opacity: 0.35 },
    rain: { color: "rgb(140, 160, 180)", h: 0.18, range: [0.8, 8], opacity: 0.22 },
    heavy_rain: { color: "rgb(120, 140, 165)", h: 0.22, range: [0.5, 6], opacity: 0.32 },
    snow: { color: "rgb(220, 228, 235)", h: 0.2, range: [0.6, 8], opacity: 0.25 },
    blizzard: { color: "rgb(235, 240, 245)", h: 0.45, range: [0.2, 4], opacity: 0.5 },
    whiteout: { color: "rgb(245, 248, 250)", h: 0.5, range: [0.15, 3], opacity: 0.55 },
    gale: { color: "rgb(160, 175, 190)", h: 0.14, range: [1, 9], opacity: 0.12 },
    storm: { color: "rgb(100, 115, 140)", h: 0.25, range: [0.4, 5], opacity: 0.28 },
  };

  function ensureLib() {
    if (typeof maplibregl !== "undefined") return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
      const script = document.createElement("script");
      script.src = MAPLIBRE_JS;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("MapLibre CDN failed"));
      document.head.appendChild(script);
    });
    return libPromise;
  }

  function coord(p) {
    const lon = p.lon;
    const lat = p.lat;
    if (lon != null && lat != null) return [lon, lat];
    return null;
  }

  function buildRoute(points) {
    gamePoints = points;
    routeCoords = [];
    cumKm = [0];
    let total = 0;
    points.forEach((p, i) => {
      const c = coord(p);
      if (!c) return;
      routeCoords.push(c);
      if (i > 0) total += points[i].km_from_prev || 0;
      cumKm.push(total);
    });
  }

  function densifyLine(coords, stepsPerSeg) {
    if (coords.length < 2) return coords;
    const out = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      out.push(a);
      for (let s = 1; s < stepsPerSeg; s++) {
        const t = s / stepsPerSeg;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    out.push(coords[coords.length - 1]);
    return out;
  }

  function sliceRoute(upToIdx) {
    const n = Math.min(upToIdx + 1, routeCoords.length);
    return densifyLine(routeCoords.slice(0, n), 2);
  }

  function remainingRoute(fromIdx) {
    return densifyLine(routeCoords.slice(fromIdx), 2);
  }

  function bearingBetween(a, b) {
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const lat1 = (a[1] * Math.PI) / 180;
    const lat2 = (b[1] * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function playerPosition() {
    if (!routeCoords.length) return [107.76, 34.02];
    const i = Math.min(playerIdx, routeCoords.length - 1);
    return routeCoords[i];
  }

  function poiGeoJSON() {
    return {
      type: "FeatureCollection",
      features: gamePoints
        .map((p) => {
          const c = coord(p);
          if (!c) return null;
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: c },
            properties: { name: p.name, id: p.id },
          };
        })
        .filter(Boolean),
    };
  }

  function addLayers() {
    map.addSource("route-done", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addSource("route-todo", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addSource("pois", { type: "geojson", data: poiGeoJSON() });
    map.addSource("player", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "Point", coordinates: playerPosition() } },
    });

    map.addLayer({
      id: "route-todo",
      type: "line",
      source: "route-todo",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#e8ecef", "line-width": 4 },
    });
    map.addLayer({
      id: "route-done",
      type: "line",
      source: "route-done",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#e82222", "line-width": 5 },
    });

    map.addLayer({
      id: "poi-pin",
      type: "circle",
      source: "pois",
      paint: {
        "circle-radius": 4,
        "circle-color": "#c41e1e",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#fff",
      },
    });

    map.addLayer({
      id: "player-dot",
      type: "circle",
      source: "player",
      paint: {
        "circle-radius": 9,
        "circle-color": "#2ecc71",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "#0d3d22",
      },
    });
  }

  function updateRouteSources() {
    if (!map || !map.getSource("route-done")) return;
    map.getSource("route-done").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: sliceRoute(playerIdx) },
    });
    map.getSource("route-todo").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: remainingRoute(playerIdx) },
    });
    map.getSource("player").setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: playerPosition() },
    });
  }

  function applyCamera(animate) {
    if (!map || !ready) return;
    const pos = playerPosition();
    const t = mapZoom;
    const zoom = 9.8 + t * 1.5;
    const pitch = 36 + t * 16;
    const offsetKm = 0.45 + (1 - t) * 3.2;
    const rad = (followBearing * Math.PI) / 180;
    const lat = pos[1];
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const mPerDegLat = 110540;
    const backLon = pos[0] - (Math.sin(rad) * offsetKm * 1000) / mPerDegLon;
    const backLat = pos[1] - (Math.cos(rad) * offsetKm * 1000) / mPerDegLat;
    const cam = { center: [backLon, backLat], zoom, pitch, bearing: followBearing, essential: true };
    if (animate) map.easeTo({ ...cam, duration: 700 });
    else map.jumpTo(cam);
  }

  function setWeatherVisual(id) {
    weatherId = id || "clear";
    if (!map || !ready) return;
    const w = WEATHER_FOG[weatherId] || WEATHER_FOG.clear;
    if (map.setFog) {
      map.setFog({
        color: w.color,
        "horizon-blend": w.h,
        range: w.range,
      });
    }
    const el = document.getElementById("mapWeatherOverlay");
    if (el) el.style.opacity = String(w.opacity);
  }

  function setZoom(z) {
    mapZoom = Math.max(0, Math.min(1, z));
    const slider = document.getElementById("mapZoomSlider");
    if (slider) slider.value = String(Math.round(mapZoom * 100));
    applyCamera(true);
  }

  function adjustZoom(delta) {
    setZoom(mapZoom + delta);
  }

  function bindZoomInput() {
    const container = document.getElementById("map3d");
    if (container) {
      container.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          adjustZoom(e.deltaY > 0 ? -0.05 : 0.05);
        },
        { passive: false }
      );
    }
    const slider = document.getElementById("mapZoomSlider");
    if (slider) {
      slider.addEventListener("input", () => {
        setZoom(Number(slider.value) / 100);
      });
    }
  }

  function init(points) {
    if (ready || initStarted || !points || !points.length || typeof maplibregl === "undefined") return;
    const container = document.getElementById("map3d");
    if (!container) return;
    initStarted = true;
    buildRoute(points);

    const bounds = new maplibregl.LngLatBounds();
    routeCoords.forEach((c) => bounds.extend(c));

    map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: [IMAGERY_URL],
            tileSize: 256,
            attribution: "Esri",
            maxzoom: 13,
          },
        },
        layers: [{ id: "satellite", type: "raster", source: "satellite" }],
      },
      center: routeCoords[0] || [107.76, 34.02],
      zoom: 10,
      pitch: 44,
      bearing: 0,
      maxZoom: 12,
      minZoom: 8,
      maxPitch: 60,
      antialias: false,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });

    map.on("load", () => {
      addLayers();
      playerIdx = 0;
      if (routeCoords.length > 1) {
        followBearing = bearingBetween(routeCoords[0], routeCoords[1]);
      }
      updateRouteSources();
      setWeatherVisual("clear");
      map.fitBounds(bounds, { padding: 48, pitch: 40, duration: 0, maxZoom: 10.5 });
      setTimeout(() => {
        ready = true;
        setZoom(mapZoom);
      }, 40);
    });

    bindZoomInput();
  }

  function resize() {
    if (map) map.resize();
  }

  function update(idx, weather, points) {
    ensureLib()
      .then(() => {
        if (!map && !initStarted && points && points.length) init(points);
        const changed = idx !== playerIdx;
        playerIdx = idx;
        if (changed && routeCoords.length > 1) {
          const i = Math.min(playerIdx, routeCoords.length - 1);
          const prev = routeCoords[Math.max(0, i - 1)];
          const next = routeCoords[Math.min(routeCoords.length - 1, i + 1)];
          followBearing = bearingBetween(prev, next);
        }
        if (map && map.isStyleLoaded()) updateRouteSources();
        setWeatherVisual(weather);
        if (ready) applyCamera(changed);
      })
      .catch((e) => console.warn("MapLibre", e));
  }

  function isReady() {
    return ready;
  }

  return {
    ensureLib,
    init,
    update,
    resize,
    setZoom,
    adjustZoom,
    getZoom: () => mapZoom,
    isReady,
  };
})();

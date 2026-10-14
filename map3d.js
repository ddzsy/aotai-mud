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
  let fxCanvas = null;
  let fxCtx = null;
  let fxAnimId = null;
  let fxParticles = [];
  let fxFlash = 0;
  let fxHailBias = false;

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
    hail: { color: "rgb(120, 135, 155)", h: 0.22, range: [0.35, 4.5], opacity: 0.32 },
  };

  const OVERLAY_GRAD = {
    clear: "linear-gradient(180deg, rgba(200,220,240,0), rgba(180,200,220,.12))",
    cloud: "linear-gradient(180deg, rgba(190,205,220,.05), rgba(160,175,195,.14))",
    fog: "linear-gradient(180deg, rgba(210,215,225,.25), rgba(180,185,195,.45))",
    rain: "linear-gradient(180deg, rgba(80,100,130,.15), rgba(60,80,110,.35))",
    heavy_rain: "linear-gradient(180deg, rgba(50,70,100,.22), rgba(40,55,80,.48))",
    snow: "linear-gradient(180deg, rgba(230,235,245,.2), rgba(210,220,235,.38))",
    blizzard: "linear-gradient(180deg, rgba(240,245,250,.35), rgba(220,228,238,.62))",
    whiteout: "linear-gradient(180deg, rgba(248,250,252,.45), rgba(235,240,245,.72))",
    gale: "linear-gradient(180deg, rgba(140,155,175,.12), rgba(100,115,135,.28))",
    storm: "linear-gradient(180deg, rgba(30,40,60,.35), rgba(20,28,45,.55))",
    hail: "linear-gradient(180deg, rgba(60,75,100,.28), rgba(45,55,75,.5))",
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

  function ensureFxCanvas() {
    const host = document.querySelector(".map-pane");
    if (!host || fxCanvas) return;
    fxCanvas = document.createElement("canvas");
    fxCanvas.className = "map-weather-fx";
    fxCanvas.setAttribute("aria-hidden", "true");
    host.appendChild(fxCanvas);
    fxCtx = fxCanvas.getContext("2d");
    const ro = new ResizeObserver(() => resizeFxCanvas());
    ro.observe(host);
    resizeFxCanvas();
  }

  function resizeFxCanvas() {
    if (!fxCanvas) return;
    const host = fxCanvas.parentElement;
    if (!host) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = host.clientWidth;
    const h = host.clientHeight;
    fxCanvas.width = Math.max(1, Math.floor(w * dpr));
    fxCanvas.height = Math.max(1, Math.floor(h * dpr));
    fxCanvas.style.width = w + "px";
    fxCanvas.style.height = h + "px";
    if (fxCtx) fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function stopWeatherFx() {
    if (fxAnimId) {
      cancelAnimationFrame(fxAnimId);
      fxAnimId = null;
    }
    fxParticles = [];
    if (fxCtx && fxCanvas) {
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    }
    const host = document.querySelector(".map-pane");
    if (host) host.classList.remove("weather-shake", "weather-storm-flash");
  }

  function spawnParticles(kind, count) {
    const w = fxCanvas ? fxCanvas.clientWidth : 400;
    const h = fxCanvas ? fxCanvas.clientHeight : 300;
    for (let i = 0; i < count; i++) {
      const p = { x: Math.random() * w, y: Math.random() * h, kind };
      if (kind === "rain" || kind === "heavy") {
        p.len = 8 + Math.random() * 14;
        p.speed = 12 + Math.random() * 18;
        p.drift = 2 + Math.random() * 4;
      } else if (kind === "snow") {
        p.r = 1 + Math.random() * 2.2;
        p.speed = 0.6 + Math.random() * 1.8;
        p.drift = 0.4 + Math.random() * 1.2;
      } else if (kind === "blizzard") {
        p.r = 1.2 + Math.random() * 3;
        p.speed = 3 + Math.random() * 6;
        p.drift = 4 + Math.random() * 8;
      } else if (kind === "hail") {
        p.r = 2 + Math.random() * 3;
        p.speed = 10 + Math.random() * 14;
        p.drift = 1 + Math.random() * 3;
      } else if (kind === "wind") {
        p.len = 20 + Math.random() * 40;
        p.speed = 6 + Math.random() * 10;
        p.drift = 8 + Math.random() * 14;
        p.alpha = 0.15 + Math.random() * 0.25;
      }
      fxParticles.push(p);
    }
  }

  function tickWeatherFx() {
    if (!fxCtx || !fxCanvas) return;
    const w = fxCanvas.clientWidth;
    const h = fxCanvas.clientHeight;
    fxCtx.clearRect(0, 0, w, h);
    const host = document.querySelector(".map-pane");
    if (fxFlash > 0) {
      fxFlash -= 1;
      if (host) host.classList.add("weather-storm-flash");
    } else if (host) host.classList.remove("weather-storm-flash");

    fxParticles.forEach((p) => {
      if (p.kind === "rain" || p.kind === "heavy") {
        fxCtx.strokeStyle = p.kind === "heavy" ? "rgba(160,185,210,.55)" : "rgba(170,195,220,.4)";
        fxCtx.lineWidth = p.kind === "heavy" ? 1.4 : 1;
        fxCtx.beginPath();
        fxCtx.moveTo(p.x, p.y);
        fxCtx.lineTo(p.x - p.drift, p.y + p.len);
        fxCtx.stroke();
        p.y += p.speed;
        p.x -= p.drift * 0.35;
      } else if (p.kind === "snow" || p.kind === "blizzard") {
        fxCtx.fillStyle = p.kind === "blizzard" ? "rgba(245,248,252,.85)" : "rgba(230,238,248,.7)";
        fxCtx.beginPath();
        fxCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        fxCtx.fill();
        p.y += p.speed;
        p.x += p.drift;
      } else if (p.kind === "hail") {
        fxCtx.fillStyle = "rgba(210,220,235,.9)";
        fxCtx.fillRect(p.x, p.y, p.r, p.r * 0.6);
        p.y += p.speed;
        p.x += p.drift * 0.2;
      } else if (p.kind === "wind") {
        fxCtx.strokeStyle = `rgba(200,215,230,${p.alpha})`;
        fxCtx.lineWidth = 1;
        fxCtx.beginPath();
        fxCtx.moveTo(p.x, p.y);
        fxCtx.lineTo(p.x + p.drift, p.y - p.len * 0.15);
        fxCtx.stroke();
        p.x += p.speed;
        if (p.x > w + 40) p.x = -40;
      }
      if (p.y > h + 20) {
        p.y = -10;
        p.x = Math.random() * w;
      }
      if (p.x > w + 20) p.x = -10;
      if (p.x < -30) p.x = w + 10;
    });

    if (weatherId === "storm" && Math.random() < 0.012) {
      fxFlash = 4;
      if (typeof window.playWeatherThunder === "function") window.playWeatherThunder();
    }

    fxAnimId = requestAnimationFrame(tickWeatherFx);
  }

  function startWeatherFx(id) {
    ensureFxCanvas();
    stopWeatherFx();
    const host = document.querySelector(".map-pane");
    const extreme = ["blizzard", "whiteout", "gale", "storm", "heavy_rain", "snow", "hail"];
    if (!extreme.includes(id)) return;

    if (id === "blizzard" || id === "whiteout") {
      spawnParticles(id === "blizzard" ? "blizzard" : "snow", id === "whiteout" ? 90 : 120);
      if (host) host.classList.add("weather-shake");
    } else if (id === "snow") spawnParticles("snow", 55);
    else if (id === "heavy_rain") spawnParticles("heavy", 100);
    else if (id === "rain") spawnParticles("rain", 70);
    else if (id === "storm") {
      spawnParticles("heavy", 85);
      if (fxHailBias) spawnParticles("hail", 35);
    } else if (id === "hail") {
      spawnParticles("hail", 80);
      spawnParticles("heavy", 40);
    } else if (id === "gale") {
      spawnParticles("wind", 45);
      spawnParticles("snow", 15);
      if (host) host.classList.add("weather-shake");
    }

    fxAnimId = requestAnimationFrame(tickWeatherFx);
  }

  function setWeatherVisual(id, opts) {
    weatherId = id || "clear";
    fxHailBias = !!(opts && opts.hail);
    const w = WEATHER_FOG[weatherId] || WEATHER_FOG.clear;
    if (map && ready && map.setFog) {
      map.setFog({
        color: w.color,
        "horizon-blend": w.h,
        range: w.range,
      });
    }
    const el = document.getElementById("mapWeatherOverlay");
    if (el) {
      el.style.opacity = String(w.opacity);
      el.style.background = OVERLAY_GRAD[weatherId] || OVERLAY_GRAD.clear;
      el.className = "map-weather-overlay weather-" + weatherId;
    }
    const host = document.querySelector(".map-pane");
    if (host) {
      host.dataset.weather = weatherId;
      host.classList.remove("weather-shake", "weather-storm-flash");
    }
    if (["blizzard", "whiteout", "gale", "storm", "heavy_rain", "snow", "hail"].includes(weatherId)) {
      startWeatherFx(weatherId);
    } else {
      stopWeatherFx();
    }
  }

  function pulseHailFx() {
    fxHailBias = true;
    if (weatherId === "storm") startWeatherFx("storm");
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
    resizeFxCanvas();
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
        setWeatherVisual(weather, { hail: weather === "storm" && window.__aotaiHailFx });
        // 路线/天气刷新不重置视角；仅 init / setZoom（滑条·滚轮·±）会 applyCamera
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
    pulseHailFx,
    setWeatherVisual,
  };
})();

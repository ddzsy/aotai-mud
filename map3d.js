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
  let mapZoom = 0.38;
  let followBearing = 0;

  const TERRAIN_URL =
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
  const IMAGERY_URL =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

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
    const base = routeCoords.slice(0, n);
    return densifyLine(base, 4);
  }

  function remainingRoute(fromIdx) {
    const base = routeCoords.slice(fromIdx);
    return densifyLine(base, 4);
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

  function distanceLabel() {
    const km = cumKm[Math.min(playerIdx, cumKm.length - 1)] || 0;
    if (km < 10) return km.toFixed(1) + "km";
    return km.toFixed(1) + "km";
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

  function ensureHikerImage() {
    if (map.hasImage("hiker-icon")) return;
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2ecc71";
    ctx.strokeStyle = "#1a7a42";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(4, 4, size - 8, size - 8, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#0d3d22";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🥾", size / 2, size / 2 + 2);
    const img = ctx.getImageData(0, 0, size, size);
    map.addImage("hiker-icon", img, { pixelRatio: 2 });
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
    map.addSource("route-active", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
    });
    map.addSource("pois", { type: "geojson", data: poiGeoJSON() });
    map.addSource("player", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "Point", coordinates: playerPosition() } },
    });

    map.addLayer({
      id: "route-todo-glow",
      type: "line",
      source: "route-todo",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "rgba(255,255,255,0.25)", "line-width": 10 },
    });
    map.addLayer({
      id: "route-todo",
      type: "line",
      source: "route-todo",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#f4f6f8", "line-width": 5 },
    });
    map.addLayer({
      id: "route-done-glow",
      type: "line",
      source: "route-done",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "rgba(220,40,40,0.35)", "line-width": 12 },
    });
    map.addLayer({
      id: "route-done",
      type: "line",
      source: "route-done",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#e82222", "line-width": 6 },
    });
    map.addLayer({
      id: "route-active",
      type: "line",
      source: "route-active",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 7 },
    });

    map.addLayer({
      id: "poi-pin",
      type: "circle",
      source: "pois",
      paint: {
        "circle-radius": 5,
        "circle-color": "#e82222",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
    map.addLayer({
      id: "poi-label",
      type: "symbol",
      source: "pois",
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-font": ["Open Sans Regular"],
      },
      paint: {
        "text-color": "#ffe566",
        "text-halo-color": "rgba(0,0,0,0.85)",
        "text-halo-width": 1.5,
      },
    });

    ensureHikerImage();
    map.addLayer({
      id: "player-icon",
      type: "symbol",
      source: "player",
      layout: {
        "icon-image": "hiker-icon",
        "icon-size": 0.55,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "text-field": distanceLabel(),
        "text-size": 12,
        "text-offset": [1.4, 0],
        "text-anchor": "left",
        "text-font": ["Open Sans Bold"],
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.75)",
        "text-halo-width": 1.2,
      },
    });
  }

  function updateRouteSources() {
    if (!map || !map.getSource("route-done")) return;
    const done = sliceRoute(playerIdx);
    const todo = remainingRoute(playerIdx);
    let active = [];
    if (playerIdx < routeCoords.length - 1) {
      active = densifyLine(routeCoords.slice(playerIdx, playerIdx + 2), 6);
    } else if (routeCoords.length >= 2) {
      active = routeCoords.slice(-2);
    }

    map.getSource("route-done").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: done },
    });
    map.getSource("route-todo").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: todo },
    });
    map.getSource("route-active").setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: active },
    });
    map.getSource("player").setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: playerPosition() },
      properties: {},
    });
    if (map.getLayer("player-icon")) {
      map.setLayoutProperty("player-icon", "text-field", distanceLabel());
    }
  }

  function applyCamera(animate) {
    if (!map || !ready) return;
    const pos = playerPosition();
    const t = mapZoom;
    const zoom = 11.2 + t * 2.4;
    const pitch = 42 + t * 22;
    const offsetKm = 0.35 + (1 - t) * 2.8;
    const rad = (followBearing * Math.PI) / 180;
    const lat = pos[1];
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const mPerDegLat = 110540;
    const backLon = pos[0] - (Math.sin(rad) * offsetKm * 1000) / mPerDegLon;
    const backLat = pos[1] - (Math.cos(rad) * offsetKm * 1000) / mPerDegLat;
    const cam = { center: [backLon, backLat], zoom, pitch, bearing: followBearing, essential: true };
    if (animate) map.easeTo({ ...cam, duration: 900 });
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
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          satellite: {
            type: "raster",
            tiles: [IMAGERY_URL],
            tileSize: 256,
            attribution: "Esri, Maxar, Earthstar Geographics",
            maxzoom: 19,
          },
          terrain: {
            type: "raster-dem",
            tiles: [TERRAIN_URL],
            encoding: "terrarium",
            tileSize: 256,
            maxzoom: 15,
          },
        },
        layers: [
          {
            id: "satellite",
            type: "raster",
            source: "satellite",
          },
        ],
      },
      center: routeCoords[0] || [107.76, 34.02],
      zoom: 11,
      pitch: 55,
      bearing: 0,
      maxPitch: 85,
      antialias: true,
      attributionControl: true,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    map.on("load", () => {
      map.setTerrain({ source: "terrain", exaggeration: 1.35 });
      addLayers();
      playerIdx = 0;
      if (routeCoords.length > 1) {
        followBearing = bearingBetween(routeCoords[0], routeCoords[1]);
      }
      updateRouteSources();
      setWeatherVisual("clear");
      map.fitBounds(bounds, { padding: 60, pitch: 48, duration: 0 });
      setTimeout(() => {
        ready = true;
        setZoom(mapZoom);
      }, 50);
    });

    bindZoomInput();
  }

  function resize() {
    if (map) map.resize();
  }

  function update(idx, weather) {
    if (!map) return;
    if (!ready && gamePoints.length) init(gamePoints);
    const changed = idx !== playerIdx;
    playerIdx = idx;
    if (changed && routeCoords.length > 1) {
      const i = Math.min(playerIdx, routeCoords.length - 1);
      const prev = routeCoords[Math.max(0, i - 1)];
      const next = routeCoords[Math.min(routeCoords.length - 1, i + 1)];
      followBearing = bearingBetween(prev, next);
    }
    if (map.isStyleLoaded()) updateRouteSources();
    setWeatherVisual(weather);
    if (ready) applyCamera(changed);
  }

  function isReady() {
    return ready;
  }

  return {
    init,
    update,
    resize,
    setZoom,
    adjustZoom,
    getZoom: () => mapZoom,
    isReady,
  };
})();

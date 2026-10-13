/* global THREE */
window.AotaiMap3D = (function () {
  let ready = false;
  let canvas, renderer, scene, camera, clock;
  let worldPts = [];
  let curve = null;
  let terrain = null;
  let trailDone = null;
  let trailTodo = null;
  let player = null;
  let playerGlow = null;
  let markers = [];
  let playerIdx = 0;
  let geoOrigin = { lon: 107.7, lat: 33.48 };
  const WORLD_SCALE = 0.00105;
  let terrainMeta = null;
  let elevData = null;
  const Y_SCALE = 0.0105;
  let weatherId = "clear";
  let animId = 0;
  let camTarget = new THREE.Vector3();
  let camDesired = new THREE.Vector3();
  /** 0 = 全貌（最远） · 1 = 近景航拍（最近） */
  let mapZoom = 0.38;
  let routeBounds = null;
  let playerBeam = null;
  let playerRing = null;
  let playerGroup = null;
  let dirLight = null;
  let hemiLight = null;
  let weatherRoot = null;
  let precip = null;
  let fogLayers = [];
  let windStreaks = null;
  let lightningFlash = 0;
  let windVec = new THREE.Vector3(1, 0, 0.3);

  const WEATHER_PROFILES = {
    clear: { fog: 0.006, fogColor: 0x0f1419, light: 1.15, precip: 0, wind: 0, mist: 0 },
    cloud: { fog: 0.009, fogColor: 0x121820, light: 0.95, precip: 0, wind: 0, mist: 0.15 },
    fog: { fog: 0.022, fogColor: 0x8a96a4, light: 0.65, precip: 0, wind: 0.2, mist: 0.85 },
    rain: { fog: 0.014, fogColor: 0x1a2838, light: 0.7, precip: 1400, kind: "rain", wind: 2.5, mist: 0.35 },
    heavy_rain: { fog: 0.02, fogColor: 0x1a3040, light: 0.55, precip: 2600, kind: "rain", wind: 4, mist: 0.5 },
    snow: { fog: 0.016, fogColor: 0x9aa8b8, light: 0.8, precip: 1600, kind: "snow", wind: 1.5, mist: 0.4 },
    blizzard: { fog: 0.032, fogColor: 0xb8c4d0, light: 0.5, precip: 2800, kind: "snow", wind: 11, mist: 0.75 },
    whiteout: { fog: 0.038, fogColor: 0xd8e2ea, light: 0.45, precip: 1200, kind: "snow", wind: 6, mist: 1 },
    gale: { fog: 0.012, fogColor: 0x1a2830, light: 0.75, precip: 400, kind: "dust", wind: 14, mist: 0.25 },
    storm: { fog: 0.018, fogColor: 0x1a2030, light: 0.42, precip: 2200, kind: "rain", wind: 7, mist: 0.45 },
  };

  function lonLatToXZ(lon, lat) {
    const R = 6378137;
    const cos = Math.cos(geoOrigin.lat * Math.PI / 180);
    const x = (lon - geoOrigin.lon) * (Math.PI / 180) * R * cos * WORLD_SCALE;
    const z = -(lat - geoOrigin.lat) * (Math.PI / 180) * R * WORLD_SCALE;
    return { x, z };
  }

  function lonLatToUV(lon, lat) {
    const m = terrainMeta;
    const u = (lon - m.lon_min) / (m.lon_max - m.lon_min);
    const v = (m.lat_max - lat) / (m.lat_max - m.lat_min);
    return { u: Math.max(0, Math.min(1, u)), v: Math.max(0, Math.min(1, v)) };
  }

  function sampleElevMeters(lon, lat) {
    if (!elevData || !terrainMeta) return 0;
    const { u, v } = lonLatToUV(lon, lat);
    const w = terrainMeta.width;
    const h = terrainMeta.height;
    const x = u * (w - 1);
    const y = v * (h - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const i00 = y0 * w + x0;
    const i10 = y0 * w + x1;
    const i01 = y1 * w + x0;
    const i11 = y1 * w + x1;
    const e =
      elevData[i00] * (1 - tx) * (1 - ty) +
      elevData[i10] * tx * (1 - ty) +
      elevData[i01] * (1 - tx) * ty +
      elevData[i11] * tx * ty;
    return e;
  }

  function elevToWorldY(elevM) {
    return (elevM - terrainMeta.elev_min) * Y_SCALE;
  }

  function loadTerrainData() {
    return Promise.all([
      fetch("terrain-meta.json").then((r) => r.json()),
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = "terrain-heightmap.png";
      }),
    ]).then(([meta, img]) => {
      terrainMeta = meta;
      geoOrigin.lon = (meta.lon_min + meta.lon_max) / 2;
      geoOrigin.lat = (meta.lat_min + meta.lat_max) / 2;
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      elevData = new Float32Array(c.width * c.height);
      const span = meta.elev_max - meta.elev_min;
      for (let i = 0; i < elevData.length; i++) {
        elevData[i] = meta.elev_min + (px[i * 4] / 255) * span;
      }
    });
  }

  function buildWorldPoints(points) {
    return points.map((p) => {
      const lon = p.lon;
      const lat = p.lat;
      const xz = lonLatToXZ(lon, lat);
      const elev = sampleElevMeters(lon, lat);
      const y = elevToWorldY(elev) + 0.35;
      return { x: xz.x, z: xz.z, y, elev, meta: p };
    });
  }

  function vertexColorForElev(elevM) {
    const t = (elevM - terrainMeta.elev_min) / (terrainMeta.elev_max - terrainMeta.elev_min);
    const cLow = new THREE.Color(0x2d4a35);
    const cMid = new THREE.Color(0x4a5c48);
    const cHigh = new THREE.Color(0x6a6660);
    const cRock = new THREE.Color(0x7a7470);
    const cSnow = new THREE.Color(0xe8eef4);
    const col = new THREE.Color();
    if (t < 0.25) col.copy(cLow).lerp(cMid, t / 0.25);
    else if (t < 0.55) col.copy(cMid).lerp(cHigh, (t - 0.25) / 0.3);
    else if (t < 0.78) col.copy(cHigh).lerp(cRock, (t - 0.55) / 0.23);
    else col.copy(cRock).lerp(cSnow, (t - 0.78) / 0.22);
    return col;
  }

  function buildTerrain() {
    const m = terrainMeta;
    const segX = 220;
    const segZ = 200;
    const geo = new THREE.PlaneGeometry(1, 1, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    const corners = [
      lonLatToXZ(m.lon_min, m.lat_min),
      lonLatToXZ(m.lon_max, m.lat_min),
      lonLatToXZ(m.lon_min, m.lat_max),
      lonLatToXZ(m.lon_max, m.lat_max),
    ];
    const minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
    const maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
    const minZ = Math.min(corners[0].z, corners[1].z, corners[2].z, corners[3].z);
    const maxZ = Math.max(corners[0].z, corners[1].z, corners[2].z, corners[3].z);
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) + 0.5;
      const v = pos.getZ(i) + 0.5;
      const lon = m.lon_min + u * (m.lon_max - m.lon_min);
      const lat = m.lat_max - v * (m.lat_max - m.lat_min);
      const elev = sampleElevMeters(lon, lat);
      const xz = lonLatToXZ(lon, lat);
      pos.setX(i, xz.x);
      pos.setZ(i, xz.z);
      pos.setY(i, elevToWorldY(elev));
      const col = vertexColorForElev(elev);
      colors.push(col.r, col.g, col.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    terrain = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.03,
      })
    );
    terrain.receiveShadow = true;
    scene.add(terrain);
    routeBounds = {
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      cy: elevToWorldY((m.elev_min + m.elev_max) / 2),
      span: Math.max(maxX - minX, maxZ - minZ),
      maxY: elevToWorldY(m.elev_max),
    };
  }

  function buildTrail() {
    const vecs = worldPts.map((p) => new THREE.Vector3(p.x, p.y + 0.35, p.z));
    curve = new THREE.CatmullRomCurve3(vecs, false, "catmullrom", 0.35);
    const donePts = [];
    const todoPts = [];
    for (let i = 0; i < worldPts.length; i++) {
      const v = vecs[i];
      if (i <= playerIdx) donePts.push(v.clone());
      else todoPts.push(v.clone());
    }
    if (donePts.length >= 2) {
      const g = new THREE.BufferGeometry().setFromPoints(donePts);
      trailDone = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: 0x5dbe8a, linewidth: 2 })
      );
      scene.add(trailDone);
    }
    if (todoPts.length >= 1 && donePts.length) {
      const linePts = [donePts[donePts.length - 1].clone(), ...todoPts];
      const g = new THREE.BufferGeometry().setFromPoints(linePts);
      trailTodo = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: 0x4a5a68, linewidth: 1 })
      );
      scene.add(trailTodo);
    }
    const tubeGeo = new THREE.TubeGeometry(curve, 280, 0.22, 6, false);
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0x3a4a38,
      roughness: 0.85,
      metalness: 0.02,
    });
    const walk = new THREE.Mesh(tubeGeo, tubeMat);
    walk.position.y = -0.15;
    scene.add(walk);
  }

  function rebuildTrailLines() {
    if (trailDone) {
      scene.remove(trailDone);
      trailDone.geometry.dispose();
      trailDone = null;
    }
    if (trailTodo) {
      scene.remove(trailTodo);
      trailTodo.geometry.dispose();
      trailTodo = null;
    }
    const vecs = worldPts.map((p) => new THREE.Vector3(p.x, p.y + 0.35, p.z));
    const donePts = vecs.filter((_, i) => i <= playerIdx);
    const todoPts = vecs.filter((_, i) => i > playerIdx);
    if (donePts.length >= 2) {
      trailDone = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(donePts),
        new THREE.LineBasicMaterial({ color: 0x5dbe8a })
      );
      scene.add(trailDone);
    }
    if (todoPts.length && donePts.length) {
      const linePts = [donePts[donePts.length - 1].clone(), ...todoPts];
      trailTodo = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(linePts),
        new THREE.LineBasicMaterial({ color: 0x4a5a68 })
      );
      scene.add(trailTodo);
    }
  }

  function buildMarkers() {
    markers.forEach((m) => scene.remove(m));
    markers = [];
    worldPts.forEach((wp, i) => {
      const p = wp.meta;
      let color = 0x556070;
      if (i < playerIdx) color = 0x4a8f6a;
      if (i === playerIdx) return;
      if (p.camp) color = 0xc9a66b;
      if (p.water) color = 0x5dade2;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(p.camp ? 0.35 : 0.22, 10, 10),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.15,
        })
      );
      m.position.set(wp.x, wp.y + 0.5, wp.z);
      scene.add(m);
      markers.push(m);
    });
  }

  function buildPlayer() {
    playerGroup = new THREE.Group();
    player = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffb84d,
        emissive: 0xff9900,
        emissiveIntensity: 0.85,
      })
    );
    playerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(1.65, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffcc66,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    playerBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.55, 16, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffaa33,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    playerBeam.position.y = 8;
    playerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.4, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffcc44,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    playerRing.rotation.x = -Math.PI / 2;
    playerRing.position.y = 0.15;
    playerGroup.add(playerRing);
    playerGroup.add(playerBeam);
    playerGroup.add(playerGlow);
    playerGroup.add(player);
    scene.add(playerGroup);
  }

  function spawnLocalParticle(i, box, yBias) {
    const p = precip.pos;
    p[i * 3] = (Math.random() - 0.5) * box.x;
    p[i * 3 + 1] = Math.random() * box.y + yBias;
    p[i * 3 + 2] = (Math.random() - 0.5) * box.z;
  }

  function buildPrecipSystem(max) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const velX = new Float32Array(max);
    const velY = new Float32Array(max);
    const velZ = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 1] = Math.random() * 28 + 2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 70;
      velY[i] = -1;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.14,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, pos, velX, velY, velZ, max, active: 0, kind: "none" };
  }

  function buildWindStreaks(max) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 6);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    return { lines, pos, max, active: 0 };
  }

  function buildFogLayers() {
    fogLayers = [];
    for (let i = 0; i < 8; i++) {
      const geo = new THREE.PlaneGeometry(36 + i * 4, 18 + i * 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd0dae4,
        transparent: true,
        opacity: 0.06,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { phase: i * 1.3, height: 2 + i * 1.8 };
      mesh.visible = false;
      weatherRoot.add(mesh);
      fogLayers.push(mesh);
    }
  }

  function buildWeatherFX() {
    weatherRoot = new THREE.Group();
    scene.add(weatherRoot);
    precip = buildPrecipSystem(3200);
    weatherRoot.add(precip.points);
    windStreaks = buildWindStreaks(280);
    weatherRoot.add(windStreaks.lines);
    buildFogLayers();
  }

  function applyPrecipProfile(profile) {
    if (!precip) return;
    const n = profile.precip || 0;
    precip.active = n;
    precip.kind = profile.kind || "none";
    precip.points.visible = n > 0;
    const mat = precip.points.material;
    if (precip.kind === "rain") {
      mat.color.setHex(0xa8c8e8);
      mat.size = 0.09;
      mat.opacity = 0.55;
    } else if (precip.kind === "snow") {
      mat.color.setHex(0xffffff);
      mat.size = 0.16;
      mat.opacity = 0.82;
    } else if (precip.kind === "dust") {
      mat.color.setHex(0x9aa8b0);
      mat.size = 0.07;
      mat.opacity = 0.4;
    }
    const box = precip.kind === "rain"
      ? { x: 55, y: 32, z: 55 }
      : { x: 65, y: 30, z: 65 };
    const fall = precip.kind === "rain" ? 22 + profile.wind * 2 : 3.5 + profile.wind * 0.15;
    for (let i = 0; i < precip.max; i++) {
      spawnLocalParticle(i, box, 1);
      precip.velY[i] = -fall * (0.7 + Math.random() * 0.6);
      precip.velX[i] = profile.wind * (0.4 + Math.random() * 0.8);
      precip.velZ[i] = (Math.random() - 0.5) * profile.wind * 0.35;
    }
  }

  function applyWindProfile(profile) {
    if (!windStreaks) return;
    const w = profile.wind || 0;
    windStreaks.active = w > 3 ? Math.min(220, 40 + w * 12) : 0;
    windStreaks.lines.visible = windStreaks.active > 0;
    const pos = windStreaks.pos;
    for (let i = 0; i < windStreaks.max; i++) {
      const len = 0.6 + Math.random() * 1.8;
      const x = (Math.random() - 0.5) * 60;
      const y = 2 + Math.random() * 16;
      const z = (Math.random() - 0.5) * 60;
      const i6 = i * 6;
      pos[i6] = x;
      pos[i6 + 1] = y;
      pos[i6 + 2] = z;
      pos[i6 + 3] = x + len * windVec.x;
      pos[i6 + 4] = y + len * windVec.y * 0.2;
      pos[i6 + 5] = z + len * windVec.z;
    }
    windStreaks.lines.geometry.attributes.position.needsUpdate = true;
    windStreaks.lines.material.opacity = Math.min(0.55, 0.12 + w * 0.025);
  }

  function updateWeatherParticles(dt) {
    if (!weatherRoot || !player) return;
    const pp = player.position;
    weatherRoot.position.set(pp.x, pp.y - 0.5, pp.z);

    const tan = trailTangent(playerIdx);
    windVec.set(tan.z, 0.15, -tan.x).normalize();

    const t = clock.elapsedTime;
    fogLayers.forEach((mesh, i) => {
      if (!mesh.visible) return;
      mesh.position.set(
        Math.sin(t * 0.15 + mesh.userData.phase) * 8,
        mesh.userData.height + Math.sin(t * 0.2 + i) * 1.5,
        Math.cos(t * 0.12 + mesh.userData.phase) * 8
      );
      mesh.lookAt(camera.position);
      mesh.material.opacity = 0.04 + Math.sin(t * 0.3 + i) * 0.02;
    });

    if (precip && precip.active > 0) {
      const pos = precip.pos;
      const boxY = 30;
      const half = 34;
      for (let i = 0; i < precip.active; i++) {
        pos[i * 3] += precip.velX[i] * dt;
        pos[i * 3 + 1] += precip.velY[i] * dt;
        pos[i * 3 + 2] += precip.velZ[i] * dt;
        if (precip.kind === "snow") {
          pos[i * 3] += Math.sin(t * 2 + i) * dt * 0.35;
        }
        if (pos[i * 3 + 1] < -2) {
          pos[i * 3 + 1] = boxY + Math.random() * 8;
          pos[i * 3] = (Math.random() - 0.5) * half * 2;
          pos[i * 3 + 2] = (Math.random() - 0.5) * half * 2;
        }
        if (pos[i * 3] > half || pos[i * 3] < -half) pos[i * 3] *= -0.92;
        if (pos[i * 3 + 2] > half || pos[i * 3 + 2] < -half) pos[i * 3 + 2] *= -0.92;
      }
      precip.points.geometry.attributes.position.needsUpdate = true;
      precip.points.geometry.setDrawRange(0, precip.active);
    }

    if (windStreaks && windStreaks.active > 0) {
      const pos = windStreaks.pos;
      const drift = (WEATHER_PROFILES[weatherId]?.wind || 4) * dt;
      for (let i = 0; i < windStreaks.active; i++) {
        const i6 = i * 6;
        for (let k = 0; k < 6; k += 3) {
          pos[i6 + k] += windVec.x * drift;
          pos[i6 + k + 1] += Math.sin(t + i) * dt * 0.08;
          pos[i6 + k + 2] += windVec.z * drift;
        }
        if (pos[i6] > 35 || pos[i6] < -35) {
          const len = 0.8 + Math.random();
          const x = -30 + Math.random() * 10;
          const y = 2 + Math.random() * 14;
          const z = (Math.random() - 0.5) * 50;
          pos[i6] = x;
          pos[i6 + 1] = y;
          pos[i6 + 2] = z;
          pos[i6 + 3] = x + len * windVec.x;
          pos[i6 + 4] = y;
          pos[i6 + 5] = z + len * windVec.z;
        }
      }
      windStreaks.lines.geometry.attributes.position.needsUpdate = true;
      windStreaks.lines.geometry.setDrawRange(0, windStreaks.active * 2);
    }

    if (lightningFlash > 0) {
      lightningFlash -= dt;
      if (dirLight) dirLight.intensity = 2.2;
      if (scene) scene.background = new THREE.Color(0x3a4860);
    }
  }

  function maybeLightning() {
    if (weatherId !== "storm") return;
    if (Math.random() < 0.012) lightningFlash = 0.08 + Math.random() * 0.12;
  }

  function trailTangent(idx) {
    const i0 = Math.max(0, idx);
    const i1 = Math.min(worldPts.length - 1, idx + 1);
    const a = worldPts[i0];
    const b = worldPts[i1];
    const v = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    if (v.lengthSq() < 0.001 && idx > 0) {
      const c = worldPts[idx - 1];
      v.set(a.x - c.x, a.y - c.y, a.z - c.z);
    }
    return v.normalize();
  }

  function playerPos() {
    const p = worldPts[playerIdx];
    return new THREE.Vector3(p.x, p.y + 0.55, p.z);
  }

  function clampZoom(z) {
    mapZoom = Math.max(0, Math.min(1, z));
    const slider = document.getElementById("mapZoomSlider");
    if (slider) slider.value = String(Math.round(mapZoom * 100));
  }

  function setZoom(z) {
    clampZoom(z);
  }

  function adjustZoom(delta) {
    clampZoom(mapZoom + delta);
  }

  function updateCamera(dt) {
    const pos = playerPos();
    const t = mapZoom;
    const b = routeBounds;

    const lookAt = new THREE.Vector3(
      THREE.MathUtils.lerp(b.cx, pos.x, t),
      THREE.MathUtils.lerp(b.cy, pos.y + 1.5, t),
      THREE.MathUtils.lerp(b.cz, pos.z, t)
    );

    const fullH = b.span * 0.72 + b.maxY * 0.9 + 18;
    const nearH = 22 + b.maxY * 0.08;
    const height = THREE.MathUtils.lerp(fullH, nearH, t);
    const tilt = THREE.MathUtils.lerp(b.span * 0.22, 10, t);
    const side = THREE.MathUtils.lerp(b.span * 0.18, 11, t);

    camDesired.set(lookAt.x + side, lookAt.y + height, lookAt.z + tilt);
    camTarget.copy(lookAt);

    const lerp = 1 - Math.pow(0.001, dt || 0.016);
    camera.position.lerp(camDesired, lerp * 0.16);
    camera.fov = THREE.MathUtils.lerp(50, 46, t);
    camera.updateProjectionMatrix();
    camera.lookAt(camTarget);

    const pillar = THREE.MathUtils.lerp(1.4, 1, t);
    if (playerBeam) {
      playerBeam.scale.set(pillar, pillar, pillar);
      playerBeam.material.opacity = THREE.MathUtils.lerp(0.75, 0.5, t);
    }
    if (playerRing) playerRing.scale.setScalar(THREE.MathUtils.lerp(1.8, 1, t));
  }

  function setWeatherVisual(id) {
    weatherId = id || "clear";
    if (!scene) return;
    const profile = WEATHER_PROFILES[weatherId] || WEATHER_PROFILES.clear;
    const fogCol = new THREE.Color(profile.fogColor);
    const fogMul = THREE.MathUtils.lerp(0.25, 1, mapZoom);
    scene.fog = new THREE.FogExp2(fogCol.getHex(), profile.fog * fogMul);
    scene.background = fogCol.clone().lerp(new THREE.Color(0x0f1419), 0.55);

    applyPrecipProfile(profile);
    applyWindProfile(profile);

    const mist = profile.mist || 0;
    fogLayers.forEach((mesh, i) => {
      mesh.visible = mist > 0.1;
      if (mesh.visible) {
        mesh.material.opacity = mist * (0.05 + (i % 3) * 0.015);
        mesh.material.color.setHex(
          weatherId === "whiteout" || weatherId === "blizzard" ? 0xe8eef4 : 0xc0ccd8
        );
      }
    });

    if (dirLight && lightningFlash <= 0) dirLight.intensity = profile.light;
    if (hemiLight) hemiLight.intensity = 0.35 + profile.light * 0.22;
  }

  function animate() {
    animId = requestAnimationFrame(animate);
    const dt = clock.getDelta();
    if (playerGroup && worldPts[playerIdx]) {
      const p = worldPts[playerIdx];
      const target = new THREE.Vector3(p.x, p.y + 0.55, p.z);
      playerGroup.position.lerp(target, 0.2);
      const pulse = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.1;
      if (playerGlow) playerGlow.scale.setScalar(1.65 * pulse);
      if (playerRing) playerRing.material.opacity = 0.75 + Math.sin(clock.elapsedTime * 3) * 0.15;
    }
    maybeLightning();
    updateWeatherParticles(dt);
    if (lightningFlash <= 0 && dirLight) {
      const profile = WEATHER_PROFILES[weatherId] || WEATHER_PROFILES.clear;
      dirLight.intensity = profile.light;
      const fogCol = new THREE.Color(profile.fogColor);
      scene.background = fogCol.clone().lerp(new THREE.Color(0x0f1419), 0.55);
    }
    updateCamera(dt);
    renderer.render(scene, camera);
  }

  let initStarted = false;

  function init(points) {
    if (ready || initStarted || !points || !points.length || typeof THREE === "undefined") return;
    canvas = document.getElementById("map3d");
    if (!canvas) return;
    initStarted = true;

    loadTerrainData()
      .then(() => {
        worldPts = buildWorldPoints(points);
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x0f1419);

        camera = new THREE.PerspectiveCamera(48, 1, 0.5, 900);
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;

        hemiLight = new THREE.HemisphereLight(0x9eb8d8, 0x1a2820, 0.55);
        scene.add(hemiLight);
        dirLight = new THREE.DirectionalLight(0xfff0dd, 1.1);
        dirLight.position.set(40, 80, 25);
        dirLight.castShadow = true;
        scene.add(dirLight);

        buildTerrain();
        buildTrail();
        buildMarkers();
        buildPlayer();
        buildWeatherFX();
        setWeatherVisual("clear");
        bindZoomInput();

        const mid = worldPts[Math.floor(worldPts.length / 2)];
        camera.position.set(mid.x - 30, mid.y + 55, mid.z + 40);
        camera.lookAt(mid.x, mid.y, mid.z);

        clock = new THREE.Clock();
        resize();
        ready = true;
        animate();
      })
      .catch((err) => {
        console.error("地形加载失败", err);
        initStarted = false;
      });
  }

  function resize() {
    if (!renderer || !camera || !canvas) return;
    const parent = canvas.parentElement;
    const w = parent.clientWidth || 400;
    const h = parent.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function update(idx, weather) {
    if (!ready) return;
    const changed = idx !== playerIdx;
    playerIdx = idx;
    if (changed) rebuildTrailLines();
    buildMarkers();
    setWeatherVisual(weather);
  }

  function bindZoomInput() {
    if (!canvas) return;
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        adjustZoom(e.deltaY > 0 ? -0.05 : 0.05);
      },
      { passive: false }
    );
    const slider = document.getElementById("mapZoomSlider");
    if (slider) {
      slider.addEventListener("input", () => {
        setZoom(Number(slider.value) / 100);
      });
    }
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

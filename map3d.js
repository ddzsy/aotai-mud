/* global THREE */
window.AotaiMap3D = (function () {
  const CAM_ORDER = ["follow", "aerial", "ridge", "trail"];
  const CAM_LABELS = {
    follow: "跟随",
    aerial: "俯瞰",
    ridge: "侧视",
    trail: "行山视角",
  };

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
  let cameraMode = "follow";
  let playerIdx = 0;
  let weatherId = "clear";
  let animId = 0;
  let camTarget = new THREE.Vector3();
  let camDesired = new THREE.Vector3();
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

  function hash2(x, z) {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  function ridgeHeightAt(x, z) {
    if (!worldPts.length) return 0;
    let best = 0;
    let bestD = 1e9;
    for (let i = 0; i < worldPts.length - 1; i++) {
      const a = worldPts[i];
      const b = worldPts[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const apx = x - a.x;
      const apz = z - a.z;
      const ab2 = abx * abx + abz * abz || 1;
      let t = (apx * abx + apz * abz) / ab2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const py = a.y + (b.y - a.y) * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bestD) {
        bestD = d;
        best = py;
      }
    }
    const dist = Math.sqrt(bestD);
    const falloff = Math.exp(-dist * dist / 90);
    const n = (hash2(x * 0.3, z * 0.3) - 0.5) * 1.2;
    return best * falloff + n * falloff * 0.4;
  }

  function buildWorldPoints(points) {
    let km = 0;
    const altBase = 800;
    return points.map((p, i) => {
      if (i) km += p.km_from_prev;
      const lateral = ((p.x || 500) - 500) * 0.045;
      return {
        x: km * 1.15,
        y: (p.alt_m - altBase) * 0.038,
        z: lateral + Math.sin(i * 0.35) * 1.8,
        meta: p,
      };
    });
  }

  function buildTerrain() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    worldPts.forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    });
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxZ - minZ) + 40;
    const size = Math.max(160, span);
    const seg = 80;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    const cLow = new THREE.Color(0x2a4a32);
    const cMid = new THREE.Color(0x3d4f42);
    const cHigh = new THREE.Color(0x5a5d62);
    const cRock = new THREE.Color(0x6a6460);
    const cSnow = new THREE.Color(0xd8e4ee);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const h = ridgeHeightAt(x, z);
      pos.setY(i, h - 1.8);
      const t = Math.min(1, Math.max(0, (h - 2) / 18));
      const col = new THREE.Color();
      if (t < 0.35) col.copy(cLow).lerp(cMid, t / 0.35);
      else if (t < 0.72) col.copy(cMid).lerp(cHigh, (t - 0.35) / 0.37);
      else if (t < 0.88) col.copy(cHigh).lerp(cRock, (t - 0.72) / 0.16);
      else col.copy(cRock).lerp(cSnow, (t - 0.88) / 0.12);
      colors.push(col.r, col.g, col.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.05,
      flatShading: false,
    });
    terrain = new THREE.Mesh(geo, mat);
    terrain.position.set(cx, 0, cz);
    terrain.receiveShadow = true;
    scene.add(terrain);
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
    player = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0xe8a54b,
        emissive: 0xe8a54b,
        emissiveIntensity: 0.55,
      })
    );
    playerGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xe8a54b,
        transparent: true,
        opacity: 0.18,
      })
    );
    scene.add(player);
    scene.add(playerGlow);
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

  function updateCamera(dt) {
    const pos = playerPos();
    const tan = trailTangent(playerIdx);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tan, up).normalize();
    const center = worldPts[Math.floor(worldPts.length / 2)];

    if (cameraMode === "follow") {
      camDesired.copy(pos).add(tan.clone().multiplyScalar(-10)).add(new THREE.Vector3(0, 6, 0));
      camTarget.copy(pos).add(new THREE.Vector3(0, 2, 0));
    } else if (cameraMode === "aerial") {
      camDesired.set(center.x, center.y + 42, center.z + 8);
      camTarget.copy(pos).add(new THREE.Vector3(0, 1, 0));
    } else if (cameraMode === "ridge") {
      camDesired.copy(pos).add(right.clone().multiplyScalar(14)).add(new THREE.Vector3(0, 5, 0));
      camTarget.copy(pos).add(tan.clone().multiplyScalar(6));
    } else {
      camDesired.copy(pos).add(new THREE.Vector3(0, 1.6, 0));
      camTarget.copy(pos).add(tan.clone().multiplyScalar(12)).add(new THREE.Vector3(0, 1, 0));
    }

    const lerp = 1 - Math.pow(0.001, dt || 0.016);
    camera.position.lerp(camDesired, lerp * 0.12);
    camera.lookAt(camTarget);
  }

  function setWeatherVisual(id) {
    weatherId = id || "clear";
    if (!scene) return;
    const profile = WEATHER_PROFILES[weatherId] || WEATHER_PROFILES.clear;
    const fogCol = new THREE.Color(profile.fogColor);
    scene.fog = new THREE.FogExp2(fogCol.getHex(), profile.fog);
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
    if (player && worldPts[playerIdx]) {
      const p = worldPts[playerIdx];
      const target = new THREE.Vector3(p.x, p.y + 0.55, p.z);
      player.position.lerp(target, 0.18);
      playerGlow.position.copy(player.position);
      playerGlow.scale.setScalar(1 + Math.sin(clock.elapsedTime * 2) * 0.08);
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

  function init(points) {
    if (ready || !points || !points.length || typeof THREE === "undefined") return;
    canvas = document.getElementById("map3d");
    if (!canvas) return;

    worldPts = buildWorldPoints(points);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1419);

    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;

    hemiLight = new THREE.HemisphereLight(0x9eb8d8, 0x1a2820, 0.55);
    scene.add(hemiLight);
    dirLight = new THREE.DirectionalLight(0xfff0dd, 1.1);
    dirLight.position.set(40, 60, 25);
    dirLight.castShadow = true;
    scene.add(dirLight);

    buildTerrain();
    buildTrail();
    buildMarkers();
    buildPlayer();
    buildWeatherFX();
    setWeatherVisual("clear");

    const mid = worldPts[Math.floor(worldPts.length / 2)];
    camera.position.set(mid.x - 20, mid.y + 25, mid.z + 30);
    camera.lookAt(mid.x, mid.y, mid.z);

    clock = new THREE.Clock();
    resize();
    ready = true;
    animate();
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

  function setCameraMode(mode) {
    if (CAM_ORDER.includes(mode)) cameraMode = mode;
  }

  function cycleCameraMode() {
    const i = CAM_ORDER.indexOf(cameraMode);
    cameraMode = CAM_ORDER[(i + 1) % CAM_ORDER.length];
    return cameraMode;
  }

  function getCameraLabel() {
    return CAM_LABELS[cameraMode] || cameraMode;
  }

  function isReady() {
    return ready;
  }

  return {
    init,
    update,
    resize,
    setCameraMode,
    cycleCameraMode,
    getCameraLabel,
    isReady,
  };
})();

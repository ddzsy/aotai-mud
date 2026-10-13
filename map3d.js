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
  let snow = null;
  let cameraMode = "follow";
  let playerIdx = 0;
  let weatherId = "clear";
  let animId = 0;
  let camTarget = new THREE.Vector3();
  let camDesired = new THREE.Vector3();

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

  function buildSnow() {
    const count = 1200;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 80;
      pos[i * 3 + 1] = Math.random() * 35 + 5;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 80;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    snow = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.12,
        transparent: true,
        opacity: 0.7,
      })
    );
    snow.visible = false;
    scene.add(snow);
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
    const foggy = ["fog", "whiteout", "blizzard", "snow", "rain", "heavy_rain", "storm"].includes(weatherId);
    scene.fog = new THREE.FogExp2(0x0f1419, foggy ? 0.018 : 0.008);
    if (snow) {
      snow.visible = weatherId === "blizzard" || weatherId === "snow";
    }
    const dir = scene.children.find((c) => c.isDirectionalLight);
    if (dir) {
      dir.intensity = weatherId === "clear" ? 1.15 : weatherId === "storm" ? 0.45 : 0.75;
    }
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
    if (snow && snow.visible) {
      const arr = snow.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] -= dt * (weatherId === "blizzard" ? 9 : 4);
        if (arr[i + 1] < 0) arr[i + 1] = 30 + Math.random() * 10;
      }
      snow.geometry.attributes.position.needsUpdate = true;
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
    setWeatherVisual("clear");

    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;

    const hemi = new THREE.HemisphereLight(0x9eb8d8, 0x1a2820, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.1);
    sun.position.set(40, 60, 25);
    sun.castShadow = true;
    scene.add(sun);

    buildTerrain();
    buildTrail();
    buildMarkers();
    buildPlayer();
    buildSnow();

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

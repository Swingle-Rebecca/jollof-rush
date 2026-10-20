import * as THREE from './vendor/three.module.js';

/* =====================================================================
   start.ng connection (connect page via postMessage)
   ===================================================================== */
const START_NG = 'https://start.ng';
let frame;
function connectFrame() {
  frame ??= new Promise((resolve, reject) => {
    const el = document.createElement('iframe');
    el.src = `${START_NG}/connect`;
    el.hidden = true;
    el.onload = () => resolve(el);
    el.onerror = reject;
    document.body.append(el);
  });
  return frame;
}
// Resolves to start.ng's reply, or null if it never answers (e.g. opened as a local file).
function askStartNg(message, replyType, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    let el = null;
    let settled = false;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      resolve(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function onMessage(e) {
      if (e.origin !== START_NG || !el || e.source !== el.contentWindow) return;
      if (e.data?.type === replyType && e.data.requestId === requestId) finish(e.data);
    }
    addEventListener('message', onMessage);
    connectFrame()
      .then((f) => { el = f; f.contentWindow.postMessage({ ...message, requestId }, START_NG); })
      .catch(() => finish(null));
  });
}
const signInUrl = () => `${START_NG}/?return_to=${encodeURIComponent(location.origin + location.pathname)}`;

const DEFAULT_STYLE = {
  body: 'female', primaryColor: '#e8590c', secondaryColor: '#364fc7', skinColor: '#8d5524',
  hairColor: '#17120f', hair: 'braids', hat: 'none', accessory: 'none',
};

let player = { name: 'Guest', account: null, style: DEFAULT_STYLE, face: null, id: null, signedIn: false };
const isGuestMode = new URLSearchParams(location.search).has('guest');

async function refreshPlayer() {
  const reply = await askStartNg({ type: 'startng:whoami' }, 'startng:user');
  const p = reply?.user ?? reply?.guest;
  if (!p) return; // not answered: keep whatever we have (local file / offline)
  const next = {
    name: p.name || 'Guest',
    account: reply.user?.account ?? null,
    style: { ...DEFAULT_STYLE, ...(p.style || {}) },
    face: p.face || null,
    id: reply.user?.id ?? null,
    signedIn: !!reply.user,
  };
  const changed = JSON.stringify(next.style) !== JSON.stringify(player.style);
  player = next;
  renderCard();
  if (changed) rebuildPlayerModel();
}

/* =====================================================================
   DOM helpers
   ===================================================================== */
const $ = (s) => document.querySelector(s);
const el = {
  card: $('#player-card'), face: $('#player-face'), name: $('#player-name'), account: $('#player-account'),
  signIn: $('#player-sign-in'), stats: $('#stats'), score: $('#score'), time: $('#time'), orders: $('#orders'),
  holding: $('#holding'), prompt: $('#prompt'), toast: $('#toast'), stick: $('#stick'), knob: $('#knob'), act: $('#act'),
  title: $('#title'), over: $('#over'), start: $('#start'), again: $('#again'), rScore: $('#r-score'),
  rDishes: $('#r-dishes'), saveMsg: $('#save-msg'), board: $('#board'), overSignIn: $('#over-sign-in'),
};

function fallbackFace(style) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#d8fd71'; g.fillRect(0, 0, 96, 96);
  g.fillStyle = style.hairColor; g.beginPath(); g.arc(48, 46, 32, Math.PI, 0); g.fill();
  g.fillStyle = style.skinColor; g.fillRect(22, 44, 52, 40);
  g.fillStyle = '#111'; g.fillRect(34, 54, 7, 7); g.fillRect(55, 54, 7, 7);
  return c.toDataURL();
}
function renderCard() {
  el.face.src = player.face || fallbackFace(player.style);
  el.name.textContent = player.name;
  el.account.textContent = player.account ? `@${player.account}` : 'Not signed in';
  el.signIn.hidden = player.signedIn;
  el.overSignIn.hidden = player.signedIn;
  el.card.hidden = false;
}
el.signIn.onclick = el.overSignIn.onclick = () => { location.href = signInUrl(); };

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove('show');
  void el.toast.offsetWidth;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 900);
}

/* tiny sound effects */
let actx;
function beep(freq = 440, dur = 0.08, type = 'square', vol = 0.05, slide = 0) {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, actx.currentTime + dur);
    g.gain.value = vol; g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
  } catch { /* sound is optional */ }
}
const sfx = {
  pick: () => beep(520, 0.07, 'square'),
  drop: () => beep(330, 0.08, 'square'),
  done: () => { beep(660, 0.1, 'triangle', 0.08); setTimeout(() => beep(880, 0.15, 'triangle', 0.08), 90); },
  serve: () => { beep(523, 0.1, 'triangle', 0.09); setTimeout(() => beep(784, 0.1, 'triangle', 0.09), 90); setTimeout(() => beep(1046, 0.18, 'triangle', 0.09), 180); },
  bad: () => beep(160, 0.2, 'sawtooth', 0.06, -60),
  burn: () => beep(120, 0.35, 'sawtooth', 0.07, -40),
};

/* =====================================================================
   three.js scene
   ===================================================================== */
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#3a271b');
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
const camTarget = new THREE.Vector3(1.0, 0.4, -2.2);

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const dist = Math.min(Math.max(37 / camera.aspect, 17), 60);
  camera.position.set(camTarget.x, camTarget.y + dist * 0.82, camTarget.z + dist * 0.57);
  camera.lookAt(camTarget);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

scene.add(new THREE.HemisphereLight('#fff4e0', '#6b4a35', 1.0));
const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
sun.position.set(-6, 16, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 12, bottom: -12, near: 1, far: 40 });
sun.shadow.bias = -0.0004;
scene.add(sun);

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...opts }));
  return matCache.get(key);
}
function box(w, h, d, color, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, color, x = 0, y = 0, z = 0, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat(color));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function ball(r, color, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat(color));
  m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = true;
  return m;
}

/* ---- floor, walls, counters ---- */
function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f2e3c9'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#d9c19b'; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(12, 6);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 12), new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, -2); floor.receiveShadow = true;
scene.add(floor);

scene.add(box(24, 5, 0.5, '#e8a15b', 0, 2.5, -8.25));          // back wall
scene.add(box(0.5, 5, 12, '#d98f47', 12.25, 2.5, -2));           // right wall
scene.add(box(0.5, 5, 12, '#d98f47', -12.25, 2.5, -2));          // left wall
scene.add(box(24, 0.08, 0.5, '#7a3e1d', 0, 1.55, -7.95));       // wall trim
// back counter + right counter
scene.add(box(21, 1, 2.0, '#8a5a3b', -1.5, 0.5, -6.9));
scene.add(box(21, 0.12, 2.1, '#d8d4cb', -1.5, 1.04, -6.9));
scene.add(box(2.0, 1, 9, '#8a5a3b', 10.3, 0.5, -1.5));
scene.add(box(2.1, 0.12, 9, '#d8d4cb', 10.3, 1.04, -1.5));
// a hanging sign
{
  const sign = box(7, 1.1, 0.2, '#2a1a10', -2, 3.3, -7.9);
  scene.add(sign);
  const c = document.createElement('canvas'); c.width = 700; c.height = 110;
  const g = c.getContext('2d'); g.fillStyle = '#d8fd71'; g.font = '800 70px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('JOLLOF RUSH', 350, 58);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const p = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 1.07), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  p.position.set(-2, 3.3, -7.78); scene.add(p);
}

/* ---- labels / bars ---- */
function labelSprite(text, emoji, w = 2.2) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(30,20,14,.86)';
  g.beginPath(); g.roundRect(8, 8, 240, 112, 28); g.fill();
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  if (emoji) { g.font = '54px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'; g.fillText(emoji, 128, 44); }
  g.font = '800 32px system-ui, sans-serif';
  g.fillText(text, 128, emoji ? 96 : 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(w, w / 2, 1); s.renderOrder = 10;
  return s;
}
function emojiTexture(emoji) {
  const c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d'); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '70px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
  g.fillText(emoji, 48, 52);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeBar() {
  const g = new THREE.Group();
  const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#1d1410', depthTest: false, transparent: true }));
  bg.scale.set(1.5, 0.26, 1); bg.center.set(0, 0.5); bg.position.x = -0.75; bg.renderOrder = 11;
  const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#7ed957', depthTest: false, transparent: true }));
  fg.scale.set(0.001, 0.18, 1); fg.center.set(0, 0.5); fg.position.x = -0.7; fg.renderOrder = 12;
  g.add(bg, fg);
  g.userData.set = (p, color) => { fg.scale.x = Math.max(0.001, 1.4 * p); if (color) fg.material.color.set(color); };
  g.visible = false;
  return g;
}

/* ---- food meshes ---- */
const FOOD = {
  tomato: () => { const g = new THREE.Group(); g.add(ball(0.28, '#e03131', 0, 0.28)); g.add(ball(0.1, '#2f9e44', 0, 0.58, 0, 1, 0.4, 1)); return g; },
  ctomato: () => { const g = new THREE.Group(); [[-0.12, 0, 0], [0.12, 0, 0.05], [0, 0.14, -0.1], [-0.05, 0.02, 0.15]].forEach(([x, y, z]) => g.add(box(0.2, 0.14, 0.2, '#e03131', x, 0.1 + y, z))); return g; },
  rice: () => { const g = new THREE.Group(); g.add(box(0.5, 0.5, 0.35, '#f4eee0', 0, 0.25)); g.add(box(0.5, 0.14, 0.36, '#c9a063', 0, 0.45)); return g; },
  chicken: () => { const g = new THREE.Group(); g.add(ball(0.3, '#c98a4b', 0, 0.28, 0, 1, 0.9, 0.9)); const bone = cyl(0.06, 0.06, 0.4, '#f1e9d8', 0.28, 0.22, 0); bone.rotation.z = 1.1; g.add(bone); return g; },
  jollof: () => { const g = new THREE.Group(); g.add(cyl(0.34, 0.4, 0.2, '#e8590c', 0, 0.12)); g.add(cyl(0.2, 0.3, 0.15, '#f08c3a', 0, 0.28)); g.add(ball(0.06, '#2f9e44', 0.1, 0.38, 0.05)); return g; },
  burnt: () => { const g = new THREE.Group(); g.add(cyl(0.34, 0.4, 0.2, '#1a1a1a', 0, 0.12)); g.add(cyl(0.2, 0.3, 0.15, '#2b2b2b', 0, 0.28)); return g; },
};
function plateMesh(items) {
  const g = new THREE.Group();
  g.add(cyl(0.55, 0.45, 0.08, '#fffefa', 0, 0.04, 0, 24));
  g.add(cyl(0.38, 0.38, 0.02, '#e9e4d6', 0, 0.09, 0, 24));
  items.forEach((it, i) => {
    const f = FOOD[it](); f.scale.setScalar(0.85);
    f.position.set(items.length > 1 ? (i ? 0.2 : -0.2) : 0, 0.08, 0);
    g.add(f);
  });
  return g;
}

/* ---- stations ---- */
const stations = [];
function counterTop(st) { return 1.1; }
function addStation(def) {
  const st = { ...def, group: new THREE.Group(), bar: makeBar() };
  st.group.position.set(def.x, counterTop(st), def.z);
  scene.add(st.group);
  st.bar.position.set(0, 1.75, 0.2);
  st.group.add(st.bar);
  stations.push(st);
  return st;
}

function buildCrate(st, label, emoji) {
  st.group.add(box(1.7, 0.7, 1.4, '#a8743f', 0, 0.35, 0));
  st.group.add(box(1.76, 0.1, 1.46, '#8a5a2b', 0, 0.72, 0));
  const f = FOOD[st.item](); f.position.set(0, 0.72, 0); f.scale.setScalar(1.3); st.group.add(f);
  const l = labelSprite(label, emoji, 2.0); l.position.set(0, 1.9, 0.5); st.group.add(l);
}

addStation({ id: 'tomato', type: 'crate', item: 'tomato', x: -8.2, z: -6.9 });
addStation({ id: 'rice', type: 'crate', item: 'rice', x: -5.8, z: -6.9 });
addStation({ id: 'chicken', type: 'crate', item: 'chicken', x: -3.4, z: -6.9 });
buildCrate(stations[0], 'Tomatoes', '🍅');
buildCrate(stations[1], 'Rice', '🍚');
buildCrate(stations[2], 'Chicken', '🍗');

// chopping board
const board = addStation({ id: 'board', type: 'board', x: -0.5, z: -6.9 });
board.state = 'empty'; board.t = 0;
board.group.add(box(1.7, 0.12, 1.2, '#e7c58f', 0, 0.06, 0));
board.food = new THREE.Group(); board.food.position.y = 0.12; board.group.add(board.food);
const bl = labelSprite('Chop', '🔪', 1.6); bl.position.set(0, 1.9, 0.5); board.group.add(bl);

// pot
const pot = addStation({ id: 'pot', type: 'pot', x: 2.6, z: -6.9 });
Object.assign(pot, { state: 'idle', rice: false, tom: false, t: 0 });
pot.group.add(cyl(0.7, 0.62, 0.8, '#3b3b42', 0, 0.4, 0, 24));
pot.group.add(cyl(0.74, 0.74, 0.08, '#55555e', 0, 0.82, 0, 24));
pot.fill = cyl(0.62, 0.62, 0.05, '#222', 0, 0.86, 0, 24); pot.fill.visible = false; pot.group.add(pot.fill);
pot.group.add(box(0.5, 0.1, 0.12, '#222', 0.95, 0.65, 0));
const pl = labelSprite('Pot', '🍲', 1.6); pl.position.set(0, 1.9, 0.5); pot.group.add(pl);

// pan
const pan = addStation({ id: 'pan', type: 'pan', x: 5.7, z: -6.9 });
Object.assign(pan, { state: 'idle', t: 0 });
pan.group.add(cyl(0.75, 0.6, 0.2, '#2e2e33', 0, 0.1, 0, 24));
pan.group.add(box(1.0, 0.08, 0.14, '#1a1a1a', 1.05, 0.14, 0));
pan.fill = cyl(0.55, 0.55, 0.05, '#c98a4b', 0, 0.2, 0, 24); pan.fill.visible = false; pan.group.add(pan.fill);
const panl = labelSprite('Pan', '🍳', 1.6); panl.position.set(0, 1.9, 0.5); pan.group.add(panl);

// status icons over pot & pan
const tex = { done: emojiTexture('✅'), burn: emojiTexture('🔥') };
for (const s of [pot, pan]) {
  s.icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.done, depthTest: false, transparent: true }));
  s.icon.scale.set(0.9, 0.9, 1); s.icon.position.set(0, 1.2, 0.3); s.icon.renderOrder = 13; s.icon.visible = false;
  s.group.add(s.icon);
}
// ingredient hints on the pot
pot.hint = new THREE.Group(); pot.hint.position.set(-0.3, 0.9, 0.4); pot.group.add(pot.hint);

// plates
const plates = addStation({ id: 'plates', type: 'plates', x: 10.3, z: -4.0 });
for (let i = 0; i < 5; i++) plates.group.add(cyl(0.55, 0.5, 0.07, '#fffefa', 0, 0.04 + i * 0.08, 0, 24));
const pll = labelSprite('Plates', '🍽️', 1.7); pll.position.set(0, 1.9, 0.3); plates.group.add(pll);

// serve window
const serve = addStation({ id: 'serve', type: 'serve', x: 10.3, z: -1.2 });
serve.group.add(box(1.5, 0.12, 1.8, '#2f9e44', 0, 0.06, 0));
serve.group.add(box(0.12, 1.2, 1.8, '#1f7a33', 0.7, 0.6, 0));
const sl = labelSprite('Serve', '🛎️', 1.7); sl.position.set(0, 1.9, 0.3); serve.group.add(sl);

// bin
const bin = addStation({ id: 'bin', type: 'bin', x: 10.3, z: 1.6 });
bin.group.add(cyl(0.6, 0.5, 1.0, '#59616b', 0, 0.5, 0, 16));
bin.group.add(cyl(0.64, 0.64, 0.1, '#3d434a', 0, 1.0, 0, 16));
const binl = labelSprite('Bin', '🗑️', 1.5); binl.position.set(0, 1.9, 0.3); bin.group.add(binl);

// highlight ring for nearest station
const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.1, 32), new THREE.MeshBasicMaterial({ color: '#d8fd71', transparent: true, opacity: 0.9, depthTest: false }));
ring.rotation.x = -Math.PI / 2; ring.renderOrder = 9; ring.visible = false;
scene.add(ring);

/* ---- player character ---- */
function buildCharacter(raw) {
  const s = { ...DEFAULT_STYLE, ...(raw || {}) };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = s.skinColor, hairC = s.hairColor, P = s.primaryColor, S = s.secondaryColor;

  // legs (pivot at hip)
  const mkLeg = (x) => { const l = new THREE.Group(); l.position.set(x, 0.92, 0); l.add(box(0.3, 0.92, 0.32, S, 0, -0.46, 0)); l.add(box(0.32, 0.14, 0.42, '#222', 0, -0.88, 0.05)); return l; };
  const legL = mkLeg(-0.2), legR = mkLeg(0.2);
  body.add(legL, legR);
  if (s.body === 'female') body.add(cyl(0.42, 0.56, 0.5, S, 0, 0.98, 0, 16));
  // torso, arms
  body.add(box(0.86, 0.95, 0.5, P, 0, 1.4, 0));
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.55, 1.78, 0); armR.position.set(0.55, 1.78, 0);
  armL.add(box(0.22, 0.8, 0.26, P, 0, -0.38, 0)); armL.add(box(0.2, 0.2, 0.22, skin, 0, -0.84, 0));
  armR.add(box(0.22, 0.8, 0.26, P, 0, -0.38, 0)); armR.add(box(0.2, 0.2, 0.22, skin, 0, -0.84, 0));
  body.add(armL, armR);
  // head
  body.add(box(0.62, 0.62, 0.6, skin, 0, 2.12, 0));
  body.add(box(0.09, 0.12, 0.04, '#111', -0.15, 2.15, 0.31), box(0.09, 0.12, 0.04, '#111', 0.15, 2.15, 0.31));
  body.add(box(0.14, 0.04, 0.04, '#6a2c2c', 0, 1.97, 0.31));

  // hair
  const cap = () => { body.add(box(0.68, 0.18, 0.66, hairC, 0, 2.46, 0)); body.add(box(0.68, 0.42, 0.14, hairC, 0, 2.24, -0.3)); body.add(box(0.1, 0.3, 0.5, hairC, -0.33, 2.3, -0.02), box(0.1, 0.3, 0.5, hairC, 0.33, 2.3, -0.02)); };
  switch (s.hair) {
    case 'short': cap(); break;
    case 'afro': body.add(ball(0.55, hairC, 0, 2.36, -0.04, 1, 0.95, 1)); break;
    case 'braids': cap(); for (const x of [-0.27, -0.09, 0.09, 0.27]) body.add(box(0.1, 0.85, 0.1, hairC, x, 1.95, -0.34)); break;
    case 'bun': cap(); body.add(ball(0.22, hairC, 0, 2.7, -0.05)); break;
    case 'ponytail': cap(); body.add(box(0.14, 0.14, 0.4, hairC, 0, 2.42, -0.5)); body.add(box(0.16, 0.6, 0.16, hairC, 0, 2.15, -0.7)); break;
    case 'dreads': cap(); for (let i = -3; i <= 3; i++) body.add(box(0.1, 0.7, 0.1, hairC, i * 0.095, 2.0, -0.34)); body.add(box(0.1, 0.5, 0.1, hairC, -0.34, 2.1, 0.0), box(0.1, 0.5, 0.1, hairC, 0.34, 2.1, 0.0)); break;
    case 'bald': break;
    default: cap();
  }
  // hat
  switch (s.hat) {
    case 'cap': body.add(box(0.72, 0.18, 0.7, P, 0, 2.52, 0)); body.add(box(0.7, 0.05, 0.36, P, 0, 2.46, 0.5)); break;
    case 'beanie': body.add(ball(0.42, S, 0, 2.5, 0, 1, 0.8, 1)); body.add(ball(0.09, P, 0, 2.88)); break;
    case 'tophat': body.add(cyl(0.5, 0.5, 0.05, '#222', 0, 2.47, 0)); body.add(cyl(0.3, 0.3, 0.55, '#222', 0, 2.75, 0)); body.add(cyl(0.31, 0.31, 0.1, P, 0, 2.58, 0)); break;
    case 'crown': body.add(cyl(0.3, 0.32, 0.22, '#f5c518', 0, 2.55, 0)); for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; const c = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 6), mat('#f5c518')); c.position.set(Math.cos(a) * 0.26, 2.76, Math.sin(a) * 0.26); c.castShadow = true; body.add(c); } break;
  }
  // accessory
  switch (s.accessory) {
    case 'glasses': body.add(box(0.22, 0.16, 0.04, '#222', -0.15, 2.15, 0.33), box(0.22, 0.16, 0.04, '#222', 0.15, 2.15, 0.33), box(0.1, 0.04, 0.04, '#222', 0, 2.17, 0.33)); break;
    case 'earrings': body.add(ball(0.07, '#f5c518', -0.34, 1.95, 0.05), ball(0.07, '#f5c518', 0.34, 1.95, 0.05)); break;
    case 'beard': body.add(box(0.5, 0.26, 0.14, hairC, 0, 1.9, 0.27)); break;
    case 'scarf': body.add(box(0.96, 0.2, 0.62, S, 0, 1.86, 0)); body.add(box(0.2, 0.55, 0.1, S, 0.25, 1.55, 0.3)); break;
    case 'backpack': body.add(box(0.62, 0.74, 0.3, S, 0, 1.45, -0.4)); break;
  }
  // chef apron so it reads as a kitchen (small, keeps their top colour visible)
  body.add(box(0.6, 0.62, 0.05, '#fffefa', 0, 1.22, 0.27));
  root.userData = { legL, legR, armL, armR };
  return root;
}

let playerModel;
const hold = { item: null, mesh: null };
const heldGroup = new THREE.Group(); // follows player, in front of chest
function rebuildPlayerModel() {
  const pos = playerModel?.position.clone() ?? new THREE.Vector3(0, 0, 0.5);
  const rot = playerModel?.rotation.y ?? 0;
  if (playerModel) scene.remove(playerModel);
  playerModel = buildCharacter(player.style);
  playerModel.position.copy(pos); playerModel.rotation.y = rot;
  heldGroup.position.set(0, 1.45, 0.85);
  playerModel.add(heldGroup);
  scene.add(playerModel);
}

/* =====================================================================
   Game state
   ===================================================================== */
const ROUND_SECONDS = 120;
const RECIPES = {
  jollof: { name: 'Jollof Rice', emoji: '🍛', items: ['jollof'], points: 30, time: 55 },
  chicken: { name: 'Fried Chicken', emoji: '🍗', items: ['chicken'], points: 30, time: 55 },
  combo: { name: 'Jollof + Chicken', emoji: '🍛🍗', items: ['chicken', 'jollof'], points: 80, time: 75 },
};
const state = { mode: 'title', time: ROUND_SECONDS, score: 0, dishes: 0, orders: [], nextOrderIn: 1, orderId: 1 };
const keys = new Set();
const stickVec = { x: 0, z: 0 };
let nearest = null;

function setHold(item) {
  hold.item = item;
  heldGroup.clear();
  if (!item) { el.holding.hidden = true; return; }
  let mesh;
  if (item.type === 'plate') mesh = plateMesh(item.items);
  else mesh = FOOD[item.type]();
  mesh.scale.setScalar(item.type === 'plate' ? 0.9 : 1.1);
  heldGroup.add(mesh);
  el.holding.textContent = `Holding: ${holdName(item)}`;
  el.holding.hidden = state.mode !== 'playing';
}
function holdName(it) {
  const names = { tomato: '🍅 Tomato', ctomato: '🍅 Chopped tomato', rice: '🍚 Rice', chicken: '🍗 Raw chicken', jollof: '🍛 Jollof', burnt: '💨 Burnt food' };
  if (it.type === 'plate') return it.items.length ? `🍽️ Plate (${it.items.map((i) => names[i].split(' ').slice(1).join(' ')).join(' + ')})` : '🍽️ Empty plate';
  return names[it.type];
}

function resetStations() {
  board.state = 'empty'; board.t = 0; board.food.clear(); board.bar.visible = false;
  Object.assign(pot, { state: 'idle', rice: false, tom: false, t: 0 }); pot.fill.visible = false; pot.icon.visible = false; pot.bar.visible = false; pot.hint.clear();
  Object.assign(pan, { state: 'idle', t: 0 }); pan.fill.visible = false; pan.icon.visible = false; pan.bar.visible = false;
}

function startRound() {
  state.mode = 'playing'; state.time = ROUND_SECONDS; state.score = 0; state.dishes = 0; state.orders = []; state.nextOrderIn = 1; state.orderId = 1;
  resetStations(); setHold(null);
  playerModel.position.set(0, 0, 0.5);
  el.title.hidden = true; el.over.hidden = true;
  el.stats.hidden = false; el.orders.hidden = false;
  el.stats.classList.remove('low');
  el.score.textContent = '0';
  renderOrders(true);
  beep(660, 0.12, 'triangle', 0.08);
}

function spawnOrder() {
  const roll = Math.random();
  const key = state.dishes < 2 && state.orders.length === 0 ? (roll < 0.5 ? 'jollof' : 'chicken') : roll < 0.38 ? 'jollof' : roll < 0.68 ? 'chicken' : 'combo';
  const r = RECIPES[key];
  state.orders.push({ id: state.orderId++, key, t: r.time, max: r.time });
  renderOrders(true);
  beep(880, 0.08, 'sine', 0.06);
}

let lastOrderKey = '';
function renderOrders(force) {
  const k = state.orders.map((o) => o.id).join(',');
  if (force || k !== lastOrderKey) {
    lastOrderKey = k;
    el.orders.innerHTML = '';
    for (const o of state.orders) {
      const r = RECIPES[o.key];
      const d = document.createElement('div');
      d.className = 'order'; d.dataset.id = o.id;
      d.innerHTML = `<div class="e">${r.emoji}</div><div class="n">${r.name}</div><div class="bar"><i></i></div>`;
      el.orders.append(d);
    }
  }
  for (const d of el.orders.children) {
    const o = state.orders.find((x) => x.id === +d.dataset.id);
    if (!o) continue;
    const p = Math.max(0, o.t / o.max);
    d.querySelector('i').style.width = `${p * 100}%`;
    d.classList.toggle('warn', p < 0.5 && p >= 0.25);
    d.classList.toggle('late', p < 0.25);
  }
}

function addScore(n) { state.score = Math.max(0, state.score + n); el.score.textContent = state.score; }

/* ---- interaction ---- */
const hasItem = (plate, it) => plate.items.includes(it);

function findNearest() {
  if (state.mode !== 'playing') return null;
  let best = 2.7, found = null;
  for (const s of stations) {
    const d = Math.hypot(s.x - playerModel.position.x, s.z - playerModel.position.z);
    if (d < best) { best = d; found = s; }
  }
  return found;
}

function interact() {
  nearest = findNearest();
  if (state.mode !== 'playing' || !nearest) return;
  const st = nearest, h = hold.item;
  switch (st.type) {
    case 'crate':
      if (!h) { setHold({ type: st.item }); sfx.pick(); }
      else { toast('Hands full!'); sfx.bad(); }
      break;

    case 'board':
      if (st.state === 'empty' && h?.type === 'tomato') {
        st.state = 'chopping'; st.t = 0; st.food.add(FOOD.tomato()); setHold(null); sfx.drop();
      } else if (st.state === 'done' && !h) {
        setHold({ type: 'ctomato' }); st.state = 'empty'; st.food.clear(); st.bar.visible = false; sfx.pick();
      } else if (st.state === 'chopping') toast('Still chopping…');
      else if (h) { toast('Chop a raw tomato here'); sfx.bad(); }
      break;

    case 'pot':
      if (st.state === 'idle' && h?.type === 'rice' && !st.rice) { st.rice = true; setHold(null); potChanged(); sfx.drop(); }
      else if (st.state === 'idle' && h?.type === 'ctomato' && !st.tom) { st.tom = true; setHold(null); potChanged(); sfx.drop(); }
      else if (st.state === 'done' && h?.type === 'plate' && !hasItem(h, 'jollof') && h.items.length < 2) {
        h.items.push('jollof'); setHold(h); clearPot(); sfx.pick();
      } else if (st.state === 'done' && !h) { toast('Grab a plate first 🍽️'); sfx.bad(); }
      else if (st.state === 'burnt' && !h) { clearPot(); toast('Cleaned the pot'); sfx.drop(); }
      else if (st.state === 'cooking') toast('Cooking…');
      else if (h) { toast(st.state === 'idle' ? 'Pot needs rice + chopped tomato' : 'Not now'); sfx.bad(); }
      break;

    case 'pan':
      if (st.state === 'idle' && h?.type === 'chicken') { st.state = 'cooking'; st.t = 0; st.fill.visible = true; st.fill.material = mat('#d9a066'); setHold(null); sfx.drop(); }
      else if (st.state === 'done' && h?.type === 'plate' && !hasItem(h, 'chicken') && h.items.length < 2) {
        h.items.push('chicken'); setHold(h); clearPan(); sfx.pick();
      } else if (st.state === 'done' && !h) { toast('Grab a plate first 🍽️'); sfx.bad(); }
      else if (st.state === 'burnt' && !h) { clearPan(); toast('Cleaned the pan'); sfx.drop(); }
      else if (st.state === 'cooking') toast('Frying…');
      else if (h) { toast('Pan fries raw chicken'); sfx.bad(); }
      break;

    case 'plates':
      if (!h) { setHold({ type: 'plate', items: [] }); sfx.pick(); }
      else { toast('Hands full!'); sfx.bad(); }
      break;

    case 'serve':
      if (h?.type === 'plate' && h.items.length) serveHeld();
      else if (h) { toast('Put food on a plate first'); sfx.bad(); }
      break;

    case 'bin':
      if (h) { setHold(null); sfx.drop(); toast('Binned'); }
      break;
  }
}

function potChanged() {
  pot.hint.clear();
  if (pot.rice) { const r = FOOD.rice(); r.scale.setScalar(0.5); r.position.set(0, 0, 0); pot.hint.add(r); }
  if (pot.tom) { const t = FOOD.ctomato(); t.scale.setScalar(0.7); t.position.set(0.45, 0, 0); pot.hint.add(t); }
  if (pot.rice && pot.tom) { pot.state = 'cooking'; pot.t = 0; pot.fill.visible = true; pot.fill.material = mat('#e8590c'); pot.hint.clear(); }
}
function clearPot() { Object.assign(pot, { state: 'idle', rice: false, tom: false, t: 0 }); pot.fill.visible = false; pot.icon.visible = false; pot.bar.visible = false; pot.hint.clear(); }
function clearPan() { Object.assign(pan, { state: 'idle', t: 0 }); pan.fill.visible = false; pan.icon.visible = false; pan.bar.visible = false; }

function serveHeld() {
  const key = hold.item.items.slice().sort().join('+');
  const match = state.orders.filter((o) => RECIPES[o.key].items.slice().sort().join('+') === key).sort((a, b) => a.t - b.t)[0];
  if (!match) { toast('Nobody ordered that!'); sfx.bad(); return; }
  const r = RECIPES[match.key];
  const tip = Math.round(20 * Math.max(0, match.t / match.max));
  const pts = r.points + tip;
  addScore(pts); state.dishes++;
  state.orders = state.orders.filter((o) => o !== match);
  setHold(null); renderOrders(true);
  toast(`+${pts} 🪙${tip >= 12 ? ' Fast!' : ''}`);
  sfx.serve();
}

/* ---- per-frame game logic ---- */
const COOK = { chop: 2.2, pot: 7, potBurn: 6, pan: 5, panBurn: 5 };
function updateCooking(dt) {
  // chopping
  if (board.state === 'chopping') {
    board.t += dt; board.bar.visible = true; board.bar.userData.set(board.t / COOK.chop, '#4dabf7');
    board.food.rotation.y += dt * 8;
    if (board.t >= COOK.chop) { board.state = 'done'; board.food.clear(); board.food.rotation.y = 0; board.food.add(FOOD.ctomato()); board.bar.visible = false; sfx.done(); }
  }
  // pot
  if (pot.state === 'cooking') {
    pot.t += dt; pot.bar.visible = true; pot.bar.userData.set(pot.t / COOK.pot, '#ffa94d');
    pot.fill.position.y = 0.86 + Math.sin(performance.now() / 120) * 0.02;
    if (pot.t >= COOK.pot) { pot.state = 'done'; pot.t = 0; pot.fill.material = mat('#d9480f'); pot.icon.material.map = tex.done; pot.icon.visible = true; sfx.done(); }
  } else if (pot.state === 'done') {
    pot.t += dt; pot.bar.visible = true; pot.bar.userData.set(1 - pot.t / COOK.potBurn, pot.t > COOK.potBurn * 0.6 ? '#ff6b6b' : '#7ed957');
    pot.icon.scale.setScalar(0.9 + Math.sin(performance.now() / (pot.t > COOK.potBurn * 0.6 ? 90 : 300)) * 0.12);
    if (pot.t >= COOK.potBurn) { pot.state = 'burnt'; pot.fill.material = mat('#151515'); pot.icon.material.map = tex.burn; pot.bar.visible = false; sfx.burn(); toast('🔥 Pot burnt!'); }
  }
  // pan
  if (pan.state === 'cooking') {
    pan.t += dt; pan.bar.visible = true; pan.bar.userData.set(pan.t / COOK.pan, '#ffa94d');
    if (pan.t >= COOK.pan) { pan.state = 'done'; pan.t = 0; pan.fill.material = mat('#b8702f'); pan.icon.material.map = tex.done; pan.icon.visible = true; sfx.done(); }
  } else if (pan.state === 'done') {
    pan.t += dt; pan.bar.visible = true; pan.bar.userData.set(1 - pan.t / COOK.panBurn, pan.t > COOK.panBurn * 0.6 ? '#ff6b6b' : '#7ed957');
    pan.icon.scale.setScalar(0.9 + Math.sin(performance.now() / (pan.t > COOK.panBurn * 0.6 ? 90 : 300)) * 0.12);
    if (pan.t >= COOK.panBurn) { pan.state = 'burnt'; pan.fill.material = mat('#151515'); pan.icon.material.map = tex.burn; pan.bar.visible = false; sfx.burn(); toast('🔥 Pan burnt!'); }
  }
}

function updateOrders(dt) {
  state.nextOrderIn -= dt;
  if (state.nextOrderIn <= 0 && state.orders.length < 4) {
    spawnOrder();
    state.nextOrderIn = Math.max(9, 18 - (ROUND_SECONDS - state.time) / 12);
  }
  let expired = false;
  for (const o of state.orders) o.t -= dt;
  const live = state.orders.filter((o) => o.t > 0);
  if (live.length !== state.orders.length) { expired = true; state.orders = live; }
  if (expired) { addScore(-10); toast('Customer left! −10'); sfx.bad(); renderOrders(true); }
  else renderOrders(false);
}

const BOUNDS = { minX: -10.5, maxX: 8.9, minZ: -5.4, maxZ: 3.2 };
function updatePlayer(dt, t) {
  let dx = 0, dz = 0;
  if (state.mode === 'playing') {
    if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) dz -= 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) dz += 1;
    dx += stickVec.x; dz += stickVec.z;
  }
  const len = Math.hypot(dx, dz);
  const moving = len > 0.12;
  if (moving) {
    const k = Math.min(1, len) / len;
    dx *= k; dz *= k;
    const speed = 7;
    playerModel.position.x = THREE.MathUtils.clamp(playerModel.position.x + dx * speed * dt, BOUNDS.minX, BOUNDS.maxX);
    playerModel.position.z = THREE.MathUtils.clamp(playerModel.position.z + dz * speed * dt, BOUNDS.minZ, BOUNDS.maxZ);
    const target = Math.atan2(dx, dz);
    let diff = target - playerModel.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    playerModel.rotation.y += diff * Math.min(1, dt * 16);
  }
  const u = playerModel.userData;
  const swing = moving ? Math.sin(t * 14) * 0.7 : 0;
  u.legL.rotation.x = swing; u.legR.rotation.x = -swing;
  u.armL.rotation.x = hold.item ? -1.1 : -swing * 0.8; u.armR.rotation.x = hold.item ? -1.1 : swing * 0.8;
  playerModel.children[0].position.y = moving ? Math.abs(Math.sin(t * 14)) * 0.08 : 0;

  nearest = findNearest();
  if (nearest) {
    ring.visible = true; ring.position.set(nearest.x, 1.2, nearest.z);
    ring.scale.setScalar(1 + Math.sin(t * 8) * 0.05);
    el.prompt.textContent = promptFor(nearest);
    el.prompt.hidden = !el.prompt.textContent;
  } else { ring.visible = false; el.prompt.hidden = true; }
}

function promptFor(st) {
  const h = hold.item;
  const key = matchMedia('(pointer:coarse)').matches ? 'ACT' : 'E';
  switch (st.type) {
    case 'crate': return h ? '' : `${key}: take ${st.item}`;
    case 'board': return st.state === 'empty' ? (h?.type === 'tomato' ? `${key}: chop tomato` : '') : st.state === 'done' && !h ? `${key}: pick up chopped tomato` : '';
    case 'pot': return st.state === 'idle' && (h?.type === 'rice' || h?.type === 'ctomato') ? `${key}: add to pot` : st.state === 'done' && h?.type === 'plate' ? `${key}: scoop jollof` : st.state === 'burnt' && !h ? `${key}: clean pot` : '';
    case 'pan': return st.state === 'idle' && h?.type === 'chicken' ? `${key}: fry chicken` : st.state === 'done' && h?.type === 'plate' ? `${key}: plate the chicken` : st.state === 'burnt' && !h ? `${key}: clean pan` : '';
    case 'plates': return h ? '' : `${key}: take a plate`;
    case 'serve': return h?.type === 'plate' && h.items.length ? `${key}: serve` : '';
    case 'bin': return h ? `${key}: bin it` : '';
  }
  return '';
}

function endRound() {
  state.mode = 'over';
  el.stats.hidden = true; el.orders.hidden = true; el.holding.hidden = true; el.prompt.hidden = true; ring.visible = false;
  setHold(null);
  el.rScore.textContent = state.score; el.rDishes.textContent = state.dishes;
  el.board.innerHTML = '<li><span></span><span>Loading…</span></li>';
  el.saveMsg.textContent = '';
  el.over.hidden = false;
  sfx.serve();
  saveAndShowBoard();
}

async function saveAndShowBoard() {
  const stats = { score: Math.round(state.score), dishes: Math.round(state.dishes) };
  await refreshPlayer(); // they might have signed in during the round
  if (player.signedIn) {
    const saved = await askStartNg({ type: 'startng:score', stats }, 'startng:scoreSaved');
    if (saved?.ok) el.saveMsg.textContent = saved.result.improved ? `New personal best! You're #${saved.result.rank}` : `Not your best this time (you're #${saved.result.rank})`;
    else el.saveMsg.textContent = saved?.error || "Couldn't save your score.";
  } else {
    el.saveMsg.textContent = isGuestMode || !player.signedIn ? 'Sign in with start.ng to save your score.' : '';
  }
  const lb = await askStartNg({ type: 'startng:leaderboard', limit: 10 }, 'startng:leaderboardData');
  el.board.innerHTML = '';
  const entries = lb?.entries ?? [];
  if (!entries.length) { el.board.innerHTML = `<li><span></span><span>${lb ? 'No scores yet. Be the first!' : 'Leaderboard unavailable.'}</span></li>`; return; }
  for (const e of entries) {
    const li = document.createElement('li');
    if (player.id != null && e.player_id === player.id) li.className = 'me';
    const a = document.createElement('span'); a.textContent = `#${e.rank}`;
    const b = document.createElement('span'); b.textContent = e.name;
    const c = document.createElement('span'); c.textContent = `${e.stats?.score ?? e.score} pts · ${e.stats?.dishes ?? 0} 🍽️`;
    li.append(a, b, c); el.board.append(li);
  }
}

/* ---- loop ---- */
let last = performance.now(), tAcc = 0;
function frameLoop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; tAcc += dt;
  if (state.mode === 'playing') {
    state.time -= dt;
    updateCooking(dt); updateOrders(dt);
    const sec = Math.max(0, Math.ceil(state.time));
    el.time.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    el.stats.classList.toggle('low', state.time <= 15);
    if (state.time <= 0) endRound();
  }
  updatePlayer(dt, tAcc);
  // idle camera drift on the title screen
  if (state.mode === 'title') playerModel.rotation.y += dt * 0.8;
  renderer.render(scene, camera);
  requestAnimationFrame(frameLoop);
}

/* =====================================================================
   Input
   ===================================================================== */
addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyE' || e.code === 'Space') interact();
  if (e.code === 'Enter') { if (state.mode === 'title') startRound(); else if (state.mode === 'over') startRound(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

el.start.onclick = startRound;
el.again.onclick = startRound;
el.act.addEventListener('pointerdown', (e) => { e.preventDefault(); interact(); });

let stickId = null;
function moveStick(e) {
  const r = el.stick.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 14, len = Math.hypot(dx, dy);
  if (len > max) { dx *= max / len; dy *= max / len; }
  stickVec.x = dx / max; stickVec.z = dy / max;
  el.knob.style.transform = `translate(${dx}px, ${dy}px)`;
}
el.stick.addEventListener('pointerdown', (e) => { stickId = e.pointerId; el.stick.setPointerCapture(e.pointerId); moveStick(e); });
el.stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
for (const ev of ['pointerup', 'pointercancel']) el.stick.addEventListener(ev, (e) => {
  if (e.pointerId !== stickId) return;
  stickId = null; stickVec.x = stickVec.z = 0; el.knob.style.transform = 'translate(0,0)';
});
if (matchMedia('(pointer:coarse)').matches) { el.stick.hidden = false; el.act.hidden = false; }

// the player may sign in / out on start.ng in another tab
addEventListener('focus', refreshPlayer);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPlayer(); });

/* =====================================================================
   Go
   ===================================================================== */
resize();
rebuildPlayerModel();
renderCard();
refreshPlayer();
requestAnimationFrame(frameLoop);

// small hook so the game can be tested from outside
window.__jollofRush = { state, hold, stations, get player() { return playerModel; }, interact };

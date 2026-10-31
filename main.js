import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const status = document.getElementById('status');

// Two hand "slots" so each hand keeps its own particles
const hands = [null, null];       // each: { point, center, landmarks, isFist, isOpen }
const wasFist = [false, false];   // fist state last frame, per hand

// --- Scene setup ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// --- Hand shape map (MediaPipe point numbers) ---
const FINGER_CHAINS = [
  [1, 2, 3, 4],     // thumb
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];
const PALM_TRIS = [ // triangles that cover the palm
  [0, 1, 5], [0, 5, 9], [0, 9, 13], [0, 13, 17], [1, 2, 5],
];

// --- Particles ---
const COUNT = 15000;
const positions = new Float32Array(COUNT * 3);
const velocities = new Float32Array(COUNT * 3);
const offsets = new Float32Array(COUNT * 3); // each particle's spot in a small cloud

// Where each particle lives on the open hand
const onPalm = new Uint8Array(COUNT);     // 1 = palm, 0 = finger
const shapeIdx = new Uint8Array(COUNT);   // which palm triangle or which finger
const baryA = new Float32Array(COUNT);    // position inside its palm triangle
const baryB = new Float32Array(COUNT);
const flowSpeed = new Float32Array(COUNT); // how fast it streams up its finger
const flowPhase = new Float32Array(COUNT); // where along the finger it starts
const lastU = new Float32Array(COUNT);     // last spot along the finger (0 = knuckle, 1 = tip)

for (let i = 0; i < COUNT; i++) {
  positions[i * 3]     = (Math.random() - 0.5) * 10;
  positions[i * 3 + 1] = (Math.random() - 0.5) * 6;
  positions[i * 3 + 2] = (Math.random() - 0.5) * 2;

  // random point inside a sphere
  const r = Math.cbrt(Math.random()) * 0.9;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  offsets[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
  offsets[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  offsets[i * 3 + 2] = r * Math.cos(phi);

  if (Math.random() < 0) {
    // 30% fill the palm becomes // palm disabled
    onPalm[i] = 1;
    shapeIdx[i] = Math.floor(Math.random() * PALM_TRIS.length);
    let a = Math.random(), b = Math.random();
    if (a + b > 1) { a = 1 - a; b = 1 - b; } // keep it inside the triangle
    baryA[i] = a;
    baryB[i] = b;
  } else {
    // 60% stream along the fingers
    onPalm[i] = 0;
    shapeIdx[i] = Math.floor(Math.random() * FINGER_CHAINS.length);
    flowSpeed[i] = 0.8 + Math.random() * 0.7;
    flowPhase[i] = Math.random();
  }
}

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

const material = new THREE.PointsMaterial({
  color: 0x00e5ff,
  size: 0.03,
  transparent: true,
  opacity: 0.6,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

const particles = new THREE.Points(geometry, material);
scene.add(particles);

// --- Handle window resize ---
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- Convert hand point (0–1 video coords) to 3D world coords ---
function handToWorld(point) {
  // Where the video actually sits on screen (it's cropped to fill)
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.max(innerWidth / vw, innerHeight / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const sx = (innerWidth - dw) / 2 + (1 - point.x) * dw; // mirrored
  const sy = (innerHeight - dh) / 2 + point.y * dh;

  // Screen pixels → 3D world coords
  const height = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const width = height * camera.aspect;
  return {
    x: (sx / innerWidth - 0.5) * width,
    y: (0.5 - sy / innerHeight) * height,
  };
}

// Point at fraction u (0 = knuckle, 1 = tip) along a finger
function alongFinger(w, chain, u) {
  const pos = u * 3; // 3 segments per finger
  const k = Math.min(Math.floor(pos), 2);
  const f = pos - k;
  const A = w[chain[k]], B = w[chain[k + 1]];
  return { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f };
}

// --- Render loop ---
const PULL = 0.004;        // how strongly particles are pulled to your finger (pointing)
const DAMPING = 0.92;      // how quickly they slow down
const FLOW_PULL = 0.01;   // how tightly particles hug your open hand
const FINGER_WIDTH = 0.10; // thickness of the stream on each finger
const PALM_SOFTNESS = 0.06;// how fuzzy the palm edges are
const DRIFT = 0.0015;      // gentle wavy motion

function animate() {
  requestAnimationFrame(animate);

  const activeSlots = [0, 1].filter((s) => hands[s]);
  const time = performance.now() * 0.001;

  // Which hand controls particle i?
  // 2 hands → split in half. 1 hand → it gets all of them.
  const ownerOf = (i) =>
    activeSlots.length === 2 ? (i < COUNT / 2 ? 0 : 1) : activeSlots[0];

  // Fist just closed → explode that hand's particles evenly in all directions
  for (const s of activeSlots) {
    const h = hands[s];
    if (h.isFist && !wasFist[s]) {
      for (let i = 0; i < COUNT; i++) {
        if (ownerOf(i) !== s) continue;
        const ix = i * 3, iy = ix + 1, iz = ix + 2;

        const dx = offsets[ix] + (Math.random() - 0.5) * 0.3;
        const dy = offsets[iy] + (Math.random() - 0.5) * 0.3;
        const dz = offsets[iz] + (Math.random() - 0.5) * 0.3;
        const len = Math.hypot(dx, dy, dz) || 1;

        // Most stay fairly close, a few fly far, like a real explosion
        const power = 0.35 + Math.pow(Math.random(), 2) * 0.35;

        velocities[ix] = (dx / len) * power;
        velocities[iy] = (dy / len) * power;
        velocities[iz] = (dz / len) * power * 0.5;
      }
    }
  }
  // Remember fist state so the explosion fires only once per fist
  for (let s = 0; s < 2; s++) wasFist[s] = hands[s] ? hands[s].isFist : false;

  // Open hand → fluid flow over the hand.  Pointing → follow fingertip.
  if (activeSlots.length > 0) {
    const follow = [null, null];
    const flow = [null, null];     // all 21 hand points in world coords
    const handSize = [1, 1];       // so the dust scales with your hand
    for (const s of activeSlots) {
      const h = hands[s];
      if (h.isOpen) {
        const w = h.landmarks.map(handToWorld);
        flow[s] = w;
        handSize[s] = Math.hypot(w[9].x - w[0].x, w[9].y - w[0].y);
      } else if (!h.isFist) {
        follow[s] = handToWorld(h.point);
      }
    }

    for (let i = 0; i < COUNT; i++) {
      const s = ownerOf(i);
      const ix = i * 3, iy = ix + 1, iz = ix + 2;

      if (flow[s]) {
        const w = flow[s];
        const size = handSize[s];
        let tx, ty, spread;

        if (onPalm[i]) {
          // Fill the palm triangle
          const [a, b, c] = PALM_TRIS[shapeIdx[i]];
          tx = w[a].x + (w[b].x - w[a].x) * baryA[i] + (w[c].x - w[a].x) * baryB[i];
          ty = w[a].y + (w[b].y - w[a].y) * baryA[i] + (w[c].y - w[a].y) * baryB[i];
          spread = size * PALM_SOFTNESS;
        } else {
          // Stream from knuckle to fingertip, then loop back
          const u = (time * flowSpeed[i] + flowPhase[i]) % 1;
          const p = alongFinger(w, FINGER_CHAINS[shapeIdx[i]], u);
          tx = p.x;
          ty = p.y;
          spread = size * FINGER_WIDTH;

          // Reached the tip → restart at the knuckle without flying back across the finger
          if (u < lastU[i]) {
            positions[ix] = tx + offsets[ix] * spread;
            positions[iy] = ty + offsets[iy] * spread;
            velocities[ix] = 0;
            velocities[iy] = 0;
          }
          lastU[i] = u;
        }

        velocities[ix] += (tx + offsets[ix] * spread - positions[ix]) * FLOW_PULL;
        velocities[iy] += (ty + offsets[iy] * spread - positions[iy]) * FLOW_PULL;
        velocities[iz] += (offsets[iz] * 0.3 - positions[iz]) * FLOW_PULL;

        // Soft wavy drift so it feels like liquid light
        velocities[ix] += Math.sin(time * 2 + i * 0.37) * DRIFT;
        velocities[iy] += Math.cos(time * 1.7 + i * 0.53) * DRIFT;
      } else if (follow[s]) {
        const t = follow[s];
        velocities[ix] += (t.x + offsets[ix] - positions[ix]) * PULL;
        velocities[iy] += (t.y + offsets[iy] - positions[iy]) * PULL;
        velocities[iz] += (offsets[iz] - positions[iz]) * PULL;
      }
    }
  }

  for (let i = 0; i < COUNT * 3; i++) {
    velocities[i] *= DAMPING;
    positions[i] += velocities[i];
  }

  geometry.attributes.position.needsUpdate = true;
  renderer.render(scene, camera);
}
animate();

// --- Hand tracking ---
const video = document.getElementById('webcam');
let handLandmarker;

async function setupHands() {
  status.textContent = 'Loading hand tracking...';
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
  });

  status.textContent = 'Starting webcam...';
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  video.srcObject = stream;
  await video.play();

  status.textContent = 'Show your hand';
  trackHands();
}

const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [tip, middle joint]
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Fist = all 4 fingers curled (tip closer to wrist than its joint)
function checkFist(hand) {
  return FINGERS.every(([tip, joint]) => dist(hand[tip], hand[0]) < dist(hand[joint], hand[0]));
}

// Open = all 4 fingers stretched out (tip farther from wrist than its joint)
function checkOpen(hand) {
  return FINGERS.every(([tip, joint]) => dist(hand[tip], hand[0]) > dist(hand[joint], hand[0]));
}

let lastVideoTime = -1;
function trackHands() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = handLandmarker.detectForVideo(video, performance.now());
    const labels = result.handedness || result.handednesses || [];

    hands[0] = null;
    hands[1] = null;

    result.landmarks.forEach((hand, idx) => {
      // Use left/right labels so each hand keeps the same slot every frame
      const label = labels[idx]?.[0]?.categoryName;
      let slot = label === 'Left' ? 0 : 1;
      if (hands[slot]) slot = 1 - slot;

      const isFist = checkFist(hand);
      hands[slot] = {
        point: hand[8],    // index fingertip
        center: hand[9],   // palm center
        landmarks: hand,   // all 21 hand points
        isFist,
        isOpen: !isFist && checkOpen(hand),
      };
    });

    const count = result.landmarks.length;
    const anyFist = hands.some((h) => h && h.isFist);
    const anyOpen = hands.some((h) => h && h.isOpen);
    status.textContent =
      count === 0 ? 'Show your hand' :
      `${count} hand${count > 1 ? 's' : ''} detected` +
      (anyFist ? ': BOOM' : anyOpen ? ': FLOW' : '');
  }
  requestAnimationFrame(trackHands);
}

setupHands().catch((err) => {
  status.textContent = 'Error: ' + err.message;
  console.error(err);
});
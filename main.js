import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const status = document.getElementById('status');

// Two hand "slots" so each hand keeps its own particles
const hands = [null, null];       // each: { point, center, isFist }
const wasFist = [false, false];   // fist state last frame, per hand

// --- Scene setup ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// --- Particles ---
const COUNT = 3000;
const positions = new Float32Array(COUNT * 3);
const velocities = new Float32Array(COUNT * 3);
const offsets = new Float32Array(COUNT * 3); // each particle's spot in the swarm

for (let i = 0; i < COUNT; i++) {
  positions[i * 3]     = (Math.random() - 0.5) * 10;
  positions[i * 3 + 1] = (Math.random() - 0.5) * 6;
  positions[i * 3 + 2] = (Math.random() - 0.5) * 2;

  // random point inside a sphere, so particles form a cloud instead of one dot
  const r = Math.cbrt(Math.random()) * 0.9;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  offsets[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
  offsets[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  offsets[i * 3 + 2] = r * Math.cos(phi);
}

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

const material = new THREE.PointsMaterial({
  color: 0x66ccff,
  size: 0.04,
  transparent: true,
  opacity: 0.9,
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

// --- Convert hand point (0–1 screen coords) to 3D world coords ---
function handToWorld(point) {
  const height = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const width = height * camera.aspect;
  return {
    x: (0.5 - point.x) * width,   // flipped so it acts like a mirror
    y: (0.5 - point.y) * height,
  };
}

// --- Render loop ---
const PULL = 0.004;   // how strongly particles are pulled to your finger
const DAMPING = 0.92; // how quickly they slow down

function animate() {
  requestAnimationFrame(animate);

  const activeSlots = [0, 1].filter((s) => hands[s]);

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

        // Direction = the particle's own spot in the sphere, plus a little randomness
        const dx = offsets[ix] + (Math.random() - 0.5) * 0.3;
        const dy = offsets[iy] + (Math.random() - 0.5) * 0.3;
        const dz = offsets[iz] + (Math.random() - 0.5) * 0.3;
        const len = Math.hypot(dx, dy, dz) || 1;

        // Most stay fairly close, a few fly far, like a real explosion
        const power = 0.08 + Math.pow(Math.random(), 2) * 0.35;

        // "=" instead of "+=" wipes leftover motion so the burst stays centered
        velocities[ix] = (dx / len) * power;
        velocities[iy] = (dy / len) * power;
        velocities[iz] = (dz / len) * power * 0.5; // less toward/away from camera
      }
    }
  }
  
  // Open hand → pull its particles toward its fingertip
  if (activeSlots.length > 0) {
    const targets = [null, null];
    for (const s of activeSlots) {
      if (!hands[s].isFist) targets[s] = handToWorld(hands[s].point);
    }

    for (let i = 0; i < COUNT; i++) {
      const t = targets[ownerOf(i)];
      if (!t) continue;
      const ix = i * 3, iy = ix + 1, iz = ix + 2;
      velocities[ix] += (t.x + offsets[ix] - positions[ix]) * PULL;
      velocities[iy] += (t.y + offsets[iy] - positions[iy]) * PULL;
      velocities[iz] += (offsets[iz] - positions[iz]) * PULL;
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

// A finger is curled if its tip is closer to the wrist than its middle joint
function checkFist(hand) {
  const wrist = hand[0];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const fingers = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [tip, joint]
  return fingers.every(([tip, joint]) => dist(hand[tip], wrist) < dist(hand[joint], wrist));
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
      if (hands[slot]) slot = 1 - slot; // safety: never put both hands in one slot

      hands[slot] = {
        point: hand[8],   // index fingertip
        center: hand[9],  // base of middle finger, roughly palm center
        isFist: checkFist(hand),
      };
    });

    const count = result.landmarks.length;
    const anyFist = hands.some((h) => h && h.isFist);
    status.textContent =
      count === 0 ? 'Show your hand' :
      `${count} hand${count > 1 ? 's' : ''} detected${anyFist ? ': BOOM' : ''}`;
  }
  requestAnimationFrame(trackHands);
}

setupHands().catch((err) => {
  status.textContent = 'Error: ' + err.message;
  console.error(err);
});
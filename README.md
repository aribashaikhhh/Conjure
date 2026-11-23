# Conjure

**Physics said no. Conjure didn't.**

Control 15,000 glowing particles with your bare hands, right in the browser. Conjure tracks your hands through your webcam and turns every gesture into motion.

### ▶ [Try it live](https://aribashaikhhh.github.io/Conjure/)

*Allow camera access when asked. Nothing is uploaded; all tracking runs locally in your browser.*

<!-- Demo GIF goes here: ![Conjure demo](demo.gif) -->

---

## Gestures

| Gesture | What happens |
|---|---|
| ☝️ **Point** (index finger) | The particle cloud follows your fingertip |
| 🖐️ **Open hand** | Particles stream along each finger like liquid light |
| ✊ **Fist** | Boom. Particles burst outward in every direction |
| 🙌 **Two hands** | Particles split evenly and each hand controls its own half |

## How it works

1. **[MediaPipe Hands](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)** reads the webcam every frame and finds 21 points on each hand.
2. Gestures are detected from those points (for example, a fist means every fingertip is closer to the wrist than its middle joint).
3. Each particle has a position and a velocity. Every frame it is pulled, streamed, or blasted depending on the gesture, then slowed by damping for smooth motion.
4. **[Three.js](https://threejs.org/)** draws all the particles on top of a full-screen, mirrored camera feed using additive blending for the glow.

## Built with

- JavaScript (ES modules)
- Three.js
- MediaPipe Tasks Vision (hand landmarker)
- HTML / CSS
- Hosted on GitHub Pages

No build step and no dependencies to install. Libraries load from a CDN.

## Run it locally

Browsers only allow webcam access on `localhost` or HTTPS, so opening `index.html` directly won't work.

1. Clone the repo:
   ```bash
   git clone https://github.com/aribashaikhhh/Conjure.git
   ```
2. Open the folder in VS Code and start it with the **Live Server** extension, or run:
   ```bash
   npx serve .
   ```
3. Open the local link, allow the camera, and raise your hand.

## Tweak it

All the settings live near the top of `main.js`:

| Setting | What it changes |
|---|---|
| `COUNT` | Number of particles |
| `color`, `size`, `opacity` | Particle look (in `PointsMaterial`) |
| `FINGER_WIDTH` | Thickness of the stream on each finger |
| `flowSpeed` | How fast particles rush to your fingertips |
| `FLOW_PULL`, `DRIFT` | How liquid and wavy the flow feels |
| `power` | Explosion strength |

## License

[MIT](LICENSE) © Ariba Shaikh

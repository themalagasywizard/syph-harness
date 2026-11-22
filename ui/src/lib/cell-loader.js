/*!
 * <cell-loader> - living-cell loading & streaming indicator.
 * Drop-in web component, no dependencies. WebGL, with an SVG fallback.
 *
 *   <script src="cell-loader.js"></script>
 *   <cell-loader state="loading" size="48"></cell-loader>
 *
 * Attributes
 *   state     idle | loading | streaming        (default: idle; "thinking" = loading)
 *   size      number in CSS px (default 64), or size the element with CSS width/height
 *   no-birth  skip the "coming alive" growth sequence when it mounts
 *
 * CSS custom properties (read from the element, so they cascade)
 *   --cell-ink    body colour            (default: currentColor)
 *   --cell-glow   signal / biolight      (default: #ffffff)
 *   --cell-halo   outer halo             (default: #8c8c8c)
 *
 * JS
 *   el.state = 'streaming'
 *   el.rebirth()            replay the growth sequence
 */
(() => {
  if (typeof window === 'undefined' || customElements.get('cell-loader')) return;

  // Logo outline traced from the source mark, in units where the mark spans about ±100.
  const LOGO_PATH = 'M-0.70 -98.90 2.30 -98.71 4.51 -98.08 6.17 -97.30 8.10 -95.86 9.85 -93.92 10.74 -92.54 11.80 -89.78 12.13 -87.57 12.09 -85.64 11.83 -84.25 10.68 -81.22 8.66 -78.45 5.62 -75.76 4.40 -74.31 3.09 -71.82 2.51 -69.61 2.26 -45.58 2.30 -16.42 5.26 -22.93 6.92 -25.69 9.15 -28.73 11.17 -30.94 13.90 -33.46 23.57 -40.52 26.34 -42.90 28.41 -45.03 30.21 -47.24 32.74 -51.66 33.62 -54.14 34.23 -56.91 34.47 -59.39 34.38 -62.43 33.83 -65.75 33.01 -68.51 31.86 -71.24 29.61 -75.14 30.50 -74.31 33.79 -70.32 37.19 -65.19 39.38 -60.50 40.74 -54.97 40.95 -52.21 40.80 -49.45 39.91 -45.30 37.95 -41.16 35.50 -37.85 32.97 -35.29 30.48 -33.27 28.27 -31.71 19.15 -26.05 16.11 -23.81 13.30 -21.27 11.61 -19.34 10.52 -17.68 9.13 -14.64 8.82 -12.98 8.82 -11.05 9.43 -8.29 11.14 -5.76 12.52 -4.61 15.01 -3.26 16.67 -2.71 19.71 -2.31 70.26 -2.38 73.02 -2.99 75.23 -4.05 77.16 -5.55 79.93 -8.63 82.69 -10.56 84.07 -11.12 86.28 -11.66 88.77 -11.76 90.98 -11.39 93.19 -10.59 95.40 -9.13 96.78 -7.85 97.93 -6.35 99.30 -3.59 99.62 -2.21 99.86 0.28 99.58 2.49 98.99 4.35 97.95 6.35 96.70 8.01 95.12 9.46 93.19 10.65 90.98 11.44 88.77 11.77 86 11.65 82.69 10.59 80.20 8.92 77.09 5.52 75.23 4.05 73.02 2.98 70.26 2.39 19.43 2.33 16.67 2.72 15.01 3.28 13.35 4.10 11.42 5.52 9.67 7.73 9.12 9.12 8.86 10.50 8.83 12.43 9.13 14.09 10.30 16.85 11.59 18.78 13.01 20.44 15.84 23.04 19.98 26.06 28.55 31.38 31.31 33.37 34.35 36.02 36.91 38.95 39.10 42.54 40.47 46.41 41.02 50.28 40.77 54.97 39.39 60.22 37.17 64.92 33.90 69.89 29.98 74.59 29.37 75.19 29.10 75.16 30.79 72.65 32.47 69.34 33.85 65.19 34.37 62.15 34.52 59.67 34.41 57.18 33.81 54.14 32.69 50.90 30.24 46.69 26.51 42.54 23.57 39.97 13.90 32.98 11.42 30.69 9.34 28.45 7.46 25.97 5.56 22.93 2.30 16.06 2.25 43.09 2.50 65.19 3.33 68.23 4.50 70.17 6.02 71.82 8.38 73.86 10.46 76.52 11.80 79.83 12.10 81.49 12.15 83.43 11.78 85.64 10.96 87.85 9.50 90.06 8.10 91.56 5.89 93.14 3.96 94.02 1.75 94.55 -0.18 94.66 -2.12 94.50 -4.60 93.74 -6.81 92.57 -8.47 91.15 -10.24 88.95 -11.09 87.29 -11.86 84.81 -12.02 83.15 -11.82 80.39 -11.08 77.90 -10.54 76.80 -8.53 74.03 -6.02 71.82 -4.51 70.17 -3.13 67.68 -2.38 64.64 -2.12 16.23 -2.39 16.15 -4.52 20.99 -6.19 24.03 -9.84 29.01 -14.27 33.27 -22.01 38.78 -26.58 42.54 -28.93 45.03 -30.63 47.24 -32.50 50.60 -33.64 53.59 -34.21 56.08 -34.52 59.67 -34.25 62.98 -33.69 65.75 -32.79 68.51 -31.42 71.55 -30.67 72.93 -29.05 75.14 -29.19 75.32 -33.67 70.17 -35.31 67.96 -37.51 64.36 -39.73 59.39 -40.83 54.70 -41.09 50.28 -40.57 46.69 -39.73 43.92 -39.13 42.61 -38.06 40.61 -36.72 38.67 -34.44 36.06 -31.68 33.61 -28.64 31.42 -19.52 25.73 -16.21 23.29 -12.57 19.89 -10.30 16.85 -9.48 15.19 -8.97 13.54 -8.79 11.88 -8.89 10.22 -9.49 8.01 -11.51 5.41 -12.89 4.40 -15.10 3.26 -17.03 2.67 -19.80 2.30 -70.07 2.37 -73.11 3 -75.32 4.04 -77.19 5.52 -80.29 8.90 -82.78 10.58 -84.16 11.15 -86.37 11.69 -89.13 11.75 -91.34 11.35 -93.28 10.64 -95.49 9.22 -96.87 7.96 -98.08 6.35 -99.18 4.14 -99.66 2.49 -99.95 0 -99.72 -2.21 -99.19 -4.14 -98.05 -6.35 -96.75 -8.01 -95.21 -9.42 -93.28 -10.62 -91.07 -11.41 -88.86 -11.77 -86.37 -11.67 -83.06 -10.63 -80.02 -8.60 -77.24 -5.52 -75.32 -4.05 -73.11 -2.98 -70.07 -2.38 -19.52 -2.33 -16.76 -2.72 -15.10 -3.26 -12.62 -4.61 -11.42 -5.52 -9.55 -8.01 -8.88 -10.50 -8.95 -13.81 -9.55 -15.75 -10.36 -17.40 -11.67 -19.34 -13.11 -20.99 -15.93 -23.58 -19.24 -26.11 -26.98 -30.88 -30.57 -33.31 -33.61 -35.87 -35.82 -38.20 -38.12 -41.44 -39.17 -43.37 -40.04 -45.58 -40.91 -49.72 -41 -52.21 -40.83 -54.70 -39.72 -59.67 -37.53 -64.64 -35.55 -67.96 -33.61 -70.59 -30.99 -73.76 -29.47 -75.30 -29.39 -75.14 -30.92 -72.93 -32.31 -70.17 -33.67 -66.30 -34.24 -63.54 -34.47 -59.67 -34.23 -56.91 -33.61 -54.15 -32.50 -51.16 -31.46 -49.17 -29.82 -46.69 -26.26 -42.82 -23.66 -40.59 -14.27 -33.75 -11.79 -31.51 -9.58 -29.17 -7.30 -26.24 -5.93 -24.03 -3.70 -19.61 -2.39 -16.30 -2.12 -16.29 -2.40 -69.06 -2.85 -71.27 -4.02 -73.76 -5.43 -75.57 -9.11 -79.01 -10.76 -81.49 -11.86 -84.81 -12.01 -87.57 -11.87 -88.95 -11.04 -91.71 -9.96 -93.65 -8.47 -95.44 -6.54 -97.02 -5.14 -97.79 -2.39 -98.68ZM-63.32 -30.94 -57.92 -31.20 -53.22 -30.74 -47.70 -29.34 -44.94 -28.28 -42.17 -26.89 -38.86 -24.90 -34.46 -21.55 -26.43 -13.72 -22.28 -10.16 -17.86 -7.36 -14.15 -5.80 -14.55 -5.64 -16.21 -5.73 -19.52 -6.29 -23.11 -7.39 -26.37 -8.84 -30.85 -11.58 -39.13 -17.98 -44.66 -21.66 -49.36 -24.15 -55.16 -26.31 -61.79 -27.51 -65.93 -27.70 -69.24 -27.48 -72.56 -26.93 -75.05 -26.27 -80.44 -24.03 -77.53 -26.09 -72.56 -28.57 -67.59 -30.16ZM54.42 -30.94 57.83 -31.19 62.25 -31.05 64.73 -30.74 68.60 -29.89 74.68 -27.64 78.55 -25.53 81 -23.76 80.76 -23.65 77.72 -25.21 74.95 -26.28 69.15 -27.49 65.29 -27.72 61.42 -27.48 55.34 -26.32 49.26 -24.11 43.19 -20.77 38.49 -17.52 30.76 -11.52 26.33 -8.84 23.02 -7.39 20.53 -6.55 16.11 -5.72 14.46 -5.62 14.26 -5.80 18.32 -7.64 22.19 -10.14 25.78 -13.16 32.14 -19.45 34.90 -21.92 37.66 -24.09 40.70 -26.09 44.29 -27.98 47.61 -29.32 50.37 -30.18ZM13.79 5.25 16.94 5.45 21.09 6.27 23.85 7.16 26.89 8.52 30.76 10.75 41.80 18.92 45.67 21.35 51.75 24.36 57 26.09 59.76 26.67 63.90 27.14 66.94 27.16 69.71 26.93 74.13 26.06 77.16 24.99 79.93 23.66 80.20 23.60 80.25 23.76 77.16 25.71 73.25 27.62 70.26 28.75 65.56 29.94 61.14 30.45 57.55 30.46 52.85 29.90 49.54 29.10 44.29 27.13 39.87 24.68 35.45 21.42 26.61 13.19 23.02 10.15 18.32 7.14ZM-17.15 5.52 -14.55 5.32 -14.35 5.52 -16.48 6.28 -19.24 7.65 -23.39 10.43 -27.26 13.76 -33.89 20.07 -38.31 23.62 -42.17 26.04 -44.38 27.18 -49.36 29.06 -53.22 29.96 -57.64 30.46 -61.23 30.44 -65.38 29.96 -69.24 29.09 -73.11 27.71 -76.98 25.77 -79.68 24.03 -79.47 23.98 -75.87 25.58 -73.39 26.30 -67.31 27.16 -61.51 26.91 -55.99 25.79 -50.74 23.88 -45.21 21.06 -40.52 18.02 -31.95 11.55 -27.81 8.99 -22.84 6.81 -18.97 5.78Z';

  const LOGO_SCALE = 0.007;   // logo units -> shader space (mark spans ±0.70 of the canvas)
  const N = 512;              // distance-field resolution
  const SPREAD_T = 48;        // SDF range in texels (= 0.1875 in shader space)

  const STATES = {
    idle:      { energy: 0.22, vel: 0.10,  stream: 0, load: 0.1 },
    loading:   { energy: 0.70, vel: -0.42, stream: 0, load: 1 },
    streaming: { energy: 1.00, vel: 0.95,  stream: 1, load: 0 },
  };
  STATES.thinking = STATES.loading;
  const LABELS = { idle: 'Ready', loading: 'Thinking', thinking: 'Thinking', streaming: 'Generating response' };

  // ---------------------------------------------------------------------------
  // Field texture: R = signed distance to the outline, G = distance travelled
  // from the nucleus along the mark (so growth and signals follow the limbs).
  // Built once per page and shared by every instance.
  let FIELD = null;

  function edt1(grid, off, stride, len, f, v, z) {
    for (let q = 0; q < len; q++) f[q] = grid[off + q * stride];
    v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1, k = 0, s = 0; q < len; q++) {
      do { const r = v[k]; s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2; } while (s <= z[k] && --k > -1);
      k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
    }
    for (let q = 0, k = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      grid[off + q * stride] = f[r] + (q - r) * (q - r);
    }
  }
  function edt(grid, n) {
    const f = new Float64Array(n), v = new Uint16Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < n; x++) edt1(grid, x, n, n, f, v, z);
    for (let y = 0; y < n; y++) edt1(grid, y * n, 1, n, f, v, z);
  }

  function buildField() {
    if (FIELD) return FIELD;
    const size = N * N;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const s = (N / 2) * LOGO_SCALE;
    ctx.setTransform(s, 0, 0, s, N / 2, N / 2);
    ctx.fillStyle = '#fff';
    ctx.fill(new Path2D(LOGO_PATH), 'evenodd');
    const img = ctx.getImageData(0, 0, N, N).data;

    // signed distance (anti-aliased seeds, Felzenszwalb EDT)
    const outer = new Float64Array(size), inner = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const a = img[i * 4 + 3] / 255;
      if (a >= 1) { outer[i] = 0; inner[i] = 1e20; }
      else if (a <= 0) { outer[i] = 1e20; inner[i] = 0; }
      else { const d = 0.5 - a; outer[i] = d > 0 ? d * d : 0; inner[i] = d < 0 ? d * d : 0; }
    }
    edt(outer, N); edt(inner, N);
    const sdf = new Float32Array(size);
    for (let i = 0; i < size; i++) sdf[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);

    // geodesic distance from the nucleus (Dijkstra). Small gaps are bridged at a
    // cost so the free-floating tendrils still grow out of the centre.
    const GAP = 5, PEN = 4, SQ2 = Math.SQRT2;
    const geo = new Float64Array(size).fill(Infinity);
    const hi = [], hk = [];
    const push = (i, k) => {
      let n = hi.length; hi.push(i); hk.push(k);
      while (n > 0) { const p = (n - 1) >> 1; if (hk[p] <= k) break; hi[n] = hi[p]; hk[n] = hk[p]; n = p; }
      hi[n] = i; hk[n] = k;
    };
    const pop = () => {
      const ti = hi[0], tk = hk[0], li = hi.pop(), lk = hk.pop(), len = hi.length;
      if (len) {
        let n = 0;
        for (;;) {
          let c = 2 * n + 1; if (c >= len) break;
          if (c + 1 < len && hk[c + 1] < hk[c]) c++;
          if (hk[c] >= lk) break;
          hi[n] = hi[c]; hk[n] = hk[c]; n = c;
        }
        hi[n] = li; hk[n] = lk;
      }
      return [ti, tk];
    };
    const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQ2], [1, -1, SQ2], [-1, 1, SQ2], [-1, -1, SQ2]];
    const c0 = (N / 2) * N + N / 2;
    geo[c0] = 0; push(c0, 0);
    while (hi.length) {
      const [i, d] = pop();
      if (d > geo[i]) continue;
      const x = i % N, y = (i / N) | 0, ci = sdf[i] < 0 ? 1 : PEN;
      for (const [dx, dy, w] of NB) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny * N + nx;
        if (sdf[j] >= GAP) continue;
        const nd = d + w * (ci + (sdf[j] < 0 ? 1 : PEN)) * 0.5;
        if (nd < geo[j]) { geo[j] = nd; push(j, nd); }
      }
    }
    let gmax = 0;
    for (let i = 0; i < size; i++) if (sdf[i] < 0 && geo[i] < Infinity && geo[i] > gmax) gmax = geo[i];
    const g = new Float32Array(size);
    const queue = new Int32Array(size);
    let qh = 0, qt = 0;
    for (let i = 0; i < size; i++) {
      if (geo[i] < Infinity) { g[i] = Math.min(1, geo[i] / gmax); queue[qt++] = i; } else g[i] = -1;
    }
    // carry values outward so the halo knows which limb it belongs to
    while (qh < qt) {
      const i = queue[qh++], x = i % N, y = (i / N) | 0;
      if (x > 0 && g[i - 1] < 0) { g[i - 1] = g[i]; queue[qt++] = i - 1; }
      if (x < N - 1 && g[i + 1] < 0) { g[i + 1] = g[i]; queue[qt++] = i + 1; }
      if (y > 0 && g[i - N] < 0) { g[i - N] = g[i]; queue[qt++] = i - N; }
      if (y < N - 1 && g[i + N] < 0) { g[i + N] = g[i]; queue[qt++] = i + N; }
    }
    // soften the seams between limbs outside the shape
    const tmp = new Float32Array(size), R = 4, W = 2 * R + 1;
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < N; y++) {
        let acc = 0;
        for (let x = -R; x <= R; x++) acc += g[y * N + Math.min(N - 1, Math.max(0, x))];
        for (let x = 0; x < N; x++) {
          tmp[y * N + x] = acc / W;
          acc += g[y * N + Math.min(N - 1, x + R + 1)] - g[y * N + Math.max(0, x - R)];
        }
      }
      for (let x = 0; x < N; x++) {
        let acc = 0;
        for (let y = -R; y <= R; y++) acc += tmp[Math.min(N - 1, Math.max(0, y)) * N + x];
        for (let y = 0; y < N; y++) {
          const i = y * N + x;
          if (sdf[i] > 2) g[i] = acc / W;
          acc += tmp[Math.min(N - 1, y + R + 1) * N + x] - tmp[Math.max(0, y - R) * N + x];
        }
      }
    }
    // pack, flipping rows so texture v runs bottom -> top like GL space
    const out = new Uint8Array(size * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x, o = ((N - 1 - y) * N + x) * 4;
        out[o] = Math.max(0, Math.min(255, Math.round(128 + (sdf[i] / SPREAD_T) * 127)));
        out[o + 1] = Math.round(Math.max(0, Math.min(1, g[i])) * 255);
        out[o + 2] = 0;
        out[o + 3] = 255;
      }
    }
    return (FIELD = out);
  }

  // ---------------------------------------------------------------------------
  const VS = 'attribute vec2 a;varying vec2 vP;void main(){vP=a;gl_Position=vec4(a,0.0,1.0);}';
  const FS = `
precision highp float;
varying vec2 vP;
uniform sampler2D uF;
uniform float uT, uGrow, uPhase, uEnergy, uStream, uLoad, uPx, uDetail, uCalm, uSpark;
uniform vec3 uInk, uGlow, uHalo;
const float SPREAD = 0.1875;
const float TAU = 6.2831853;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float h1(float n){ return fract(sin(n * 91.3458) * 47453.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f*f*(3.0 - 2.0*f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 field(vec2 q){ vec4 s = texture2D(uF, q*0.5 + 0.5); return vec2((s.r*255.0 - 128.0)/127.0*SPREAD, s.g); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec4 over(vec4 u, vec3 c, float a){ a = clamp(a, 0.0, 1.0); return vec4(c*a + u.rgb*(1.0 - a), a + u.a*(1.0 - a)); }

void main(){
  float zoom = mix(0.8, 1.0, uDetail);
  vec2 p = vP * zoom;
  float px = uPx * zoom;
  float t = uT;
  float motion = 1.0 - uCalm;
  float r = length(p);
  vec2 dir = p / max(r, 1e-4);

  // double heartbeat used while thinking
  float hb = pow(max(0.0, sin(t*2.4)), 12.0) + 0.55*pow(max(0.0, sin(t*2.4 - 0.7)), 12.0);

  // living deformation: breath, slow swirl, cytoplasmic wobble
  float breath = 1.0 + motion*(0.014*sin(t*1.15) + 0.02*hb*uLoad);
  vec2 q = p / breath;
  q = rot(motion*(0.05*sin(t*0.7 + r*3.2) + 0.022*sin(t*1.9 - r*5.0)) * r) * q;
  vec2 wob = vec2(noise(q*2.3 + vec2(t*0.33, 0.0)), noise(q*2.3 + vec2(5.2, -t*0.29))) - 0.5;
  q += wob * motion * (0.012 + 0.008*uStream) * smoothstep(0.05, 0.6, r);

  vec2 f = field(q);
  float d = f.x, g = f.y;

  // growth: limbs extend from the nucleus, thin at the growing tip
  float front = uGrow*1.3 - 0.08;
  float jit = (noise(q*8.0 + t*0.6) - 0.5) * 0.06;
  float grown = smoothstep(0.0, 0.16, front - g + jit);
  float dd = d + (1.0 - grown)*0.1;
  float tip = exp(-pow((g - front + 0.11)/0.05, 2.0)) * (1.0 - smoothstep(0.8, 1.0, uGrow)) * step(0.001, uGrow);
  float body = smoothstep(px*1.1, -px*1.1, dd);

  // signals travelling along the limbs (inward while thinking, outward while streaming)
  float w = fract(g*2.6 - uPhase);
  float pw = mix(0.17, 0.075, uStream);
  float burst = mix(1.0, smoothstep(0.3, 0.7, noise(dir*1.7 + vec2(t*1.3, -t*0.9))), uStream*0.85);
  float sig = exp(-pow((w - 0.5)/pw, 2.0)) * burst * grown * (0.25 + 0.75*uEnergy);

  float nuc = exp(-r*r/0.018) * (0.3 + 0.5*uEnergy + 1.1*hb*uLoad) * smoothstep(0.0, 0.25, uGrow);

  // body colour
  vec3 bodyCol = mix(mix(uInk, uHalo, 0.2 + 0.16*uEnergy), uGlow, clamp(sig*1.15 + tip + nuc*0.9, 0.0, 1.0));
  bodyCol = mix(bodyCol, uGlow, smoothstep(-0.008, 0.0, dd) * (0.05 + 0.12*uEnergy));
  bodyCol = mix(bodyCol, uGlow, step(0.993, hash(floor(q*150.0) + floor(t*16.0))) * uStream);

  // halo
  float od = max(dd, 0.0);
  float near = exp(-od*30.0);
  float haloA = smoothstep(SPREAD, SPREAD*0.55, od) * smoothstep(0.0, 0.35, uGrow)
              * (near*(0.14 + 0.8*sig + 0.9*tip + 0.6*nuc) + exp(-od*9.0)*0.1*uEnergy);
  vec3 haloCol = mix(uHalo, uGlow, near);

  // birth spark, its flare already pointing where the spokes will grow
  float spark = (exp(-r*r/0.0009) + 0.6*(exp(-abs(p.y)*90.0)*exp(-abs(p.x)*5.0)
               + exp(-abs(p.x)*90.0)*exp(-abs(p.y)*5.0))) * uSpark;

  // membrane and orbital ring
  float md = uDetail * smoothstep(0.5, 1.0, uGrow);
  float mr = 0.865 + 0.035*(noise(dir*1.6 + vec2(t*0.22, -t*0.17)) - 0.5) + motion*0.01*sin(t*1.15) + 0.012*hb*uLoad;
  float ring = exp(-pow((r - mr)/max(0.006, px*1.2), 2.0));
  float cyto = smoothstep(mr + px, mr - px, r) * (0.025 + 0.06*smoothstep(mr - 0.3, mr, r));
  float ang = atan(p.y, p.x) / TAU;
  float seg = fract(ang*72.0 - t*(0.012 + 0.05*uStream));
  float dash = smoothstep(0.0, 0.08, seg) * smoothstep(0.5, 0.42, seg);
  float sweep = mix(pow(0.5 + 0.5*cos((ang - t*0.08)*TAU), 6.0),
                    pow(0.5 + 0.5*cos((ang*4.0 - t*0.33)*TAU), 6.0), uStream);
  float orbit = exp(-pow((r - 0.955)/max(0.004, px), 2.0)) * dash * (0.12 + 0.5*sweep*(0.3 + 0.7*uEnergy));

  // motes: drifting in while thinking, emitted from the four nodes while streaming
  float ps2 = pow(max(0.011, px*1.4), 2.0);
  float motes = 0.0;
  for (int i = 0; i < 12; i++){
    float fi = float(i);
    float s1 = h1(fi + 1.0), s2 = h1(fi*3.7 + 2.0), s3 = h1(fi*7.1 + 5.0);
    float l1 = fract(t*(0.07 + 0.06*s1)*(1.0 + 1.5*uLoad) + s2);
    float a1 = s3*TAU + l1*2.0*(s1 - 0.5);
    vec2 e1 = p - vec2(cos(a1), sin(a1))*mix(0.92, 0.1, l1);
    motes += exp(-dot(e1, e1)/ps2) * sin(l1*3.14159) * (1.0 - uStream) * (0.35 + 0.65*uLoad);
    float l2 = fract(t*(0.45 + 0.35*s1) + s2);
    float a2 = floor(s3*4.0)*1.5707963 + (s1 - 0.5)*0.9*l2;
    vec2 e2 = p - vec2(cos(a2), sin(a2))*mix(0.66, 1.05, l2);
    motes += exp(-dot(e2, e2)/(ps2*(1.0 - 0.6*l2))) * (1.0 - l2) * uStream;
  }
  motes *= uDetail * motion * smoothstep(0.6, 1.0, uGrow);

  vec4 c = vec4(0.0);
  c = over(c, uGlow, cyto*md);
  c = over(c, haloCol, haloA);
  c = over(c, mix(uHalo, uGlow, 0.5), ring*md*(0.3 + 0.25*uEnergy));
  c = over(c, uGlow, orbit*md);
  c = over(c, uGlow, motes*0.9);
  c = over(c, bodyCol, body);
  c = over(c, uGlow, spark);
  gl_FragColor = c;
}`;

  const UNIFORMS = ['uF', 'uT', 'uGrow', 'uPhase', 'uEnergy', 'uStream', 'uLoad', 'uPx', 'uDetail', 'uCalm', 'uSpark', 'uInk', 'uGlow', 'uHalo'];

  function initGL(canvas) {
    const gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power',
    });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildField());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const u = {};
    for (const n of UNIFORMS) u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(u.uF, 0);
    gl.clearColor(0, 0, 0, 0);
    return { gl, u };
  }

  const toRGB = (() => {
    let x = null; const cache = new Map();
    return (s) => {
      if (cache.has(s)) return cache.get(s);
      if (!x) { const c = document.createElement('canvas'); c.width = c.height = 1; x = c.getContext('2d', { willReadFrequently: true }); }
      x.clearRect(0, 0, 1, 1); x.fillStyle = '#000'; x.fillStyle = s; x.fillRect(0, 0, 1, 1);
      const d = x.getImageData(0, 0, 1, 1).data, v = [d[0] / 255, d[1] / 255, d[2] / 255];
      cache.set(s, v); return v;
    };
  })();

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
  const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  class CellLoader extends HTMLElement {
    static get observedAttributes() { return ['state', 'size']; }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        :host{display:inline-block;position:relative;width:var(--cell-size,64px);height:var(--cell-size,64px);vertical-align:middle;flex:none}
        canvas,svg{position:absolute;inset:0;width:100%;height:100%;display:block}
        svg{fill:var(--cell-ink,currentColor);transform-origin:50% 50%;animation:cl-breathe 2.4s ease-in-out infinite}
        @keyframes cl-breathe{50%{transform:scale(.93);opacity:.55}}
        @media (prefers-reduced-motion:reduce){svg{animation-duration:4.8s}}
      </style><canvas aria-hidden="true"></canvas>`;
      this._canvas = root.querySelector('canvas');
      this._cur = { ...STATES.idle };
      this._t = 0; this._phase = 0; this._grow = 1; this._spark = 0; this._birthAt = null;
      this._visible = true; this._frameN = 0;
      this._frame = this._frame.bind(this);
    }

    get state() { return this.getAttribute('state') || 'idle'; }
    set state(v) { this.setAttribute('state', v); }

    connectedCallback() {
      if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
      this._applySize();
      this._applyLabel();
      try { this._ctx = initGL(this._canvas); } catch (e) { console.warn('[cell-loader] WebGL unavailable, using fallback.', e); this._ctx = null; }
      if (!this._ctx) { this._fallback(); return; }
      this._canvas.addEventListener('webglcontextlost', this._onLost = (e) => { e.preventDefault(); this._stop(); this._fallback(); });
      this._readColors();
      this._cur = { ...(STATES[this.state] || STATES.idle) };
      if (!this.hasAttribute('no-birth') && !(reduceMQ && reduceMQ.matches)) this.rebirth();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this);
      this._io = new IntersectionObserver((es) => { this._visible = es[es.length - 1].isIntersecting; this._sync(); });
      this._io.observe(this);
      document.addEventListener('visibilitychange', this._onVis = () => this._sync());
      this._resize();
      this._sync();
    }

    disconnectedCallback() {
      this._stop();
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
      if (this._ctx) {
        const ext = this._ctx.gl.getExtension('WEBGL_lose_context');
        this._canvas.removeEventListener('webglcontextlost', this._onLost);
        if (ext) ext.loseContext();
        this._ctx = null;
        // fresh canvas so a re-attached element can get a new context
        const c = document.createElement('canvas'); c.setAttribute('aria-hidden', 'true');
        this._canvas.replaceWith(c); this._canvas = c;
      }
    }

    attributeChangedCallback(name) {
      if (name === 'size') this._applySize();
      if (name === 'state') this._applyLabel();
    }

    rebirth() { this._birthAt = this._t; this._grow = 0; this._spark = 0; }

    _applySize() {
      const s = parseFloat(this.getAttribute('size'));
      if (s > 0) this.style.setProperty('--cell-size', s + 'px');
    }
    _applyLabel() {
      if (!this.hasAttribute('aria-label') || this._autoLabel) {
        this._autoLabel = true;
        this.setAttribute('aria-label', LABELS[this.state] || 'Loading');
      }
    }
    _readColors() {
      const cs = getComputedStyle(this);
      this._ink = toRGB(cs.getPropertyValue('--cell-ink').trim() || cs.color);
      this._glow = toRGB(cs.getPropertyValue('--cell-glow').trim() || '#ffffff');
      this._halo = toRGB(cs.getPropertyValue('--cell-halo').trim() || '#8c8c8c');
    }
    _resize() {
      const w = this.clientWidth || 64;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.max(1, Math.round(w * dpr));
      if (this._canvas.width !== px) { this._canvas.width = px; this._canvas.height = px; }
      this._detail = smooth(30, 96, w);
      if (!this._raf && this._ctx) this._draw();
    }
    _sync() {
      const run = this._visible && !document.hidden && this._ctx;
      if (run && !this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(this._frame); }
      else if (!run) this._stop();
    }
    _stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }

    _frame(now) {
      this._raf = requestAnimationFrame(this._frame);
      const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this._t += dt;
      const tgt = STATES[this.state] || STATES.idle;
      const k = 1 - Math.exp(-dt * 2.6);
      for (const key in tgt) this._cur[key] += (tgt[key] - this._cur[key]) * k;
      const calm = reduceMQ && reduceMQ.matches ? 1 : 0;
      this._phase += this._cur.vel * dt * (calm ? 0.4 : 1);
      if (this._birthAt != null) {
        const bt = this._t - this._birthAt;
        this._spark = smooth(0, 0.35, bt) * (1 - smooth(0.8, 1.9, bt));
        this._grow = ease((bt - 0.35) / 1.9);
        if (bt > 2.4) { this._birthAt = null; this._grow = 1; this._spark = 0; }
      }
      if (++this._frameN % 45 === 0) this._readColors();
      this._draw(calm);
    }

    _draw(calm = 0) {
      const { gl, u } = this._ctx;
      const c = this._canvas;
      gl.viewport(0, 0, c.width, c.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.uT, this._t);
      gl.uniform1f(u.uGrow, this._grow);
      gl.uniform1f(u.uPhase, this._phase);
      gl.uniform1f(u.uEnergy, this._cur.energy);
      gl.uniform1f(u.uStream, this._cur.stream);
      gl.uniform1f(u.uLoad, this._cur.load);
      gl.uniform1f(u.uPx, 2 / c.width);
      gl.uniform1f(u.uDetail, this._detail ?? 1);
      gl.uniform1f(u.uCalm, calm);
      gl.uniform1f(u.uSpark, this._spark);
      gl.uniform3fv(u.uInk, this._ink);
      gl.uniform3fv(u.uGlow, this._glow);
      gl.uniform3fv(u.uHalo, this._halo);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _fallback() {
      if (this.shadowRoot.querySelector('svg')) return;
      this._canvas.remove();
      const v = 1 / LOGO_SCALE;
      this.shadowRoot.insertAdjacentHTML('beforeend',
        `<svg viewBox="${-v * 0.82} ${-v * 0.82} ${v * 1.64} ${v * 1.64}" aria-hidden="true"><path fill-rule="evenodd" d="${LOGO_PATH}"/></svg>`);
    }
  }

  customElements.define('cell-loader', CellLoader);
})();

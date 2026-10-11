// Relief on the globe, drawn by WebGL: for each pixel, undo d3's orthographic projection and its
// rotation to find the point on the globe, and read the shaded-relief image there (src/terrain.mjs
// bakes them: grey is hillshade, alpha is height, 0 at sea). Its cost is per pixel, so a map stays
// as quick to turn however detailed its relief. Colours come from the page's CSS (--fg,
// --relief-shadow, --relief-light), so it follows the theme.

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uSize;        // canvas, device pixels
uniform vec2 uCentre;      // projection.translate(), device pixels
uniform float uScale;      // projection.scale(), device pixels
uniform vec3 uRot;         // projection.rotate(), radians
uniform sampler2D uWorld, uDetail, uFine;
uniform vec4 uWorldBox, uDetailBox, uFineBox;   // lon0, lat0, lon1, lat1 of each image's pixel centres
uniform vec2 uWorldPx, uDetailPx, uFinePx;      // image sizes
uniform float uHasDetail, uHasFine;
uniform vec3 uTint, uShadow, uLight;
vec4 sampleAt(sampler2D t, vec4 box, vec2 px, float lon, float lat) {
  vec2 uv = vec2((lon - box.x) / (box.z - box.x) * (px.x - 1.0) + 0.5, (box.w - lat) / (box.w - box.y) * (px.y - 1.0) + 0.5) / px;
  return texture2D(t, uv);
}
float inner(vec4 box, float lon, float lat) {
  return smoothstep(0.0, 0.05, min(min(lon - box.x, box.z - lon) / (box.z - box.x), min(lat - box.y, box.w - lat) / (box.w - box.y)));
}
void main() {
  vec2 s = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  float X = (s.x - uCentre.x) / uScale, Y = (uCentre.y - s.y) / uScale, r2 = X * X + Y * Y;
  if (r2 >= 1.0) discard;
  // Orthographic, inverted: the point in the rotated frame.
  float lam = atan(X, sqrt(1.0 - r2)), phi = asin(clamp(Y, -1.0, 1.0));
  // d3's rotation, inverted: phi-gamma first, then lambda.
  float cp = cos(phi), x = cos(lam) * cp, y = sin(lam) * cp, z = sin(phi);
  float cdp = cos(uRot.y), sdp = sin(uRot.y), cdg = cos(uRot.z), sdg = sin(uRot.z);
  float k = z * cdg - y * sdg;
  float lon = degrees(atan(y * cdg + z * sdg, x * cdp + k * sdp) - uRot.x);
  float lat = degrees(asin(clamp(k * cdp - x * sdp, -1.0, 1.0)));
  lon = mod(lon + 540.0, 360.0) - 180.0;
  // Each finer image over the coarser, faded in over the outer 5% of its area so no seam shows.
  vec4 t = vec4(0.0);
  bool any = false;
  if (lon > uWorldBox.x && lon < uWorldBox.z && lat > uWorldBox.y && lat < uWorldBox.w) { t = sampleAt(uWorld, uWorldBox, uWorldPx, lon, lat); any = true; }
  if (uHasDetail > 0.5 && lon > uDetailBox.x && lon < uDetailBox.z && lat > uDetailBox.y && lat < uDetailBox.w) { t = mix(t, sampleAt(uDetail, uDetailBox, uDetailPx, lon, lat), any ? inner(uDetailBox, lon, lat) : 1.0); any = true; }
  if (uHasFine > 0.5 && lon > uFineBox.x && lon < uFineBox.z && lat > uFineBox.y && lat < uFineBox.w) { t = mix(t, sampleAt(uFine, uFineBox, uFinePx, lon, lat), any ? inner(uFineBox, lon, lat) : 1.0); any = true; }
  if (!any) discard;
  if (t.a < 0.5 / 255.0) discard;
  float e = max(0.0, (t.a * 255.0 - 1.0) / 254.0);  // 0..1, the square root of height / top
  float d = t.r - 0.7071;                           // hillshade against flat ground
  float tintA = 0.30 * e, shadowA = clamp(-d * 1.4, 0.0, 0.55), lightA = clamp(d * 1.1, 0.0, 0.3);
  vec4 c = vec4(uTint * tintA, tintA);              // premultiplied
  c = vec4(uShadow * shadowA, shadowA) + c * (1.0 - shadowA);
  c = vec4(uLight * lightA, lightA) + c * (1.0 - lightA);
  gl_FragColor = c;
}`;

const rgb = css => {
  const m = /#([0-9a-f]{6})/i.exec(css) ?? null;
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const n = /rgba?\(([^)]+)\)/.exec(css)?.[1].split(',').map(Number);
  return n ? n.slice(0, 3).map(v => v / 255) : [0.5, 0.5, 0.5];
};

// relief: relief.json with each image's `url`. Up to two finer images are drawn over the world's:
// those whose area holds the view's centre and is about as wide as the view, finest on top. Returns null where WebGL is not available.
export function reliefLayer(canvas, relief) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = new Proxy({}, { get: (c, n) => (c[n] ??= gl.getUniformLocation(prog, n)) });
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const images = relief.images.map(img => ({ ...img, tex: null, loading: false }));
  const world = images.find(i => i.name === 'world');
  const details = images.filter(i => i !== world);
  let onLoad = () => {};
  const load = (img, unit) => {
    if (img.tex || img.loading) return;
    img.loading = true;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
      img.tex = tex; onLoad();
    };
    im.src = img.url;
  };
  if (world) load(world, 0);
  // The theme's colours, read once (reading styles on every frame forces the page to restyle) and
  // again when the theme changes.
  let colours = null;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colours = null; onLoad(); });

  return {
    set onLoad(f) { onLoad = f; },
    // view: the globe's visible centre and half-width in degrees, to choose (and fetch) detail.
    render(projection, W, H, view) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!world?.tex) return;
      // The finer images of the area in view, once the view is about as small as them.
      const near = details.filter(d => view.span < (d.bbox[2] - d.bbox[0]) && view.centre[0] > d.bbox[0] && view.centre[0] < d.bbox[2] && view.centre[1] > d.bbox[1] && view.centre[1] < d.bbox[3])
        .sort((a, b) => (b.bbox[2] - b.bbox[0]) - (a.bbox[2] - a.bbox[0]));
      const [detail, fine] = near;
      if (detail) load(detail, 1);
      if (fine) load(fine, 2);
      gl.uniform2f(u.uSize, canvas.width, canvas.height);
      const [tx, ty] = projection.translate();
      gl.uniform2f(u.uCentre, tx * dpr, ty * dpr);
      gl.uniform1f(u.uScale, projection.scale() * dpr);
      gl.uniform3f(u.uRot, ...projection.rotate().map(v => v * Math.PI / 180));
      colours ??= ['--fg', '--relief-shadow', '--relief-light'].map(v => rgb(getComputedStyle(canvas).getPropertyValue(v)));
      gl.uniform3f(u.uTint, ...colours[0]); gl.uniform3f(u.uShadow, ...colours[1]); gl.uniform3f(u.uLight, ...colours[2]);
      // Pixel centres run east from the box's west edge and south from its north edge by whole steps.
      const boxOf = img => { const [x0, , , y1] = img.bbox; return [x0, y1 - (img.height - 1) * img.step, x0 + (img.width - 1) * img.step, y1]; };
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, world.tex); gl.uniform1i(u.uWorld, 0);
      gl.uniform4f(u.uWorldBox, ...boxOf(world)); gl.uniform2f(u.uWorldPx, world.width, world.height);
      const useDetail = detail?.tex;
      gl.uniform1f(u.uHasDetail, useDetail ? 1 : 0);
      if (useDetail) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, detail.tex); gl.uniform1i(u.uDetail, 1);
        gl.uniform4f(u.uDetailBox, ...boxOf(detail)); gl.uniform2f(u.uDetailPx, detail.width, detail.height);
      } else { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, world.tex); gl.uniform1i(u.uDetail, 1); }
      const useFine = fine?.tex;
      gl.uniform1f(u.uHasFine, useFine ? 1 : 0);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, useFine ? fine.tex : world.tex); gl.uniform1i(u.uFine, 2);
      if (useFine) { gl.uniform4f(u.uFineBox, ...boxOf(fine)); gl.uniform2f(u.uFinePx, fine.width, fine.height); }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

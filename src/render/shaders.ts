/**
 * GLSL ES 3.00 sources for the whole "Replaced Look" pipeline.
 *
 * Stages
 *   sprite     - instanced, normal-mapped, premultiplied-alpha forward lighting
 *   sky        - procedural gradient + stars + sun/moon + high cloud bands
 *   fog        - 7-step volumetric march with in-scattering (sun + lightning)
 *   brightpass - HDR threshold with a soft knee
 *   blur       - 13-tap separable gaussian (bloom mips)
 *   composite  - ACES tonemap, time-of-day grade, vignette, grain, dither,
 *                nearest-neighbour upscale to the display
 *
 * Every `#version` directive must be the very first line of the shader string -
 * do not add leading whitespace.
 */

export const NOISE_GLSL = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, int octaves) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.03;
  }
  return sum / max(norm, 0.0001);
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// --- Sprites ---------------------------------------------------------------
export const SPRITE_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;   // unit quad, -0.5 .. 0.5
layout(location = 1) in vec2 iPos;      // world centre (y down)
layout(location = 2) in vec2 iSize;     // world size
layout(location = 3) in vec2 iRot;      // cos, sin
layout(location = 4) in vec4 iUv;       // atlas uv rect
layout(location = 5) in vec4 iColor;    // rgb tint, alpha
layout(location = 6) in vec4 iParams;   // emissive, normalStrength, specular, aerialDepth

uniform vec2 uViewSize;   // viewport in world units
uniform vec2 uOffset;     // camera/parallax offset in world units

out vec2 vUv;
out vec2 vWorld;
out vec4 vColor;
out vec4 vParams;
out vec2 vRot;

void main() {
  vec2 local = aCorner * iSize;
  local = vec2(local.x * iRot.x - local.y * iRot.y, local.x * iRot.y + local.y * iRot.x);
  vec2 world = iPos + local;
  vec2 shifted = world - uOffset;
  vWorld = world;
  vUv = mix(iUv.xy, iUv.zw, aCorner + 0.5);
  vColor = iColor;
  vParams = iParams;
  vRot = iRot;
  vec2 clip = (shifted / uViewSize) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, clip.y, 0.0, 1.0);
}`;

export const SPRITE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
in vec2 vWorld;
in vec4 vColor;
in vec4 vParams;
in vec2 vRot;

uniform sampler2D uAtlas;
uniform sampler2D uMaterial;
uniform vec3 uSunDir;         // surface -> light, normalised
uniform vec3 uSunColor;       // already scaled by intensity
uniform vec3 uAmbient;
uniform vec4 uLightPos[4];    // xy world, z height above the plane, w intensity
uniform vec3 uLightColor[4];
uniform int uLightCount;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uSpecGlobal;

out vec4 outColor;

void main() {
  vec4 tex = texture(uAtlas, vUv);
  float alpha = tex.a * vColor.a;
  if (alpha < 0.004) discard;

  vec4 mat = texture(uMaterial, vUv);
  vec3 raw = mat.xyz * 2.0 - 1.0;
  float glow = mat.w;

  float ns = vParams.y;
  float spec = vParams.z * uSpecGlobal;
  float aerial = vParams.w;

  // Tangent space is screen space (sprites are camera-aligned quads). The atlas
  // is authored y-up, our world is y-down, so flip the green channel.
  vec2 nxy = vec2(raw.x, -raw.y) * ns;
  nxy = vec2(nxy.x * vRot.x - nxy.y * vRot.y, nxy.x * vRot.y + nxy.y * vRot.x);
  vec3 N = normalize(vec3(nxy, max(raw.z, 0.2)));
  vec3 V = vec3(0.0, 0.0, 1.0);

  vec3 base = tex.rgb * vColor.rgb;
  vec3 lit = base * uAmbient;

  // Key light: sun by day, moon by night (the core swaps colour + intensity).
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float sh = pow(max(dot(N, H), 0.0), 32.0) * spec;
  lit += base * uSunColor * ndl + uSunColor * sh * 0.6;

  // Point lights: lantern, lightning channel, burning debris.
  for (int i = 0; i < 4; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLightPos[i];
    vec3 d = vec3(lp.xy - vWorld, lp.z);
    float dist2 = dot(d, d);
    float atten = lp.w / (1.0 + dist2 * 22.0);
    if (atten < 0.002) continue;
    vec3 L = d * inversesqrt(dist2 + 0.0001);
    float lndl = max(dot(N, L), 0.0);
    vec3 Lh = normalize(L + V);
    float lsh = pow(max(dot(N, Lh), 0.0), 24.0) * spec;
    lit += (base * lndl + uLightColor[i] * lsh * 0.35) * uLightColor[i] * atten;
  }

  // Emission (authored in the material alpha channel) -> straight into bloom.
  lit += base * glow * (0.35 + vParams.x * 2.4);

  // Aerial perspective: distant parallax layers sink into the fog colour.
  float haze = clamp(aerial * uFogDensity, 0.0, 0.92);
  lit = mix(lit, uFogColor * (0.35 + 0.65 * max(max(lit.r, lit.g), lit.b) * 2.0), haze);

  outColor = vec4(lit * alpha, alpha);
}`;

// --- Sky -------------------------------------------------------------------
export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec3 uTopColor;
uniform vec3 uHorizonColor;
uniform vec2 uSunUv;         // screen-space uv of the key light
uniform vec3 uSunColor;
uniform float uSunRadius;
uniform float uSunIntensity;
uniform float uStarAlpha;
uniform float uCloudCover;
uniform vec3 uCloudColor;
uniform float uTime;
uniform float uWind;
uniform float uWindDir;
uniform float uFlash;
uniform vec2 uAspect;        // uv scale correction so noise is not stretched

${NOISE_GLSL}

void main() {
  vec2 uv = vUv;
  float v = clamp(uv.y, 0.0, 1.0);

  // Base gradient: horizon glow into zenith.
  float g = pow(1.0 - v, 1.45);
  vec3 col = mix(uTopColor, uHorizonColor, g);

  // Stars - hashed cells with a twinkle, only where the sky is dark.
  if (uStarAlpha > 0.002) {
    vec2 sp = uv * uAspect * 150.0;
    vec2 cell = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float r = hash21(cell);
    if (r > 0.965) {
      vec2 off = (hash22(cell) - 0.5) * 0.7;
      float d = length(f - off);
      float tw = 0.65 + 0.35 * sin(uTime * (1.4 + r * 4.0) + r * 40.0);
      float star = smoothstep(0.16, 0.0, d) * tw * (0.4 + r * 1.6);
      col += vec3(0.85, 0.9, 1.0) * star * uStarAlpha;
    }
  }

  // Sun / moon: hard core, soft halo, both scaled by intensity.
  vec2 sd = (uv - uSunUv) * uAspect;
  float dist = length(sd);
  float core = smoothstep(uSunRadius, uSunRadius * 0.82, dist);
  float halo = uSunRadius * 6.0 / (dist * 26.0 + uSunRadius * 4.0);
  col += uSunColor * (core * 2.4 + halo * halo * 0.55) * uSunIntensity;

  // High cloud bands drift with the wind and thicken with cloud cover.
  if (uCloudCover > 0.01) {
    vec2 cuv = vec2(uv.x * uAspect.x * 1.6 + uTime * (0.006 + uWind * 0.03) * uWindDir, uv.y * 5.0);
    float n = fbm(cuv, 4);
    float n2 = fbm(cuv * 2.3 + 11.0, 3);
    float cover = smoothstep(0.72 - uCloudCover * 0.5, 0.98 - uCloudCover * 0.42, n * 0.72 + n2 * 0.34);
    float band = smoothstep(0.05, 0.5, v) * smoothstep(1.0, 0.55, v);
    cover *= band * (0.35 + uCloudCover * 0.75);
    vec3 cc = mix(uCloudColor * 0.55, uCloudColor, smoothstep(0.0, 0.6, n2));
    cc += uSunColor * pow(max(0.0, 1.0 - dist * 3.2), 3.0) * 0.5;
    col = mix(col, cc, clamp(cover, 0.0, 0.9));
  }

  // Lightning floods the whole sky from above.
  col += vec3(0.72, 0.8, 1.0) * uFlash * (0.35 + 0.65 * (1.0 - v));

  // Subtle horizon haze so parallax layers sit inside the atmosphere.
  col = mix(col, uHorizonColor * 1.06, pow(1.0 - v, 6.0) * 0.35);

  outColor = vec4(col, 1.0);
}`;

// --- Volumetric fog --------------------------------------------------------
export const FOG_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec3 uFogColor;
uniform float uDensity;
uniform float uTime;
uniform float uScroll;
uniform float uWind;
uniform float uWindDir;
uniform float uFlash;
uniform vec3 uSunColor;
uniform vec2 uSunDir;      // screen-space direction toward the key light
uniform vec2 uAspect;
uniform float uHeightBias; // 0..1, pushes the slab toward the bottom of frame

${NOISE_GLSL}

void main() {
  if (uDensity <= 0.001) {
    outColor = vec4(0.0);
    return;
  }

  const int STEPS = 7;
  vec3 accum = vec3(0.0);
  float transmittance = 1.0;
  float drift = uTime * (0.012 + uWind * 0.05) * uWindDir;

  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + 0.5) / float(STEPS);
    // Parallax inside the slab: deeper layers scroll slower and are larger.
    float depth = mix(0.35, 1.7, t);
    vec2 p = vec2(vUv.x * uAspect.x * depth + drift * depth, vUv.y * 3.4 * depth - uScroll * depth * 0.35);
    float n = fbm(p, 3);
    float n2 = vnoise(p * 3.7 + uTime * 0.03);

    float heightFalloff = mix(1.0, smoothstep(1.0, 0.15, vUv.y), uHeightBias);
    float d = smoothstep(0.52 - uDensity * 0.3, 0.95, n * 0.78 + n2 * 0.26) * heightFalloff;
    d *= uDensity * (0.55 + 0.45 * t);

    // In-scattering: brighter when looking toward the key light, and it blows
    // out completely during a lightning strike.
    vec2 toSun = normalize(uSunDir + vec2(0.0, 0.0001));
    vec2 fromCentre = normalize(vUv - vec2(0.5, 0.35));
    float scatter = pow(max(dot(toSun, fromCentre), 0.0), 5.0);
    vec3 tint = uFogColor * (0.62 + 0.5 * t) + uSunColor * scatter * 0.55;
    tint += vec3(0.8, 0.86, 1.0) * uFlash * 1.5;

    float sample_ = d * (1.0 / float(STEPS)) * 2.1;
    accum += tint * sample_ * transmittance;
    transmittance *= clamp(1.0 - sample_, 0.0, 1.0);
  }

  float alpha = clamp(1.0 - transmittance, 0.0, 0.94);
  outColor = vec4(accum, alpha);
}`;

// --- Bloom -----------------------------------------------------------------
export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);
  float contrib = max(soft, l - uThreshold) / max(l, 0.0001);
  outColor = vec4(c * contrib, 1.0);
}`;

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDirection; // (1,0) horizontal, (0,1) vertical

void main() {
  vec2 off = uDirection * uTexel;
  vec3 c = texture(uSrc, vUv).rgb * 0.227027;
  c += (texture(uSrc, vUv + off * 1.3846).rgb + texture(uSrc, vUv - off * 1.3846).rgb) * 0.3162162;
  c += (texture(uSrc, vUv + off * 3.2308).rgb + texture(uSrc, vUv - off * 3.2308).rgb) * 0.0702702;
  outColor = vec4(c, 1.0);
}`;

export const BLOOM_DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
// 4-tap box downsample: cheap, stable, and avoids flicker between mips.
void main() {
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  outColor = vec4(c * 0.25, 1.0);
}`;

export const BLOOM_UP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform sampler2D uHigher;
uniform vec2 uTexel;
uniform float uWeight;
void main() {
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  c += texture(uHigher, vUv).rgb * uWeight;
  outColor = vec4(c, 1.0);
}`;

// --- Composite -------------------------------------------------------------
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform vec3 uGradeLift;
uniform vec3 uGradeGain;
uniform float uSaturation;
uniform float uVignette;
uniform float uTime;
uniform float uFlash;
uniform vec2 uSceneSize;   // internal pixel resolution
uniform vec2 uScreenSize;  // display pixel resolution
uniform float uGrain;
uniform float uAberration;

${NOISE_GLSL}

vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}
float bayer8(vec2 a) {
  return bayer4(0.5 * a) * 0.25 + bayer2(a);
}

void main() {
  // Nearest-neighbour sampling of the low-res scene keeps pixels square; the
  // tiny chromatic offset only kicks in on lightning so the frame "pops".
  vec2 uv = vUv;
  vec2 centre = uv - 0.5;
  float ab = uAberration * (0.25 + uFlash);
  vec3 scene;
  if (ab > 0.0002) {
    scene.r = texture(uScene, uv + centre * ab).r;
    scene.g = texture(uScene, uv).g;
    scene.b = texture(uScene, uv - centre * ab).b;
  } else {
    scene = texture(uScene, uv).rgb;
  }
  vec3 bloom = texture(uBloom, uv).rgb;

  vec3 col = scene + bloom * uBloomStrength;
  col *= uExposure;
  col = aces(col);

  // Time-of-day grade (lift/gain) + saturation.
  col = col * uGradeGain + uGradeLift;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);

  // Vignette, tightened during storms so the frame feels claustrophobic.
  float vig = 1.0 - smoothstep(0.30, 1.02, length(centre * vec2(1.08, 1.0)));
  col *= mix(1.0, vig, uVignette);

  // Lightning wash.
  col += vec3(0.55, 0.62, 0.8) * uFlash * 0.35;

  // Film grain + ordered dither to kill gradient banding in the sky.
  float grain = (hash21(uv * uScreenSize + fract(uTime) * 91.7) - 0.5) * uGrain;
  col += grain;
  col += (bayer8(gl_FragCoord.xy) - 0.5) / 96.0;

  outColor = vec4(col, 1.0);
}
`;

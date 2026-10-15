/**
 * Pipeline - owns every GPU resource and drives the frame:
 *
 *   sky (procedural gradient, stars, sun/moon, cloud bands)
 *     -> sprites (instanced, normal-mapped, painter's order)
 *     -> volumetric fog
 *     -> foreground sprites (near clouds, birds, rain) so they stay crisp
 *     -> bloom (bright pass + 3 mip gaussian + upsample)
 *     -> composite (ACES, time-of-day grade, vignette, grain, nearest upscale)
 *
 * The scene renders at the Camera's internal pixel-art resolution and the
 * composite upscales to the display, which is what keeps pixels square while
 * still allowing HDR glow.
 */

import { GL, type Program } from "./GL";
import { RenderTarget } from "./RenderTarget";
import { SpriteBatch } from "./SpriteBatch";
import type { Camera } from "./Camera";
import {
  BLOOM_DOWN_FS,
  BLOOM_UP_FS,
  BLUR_FS,
  BRIGHT_FS,
  COMPOSITE_FS,
  FOG_FS,
  FULLSCREEN_VS,
  SKY_FS,
  SPRITE_FS,
  SPRITE_VS,
} from "./shaders";

/** Everything the sprite shader needs to light the frame. */
export interface LightRig {
  sunDir: Float32Array; // 3 - surface -> light
  sunColor: Float32Array; // 3 - premultiplied by intensity
  ambient: Float32Array; // 3
  fogColor: Float32Array; // 3
  fogDensity: number;
  specular: number;
  pointPos: Float32Array; // 4 * vec4 (x, y, z, intensity)
  pointColor: Float32Array; // 4 * vec3
  pointCount: number;
}

export interface SkyParams {
  top: Float32Array;
  horizon: Float32Array;
  sunUv: [number, number];
  sunColor: Float32Array;
  sunRadius: number;
  sunIntensity: number;
  starAlpha: number;
  cloudCover: number;
  cloudColor: Float32Array;
  time: number;
  wind: number;
  windDir: number;
  flash: number;
}

export interface FogParams {
  color: Float32Array;
  density: number;
  time: number;
  scroll: number;
  wind: number;
  windDir: number;
  flash: number;
  sunColor: Float32Array;
  sunDir: [number, number];
  heightBias: number;
}

export interface CompositeParams {
  exposure: number;
  bloomStrength: number;
  gradeLift: Float32Array;
  gradeGain: Float32Array;
  saturation: number;
  vignette: number;
  time: number;
  flash: number;
  grain: number;
  aberration: number;
}

const BLOOM_MIPS = 3;

export class Pipeline {
  readonly gl2: GL;
  batch!: SpriteBatch;
  private scene!: RenderTarget;
  private bright!: RenderTarget;
  private mipA: RenderTarget[] = [];
  private mipB: RenderTarget[] = [];
  private progSprite!: Program;
  private progSky!: Program;
  private progFog!: Program;
  private progBright!: Program;
  private progDown!: Program;
  private progBlur!: Program;
  private progUp!: Program;
  private progComposite!: Program;
  private atlasColor: WebGLTexture | null = null;
  private atlasMaterial: WebGLTexture | null = null;
  private w = 480;
  private h = 270;
  /** True when the scene target could not be half-float. */
  private hdrOk = true;

  constructor(canvas: HTMLCanvasElement) {
    this.gl2 = new GL(canvas);
    const gl = this.gl2.gl;
    this.progSprite = this.gl2.program("sprite", SPRITE_VS, SPRITE_FS);
    this.progSky = this.gl2.program("sky", FULLSCREEN_VS, SKY_FS);
    this.progFog = this.gl2.program("fog", FULLSCREEN_VS, FOG_FS);
    this.progBright = this.gl2.program("bright", FULLSCREEN_VS, BRIGHT_FS);
    this.progDown = this.gl2.program("bloomDown", FULLSCREEN_VS, BLOOM_DOWN_FS);
    this.progBlur = this.gl2.program("blur", FULLSCREEN_VS, BLUR_FS);
    this.progUp = this.gl2.program("bloomUp", FULLSCREEN_VS, BLOOM_UP_FS);
    this.progComposite = this.gl2.program("composite", FULLSCREEN_VS, COMPOSITE_FS);
    void gl;
  }

  /** Upload the generated atlas and build the sprite batch around it. */
  setAtlas(color: Uint8ClampedArray, material: Uint8ClampedArray, size: number): void {
    const gl = this.gl2.gl;
    if (this.atlasColor) gl.deleteTexture(this.atlasColor);
    if (this.atlasMaterial) gl.deleteTexture(this.atlasMaterial);
    // Albedo stays NEAREST (crisp pixels); the normal map is filtered LINEAR so
    // lighting gradients across a sprite stay smooth instead of faceting.
    this.atlasColor = this.gl2.texture(color, size, size, { nearest: true });
    this.atlasMaterial = this.gl2.texture(material, size, size, { nearest: false });
    this.batch?.dispose();
    this.batch = new SpriteBatch(this.gl2, this.atlasColor, this.atlasMaterial);
  }

  resize(camera: Camera): void {
    const gl = this.gl2.gl;
    const w = camera.internalW;
    const h = camera.internalH;
    if (w === this.w && h === this.h && this.scene) return;
    this.w = w;
    this.h = h;

    canvasSize(gl.canvas, camera.fbWidth, camera.fbHeight);

    if (!this.scene) {
      this.scene = RenderTarget.create(this.gl2, w, h, true);
      this.bright = RenderTarget.create(this.gl2, w >> 1, h >> 1, true);
      for (let i = 0; i < BLOOM_MIPS; i++) {
        const mw = Math.max(2, w >> (i + 1));
        const mh = Math.max(2, h >> (i + 1));
        this.mipA.push(RenderTarget.create(this.gl2, mw, mh, true));
        this.mipB.push(RenderTarget.create(this.gl2, mw, mh, true));
      }
      this.hdrOk = this.scene.hdr;
    } else {
      this.scene.resize(this.gl2, w, h);
      this.bright.resize(this.gl2, Math.max(2, w >> 1), Math.max(2, h >> 1));
      for (let i = 0; i < BLOOM_MIPS; i++) {
        const mw = Math.max(2, w >> (i + 1));
        const mh = Math.max(2, h >> (i + 1));
        this.mipA[i].resize(this.gl2, mw, mh);
        this.mipB[i].resize(this.gl2, mw, mh);
      }
    }
    this.batch?.setPixelSnap(camera.pixelsPerWorldUnit);
  }

  get hdr(): boolean {
    return this.hdrOk;
  }

  // --- passes ---------------------------------------------------------------
  beginScene(): void {
    const gl = this.gl2.gl;
    this.scene.bind();
    this.scene.clear(0, 0, 0, 1);
    gl.disable(gl.BLEND);
  }

  drawSky(p: SkyParams): void {
    const gl = this.gl2.gl;
    const prog = this.progSky.use();
    prog.set("uTopColor", p.top);
    prog.set("uHorizonColor", p.horizon);
    prog.set("uSunUv", p.sunUv);
    prog.set("uSunColor", p.sunColor);
    prog.set("uSunRadius", p.sunRadius);
    prog.set("uSunIntensity", p.sunIntensity);
    prog.set("uStarAlpha", p.starAlpha);
    prog.set("uCloudCover", p.cloudCover);
    prog.set("uCloudColor", p.cloudColor);
    prog.set("uTime", p.time);
    prog.set("uWind", p.wind);
    prog.set("uWindDir", p.windDir);
    prog.set("uFlash", p.flash);
    prog.set("uAspect", [this.w / this.h, 1]);
    this.bindAtlas(prog);
    this.gl2.drawFullscreen();
    gl.enable(gl.BLEND);
  }

  /** Set sprite-program uniforms; call before pushing/drawing a layer group. */
  beginSprites(camera: Camera, rig: LightRig): void {
    const prog = this.progSprite.use();
    prog.set("uViewSize", [camera.viewW, camera.viewH]);
    prog.set("uOffset", [0, 0]);
    prog.set("uSunDir", rig.sunDir);
    prog.set("uSunColor", rig.sunColor);
    prog.set("uAmbient", rig.ambient);
    prog.set4v("uLightPos", rig.pointPos);
    prog.set3v("uLightColor", rig.pointColor);
    prog.setInt("uLightCount", rig.pointCount);
    prog.set("uFogColor", rig.fogColor);
    prog.set("uFogDensity", rig.fogDensity);
    prog.set("uSpecGlobal", rig.specular);
    prog.setInt("uAtlas", 0);
    prog.setInt("uMaterial", 1);
    this.batch.begin();
  }

  drawSprites(): void {
    this.batch.draw();
  }

  drawFog(p: FogParams): void {
    const prog = this.progFog.use();
    prog.set("uFogColor", p.color);
    prog.set("uDensity", p.density);
    prog.set("uTime", p.time);
    prog.set("uScroll", p.scroll);
    prog.set("uWind", p.wind);
    prog.set("uWindDir", p.windDir);
    prog.set("uFlash", p.flash);
    prog.set("uSunColor", p.sunColor);
    prog.set("uSunDir", p.sunDir);
    prog.set("uAspect", [this.w / this.h, 1]);
    prog.set("uHeightBias", p.heightBias);
    // No sampler here: haze is blended over the scene already in the target.
    this.gl2.drawFullscreen();
  }

  /** Bright pass + mip chain + separable blur + upsample-add. */
  bloom(threshold: number, knee: number): void {
    const gl = this.gl2.gl;

    this.bright.bind();
    const bp = this.progBright.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
    bp.setInt("uSrc", 0);
    bp.set("uThreshold", threshold);
    bp.set("uKnee", knee);
    this.gl2.drawFullscreen();

    // Downsample chain.
    let src = this.bright.texture;
    for (let i = 0; i < BLOOM_MIPS; i++) {
      const dst = this.mipA[i];
      dst.bind();
      const prog = this.progDown.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      prog.setInt("uSrc", 0);
      prog.set("uTexel", [1 / dst.width, 1 / dst.height]);
      this.gl2.drawFullscreen();
      src = dst.texture;
    }

    // Separable gaussian on every mip.
    for (let i = 0; i < BLOOM_MIPS; i++) {
      const a = this.mipA[i];
      const b = this.mipB[i];
      const blur = this.progBlur.use();
      blur.set("uTexel", [1 / a.width, 1 / a.height]);
      blur.setInt("uSrc", 0);
      b.bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.texture);
      blur.set("uDirection", [1, 0]);
      this.gl2.drawFullscreen();
      a.bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.texture);
      blur.set("uDirection", [0, 1]);
      this.gl2.drawFullscreen();
    }

    // Upsample-add from the coarsest mip back to the finest.
    const up = this.progUp.use();
    up.setInt("uSrc", 0);
    up.setInt("uHigher", 1);
    for (let i = BLOOM_MIPS - 1; i > 0; i--) {
      const coarse = i === BLOOM_MIPS - 1 ? this.mipA[i].texture : this.mipB[i].texture;
      const finer = this.mipA[i - 1];
      const dst = this.mipB[i - 1];
      dst.bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, coarse);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, finer.texture);
      up.set("uTexel", [1 / dst.width, 1 / dst.height]);
      up.set("uWeight", 1.0);
      this.gl2.drawFullscreen();
    }
  }

  get bloomTexture(): WebGLTexture {
    return this.mipB[0].texture;
  }

  composite(camera: Camera, p: CompositeParams): void {
    const gl = this.gl2.gl;
    RenderTarget.unbind(gl);
    gl.viewport(0, 0, camera.fbWidth, camera.fbHeight);
    const prog = this.progComposite.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTexture);
    prog.setInt("uScene", 0);
    prog.setInt("uBloom", 1);
    prog.set("uExposure", p.exposure);
    prog.set("uBloomStrength", p.bloomStrength);
    prog.set("uGradeLift", p.gradeLift);
    prog.set("uGradeGain", p.gradeGain);
    prog.set("uSaturation", p.saturation);
    prog.set("uVignette", p.vignette);
    prog.set("uTime", p.time);
    prog.set("uFlash", p.flash);
    prog.set("uSceneSize", [this.w, this.h]);
    prog.set("uScreenSize", [camera.fbWidth, camera.fbHeight]);
    prog.set("uGrain", p.grain);
    prog.set("uAberration", p.aberration);
    gl.disable(gl.BLEND);
    this.gl2.drawFullscreen();
    gl.enable(gl.BLEND);
  }

  private bindAtlas(prog: Program): void {
    // Sky/fog passes do not sample the atlas, but binding keeps texture units
    // consistent across passes on drivers that dislike stale bindings.
    const gl = this.gl2.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasColor);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasMaterial);
    void prog;
  }

  dispose(): void {
    const gl = this.gl2.gl;
    this.batch?.dispose();
    this.scene?.dispose();
    this.bright?.dispose();
    for (const t of this.mipA) t.dispose();
    for (const t of this.mipB) t.dispose();
    if (this.atlasColor) gl.deleteTexture(this.atlasColor);
    if (this.atlasMaterial) gl.deleteTexture(this.atlasMaterial);
    this.gl2.dispose();
  }
}

function canvasSize(canvas: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): void {
  if (canvas.width !== w) canvas.width = Math.max(1, w);
  if (canvas.height !== h) canvas.height = Math.max(1, h);
}

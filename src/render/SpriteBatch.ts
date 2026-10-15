/**
 * SpriteBatch - one instanced draw call for the whole 2.5D scene.
 *
 * Instances are 18 floats: centre, size, rotation (cos/sin), atlas UV rect,
 * RGBA tint and a material vector (emissive, normal strength, specular,
 * aerial-perspective depth). Everything is premultiplied-alpha, which means
 * opaque pixel art, soft clouds, cut-out foliage and additive glows all share
 * one blend state and can be batched together in painter's order.
 */

import type { GL } from "./GL";
import type { AtlasRegion } from "../art/Atlas";

export const INSTANCE_FLOATS = 18;

const MAX_INSTANCES = 4096;

export class SpriteBatch {
  private gl: WebGL2RenderingContext;
  private data = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
  private count = 0;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private quadVbo: WebGLBuffer;
  private colorTex: WebGLTexture;
  private materialTex: WebGLTexture;
  /** Pixels per world unit; 0 disables snapping. */
  private snapScale = 0;
  drawnInstances = 0;
  drawCalls = 0;

  constructor(owner: GL, colorTex: WebGLTexture, materialTex: WebGLTexture) {
    const gl = owner.gl;
    this.gl = gl;
    this.colorTex = colorTex;
    this.materialTex = materialTex;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    const quad = gl.createBuffer();
    if (!vao || !vbo || !ibo || !quad) throw new Error("SpriteBatch: buffer allocation failed");
    this.vao = vao;
    this.vbo = vbo;
    this.ibo = ibo;
    this.quadVbo = quad;

    gl.bindVertexArray(vao);

    // Static unit quad (location 0).
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance stream (locations 1..6, divisor 1).
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    const layout: [number, number, number][] = [
      [1, 2, 0], // iPos
      [2, 2, 8], // iSize
      [3, 2, 16], // iRot (cos, sin)
      [4, 4, 24], // iUv
      [5, 4, 40], // iColor
      [6, 4, 56], // iParams
    ];
    for (const [loc, size, offset] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 2, 1, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  setPixelSnap(pixelsPerWorldUnit: number): void {
    this.snapScale = pixelsPerWorldUnit > 0 ? pixelsPerWorldUnit : 0;
  }

  begin(): void {
    this.count = 0;
    this.drawnInstances = 0;
    this.drawCalls = 0;
  }

  private snap(v: number): number {
    if (this.snapScale === 0) return v;
    return Math.round(v * this.snapScale) / this.snapScale;
  }

  /**
   * Queue one sprite. All sizes/positions are in world units (viewport width = 1).
   *
   * @param rot   radians, clockwise in y-down screen space
   * @param flipX mirror the atlas rect (free variety without new art)
   */
  push(
    region: AtlasRegion,
    x: number,
    y: number,
    w: number,
    h: number,
    rot: number,
    r: number,
    g: number,
    b: number,
    a: number,
    emissive = 0,
    normalStrength = 1,
    specular = 0.25,
    aerial = 0,
    flipX = false,
  ): void {
    if (this.count >= MAX_INSTANCES) {
      // Rare: the instance stream is full, so flush it as its own draw call.
      this.upload();
      this.issue();
    }
    const o = this.count * INSTANCE_FLOATS;
    const d = this.data;
    d[o] = this.snap(x);
    d[o + 1] = this.snap(y);
    d[o + 2] = Math.max(0.0001, w);
    d[o + 3] = Math.max(0.0001, h);
    if (rot === 0) {
      d[o + 4] = 1;
      d[o + 5] = 0;
    } else {
      d[o + 4] = Math.cos(rot);
      d[o + 5] = Math.sin(rot);
    }
    if (flipX) {
      d[o + 6] = region.u1;
      d[o + 7] = region.v0;
      d[o + 8] = region.u0;
      d[o + 9] = region.v1;
    } else {
      d[o + 6] = region.u0;
      d[o + 7] = region.v0;
      d[o + 8] = region.u1;
      d[o + 9] = region.v1;
    }
    d[o + 10] = r;
    d[o + 11] = g;
    d[o + 12] = b;
    d[o + 13] = a;
    d[o + 14] = emissive;
    d[o + 15] = normalStrength;
    d[o + 16] = specular;
    d[o + 17] = aerial;
    this.count++;
  }

  /** Convenience overload for axis-aligned, unrotated quads. */
  pushRect(
    region: AtlasRegion,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
    emissive = 0,
    normalStrength = 1,
    specular = 0.2,
    aerial = 0,
  ): void {
    this.push(region, x, y, w, h, 0, r, g, b, a, emissive, normalStrength, specular, aerial, false);
  }

  private upload(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * INSTANCE_FLOATS);
    this.pendingDraw = this.count;
    this.count = 0;
  }

  private pendingDraw = 0;

  private issue(): void {
    if (this.pendingDraw === 0) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.materialTex);
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.pendingDraw);
    gl.bindVertexArray(null);
    this.drawnInstances += this.pendingDraw;
    this.drawCalls++;
    this.pendingDraw = 0;
  }

  /**
   * Issue the draw. Call after setting program uniforms - the batch never
   * touches uniforms, so the pipeline is free to change fog/lights per layer.
   */
  draw(): void {
    this.upload();
    this.issue();
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteBuffer(this.quadVbo);
    gl.deleteVertexArray(this.vao);
  }
}

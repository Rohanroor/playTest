/**
 * RenderTarget - a colour-only framebuffer (2D renders in painter's order, so
 * no depth attachment is needed) with automatic resizing and HDR fallback.
 */

import { GL } from "./GL";

export class RenderTarget {
  readonly gl: WebGL2RenderingContext;
  readonly fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  readonly hdr: boolean;

  private constructor(gl: WebGL2RenderingContext, owner: GL, width: number, height: number, hdr: boolean) {
    this.gl = gl;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.hdr = hdr;
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("Could not create a framebuffer");
    this.fbo = fbo;
    this.texture = owner.texture(null, this.width, this.height, {
      nearest: true,
      format: hdr ? gl.RGBA16F : gl.RGBA8,
      type: hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE && hdr) {
      // Some drivers refuse RGBA16F attachments: fall back to 8-bit and let the
      // composite pass compensate with a lower bloom threshold.
      gl.deleteTexture(this.texture);
      this.texture = owner.texture(null, this.width, this.height, { nearest: true });
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  static create(owner: GL, width: number, height: number, hdr = true): RenderTarget {
    return new RenderTarget(owner.gl, owner, width, height, hdr && owner.hdr);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  clear(r = 0, g = 0, b = 0, a = 1): void {
    this.gl.clearColor(r, g, b, a);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  resize(owner: GL, width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    this.width = w;
    this.height = h;
    this.texture = owner.texture(null, w, h, {
      nearest: true,
      format: this.hdr ? gl.RGBA16F : gl.RGBA8,
      type: this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.fbo);
  }

  static unbind(gl: WebGL2RenderingContext): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

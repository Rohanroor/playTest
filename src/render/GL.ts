/**
 * GL - thin WebGL2 layer: context creation, shader programs with cached
 * uniform locations, texture upload and honest error reporting.
 *
 * If a shader fails to compile the info log is thrown (and surfaced on the boot
 * overlay) rather than silently rendering black.
 */

export type UniformValue = number | number[] | Float32Array;

export class Program {
  readonly name: string;
  readonly handle: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private gl: WebGL2RenderingContext,
    name: string,
    vsSource: string,
    fsSource: string,
  ) {
    this.name = name;
    const vs = compile(gl, gl.VERTEX_SHADER, vsSource, name);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, name);
    const prog = gl.createProgram();
    if (!prog) throw new Error(`${name}: could not create program`);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? "unknown link error";
      gl.deleteProgram(prog);
      throw new Error(`Shader program "${name}" failed to link:\n${log}`);
    }
    this.handle = prog;
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  loc(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.handle, name));
    }
    return this.uniforms.get(name) ?? null;
  }

  /** Set by name; silently ignores uniforms the driver optimised away. */
  set(name: string, value: UniformValue): void {
    const gl = this.gl;
    const l = this.loc(name);
    if (!l) return;
    if (typeof value === "number") gl.uniform1f(l, value);
    else if (value.length === 2) gl.uniform2f(l, value[0], value[1]);
    else if (value.length === 3) gl.uniform3f(l, value[0], value[1], value[2]);
    else if (value.length === 4) gl.uniform4f(l, value[0], value[1], value[2], value[3]);
    else gl.uniform1fv(l, value as Float32Array | number[]);
  }

  setInt(name: string, value: number): void {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, value);
  }

  set2v(name: string, list: Float32Array | number[]): void {
    const l = this.loc(name);
    if (l) this.gl.uniform2fv(l, list as Float32Array);
  }

  set3v(name: string, list: Float32Array | number[]): void {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, list as Float32Array);
  }

  set4v(name: string, list: Float32Array | number[]): void {
    const l = this.loc(name);
    if (l) this.gl.uniform4fv(l, list as Float32Array);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, programName: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`${programName}: cannot create shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(
      `${programName} ${kind} shader failed to compile:\n${log}\n` +
        annotate(source, log),
    );
  }
  return shader;
}

/** Pull the offending line out of the info log for a readable error. */
function annotate(source: string, log: string): string {
  const m = /ERROR:\s*\d+:(\d+):/.exec(log);
  if (!m) return "";
  const line = Number(m[1]);
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i++) {
    out.push(`${i + 1 === line ? ">>" : "  "} ${i + 1}: ${lines[i]}`);
  }
  return out.join("\n");
}

export interface TextureOptions {
  nearest?: boolean;
  wrapS?: number;
  wrapT?: number;
  mipmaps?: boolean;
  format?: number;
  type?: number;
}

export class GL {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** True when half-float render targets are available (bloom wants HDR). */
  readonly hdr: boolean;
  readonly hdrFormat: number;
  readonly hdrType: number;
  private programs = new Map<string, Program>();
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadVbo: WebGLBuffer | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      desynchronized: false,
      failIfMajorPerformanceCaveat: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new Error(
        "WebGL2 is unavailable in this browser. ASCENSION needs WebGL2 (any modern browser: Chrome 56+, Firefox 51+, Safari 15+).",
      );
    }
    this.gl = gl;

    const floatExt = gl.getExtension("EXT_color_buffer_float");
    const halfExt = gl.getExtension("EXT_color_buffer_half_float");
    this.hdr = Boolean(floatExt ?? halfExt);
    this.hdrFormat = gl.RGBA16F;
    this.hdrType = gl.HALF_FLOAT;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    // Premultiplied alpha: one blend state for opaque, cut-out and additive.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  program(name: string, vs: string, fs: string): Program {
    let p = this.programs.get(name);
    if (!p) {
      p = new Program(this.gl, name, vs, fs);
      this.programs.set(name, p);
    }
    return p;
  }

  texture(
    data: Uint8ClampedArray | Uint8Array | Float32Array | null,
    width: number,
    height: number,
    opts: TextureOptions = {},
  ): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("Could not allocate a texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const internal = opts.format ?? gl.RGBA8;
    const type = opts.type ?? gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, data as ArrayBufferView | null);
    const filter = opts.nearest === false ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT ?? gl.CLAMP_TO_EDGE);
    if (opts.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /** Shared fullscreen triangle-pair VAO used by every post pass. */
  quad(): WebGLVertexArrayObject {
    const gl = this.gl;
    if (this.quadVao) return this.quadVao;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("Could not allocate the fullscreen quad");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadVao = vao;
    this.quadVbo = vbo;
    return vao;
  }

  drawFullscreen(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quad());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of this.programs.values()) gl.deleteProgram(p.handle);
    this.programs.clear();
    if (this.quadVbo) gl.deleteBuffer(this.quadVbo);
    if (this.quadVao) gl.deleteVertexArray(this.quadVao);
  }
}

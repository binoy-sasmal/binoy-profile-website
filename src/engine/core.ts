// Core plumbing for the particle engine: PingPongFBO, TrianglePass, a patched
// MeshBasicMaterial, a custom depth material, and small math helpers.
// Logic and constants are kept verbatim from the reference implementation;
// only the naming is ours.
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  FloatType,
  MeshBasicMaterial,
  type MeshBasicMaterialParameters,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Shader,
  type PerspectiveCamera,
  type Texture,
  type TextureFilter,
  type TextureDataType,
  WebGLRenderTarget,
} from 'three';
import { TRIANGLE_FRAGMENT, TRIANGLE_VERTEX } from './shaders';

/** Viewport size in world units at distance `dist` from a perspective camera. */
export function fitViewSize(camera: PerspectiveCamera, dist: number) {
  const fovRad = (camera.fov * Math.PI) / 180;
  const height = 2 * Math.tan(fovRad / 2) * Math.abs(dist);
  return { width: height * camera.aspect, height };
}

/** Linear remap without clamping. */
export function mapRange(value: number, min1: number, max1: number, min2: number, max2: number) {
  return min2 + ((value - min1) * (max2 - min2)) / (max1 - min1);
}

/** Clamp. */
export function clamp(value: number, lo: number, hi: number) {
  return Math.min(Math.max(value, lo), hi);
}

/** Ping-pong render-target pair for GPGPU passes. */
export class PingPongFBO {
  private _read: WebGLRenderTarget;
  private _write: WebGLRenderTarget;

  constructor({
    width = 256,
    height = 256,
    format = RGBAFormat,
    type = FloatType as TextureDataType,
    minFilter = NearestFilter as TextureFilter,
    magFilter = NearestFilter as TextureFilter,
    depthBuffer = false,
    stencilBuffer = false,
    generateMipmaps = false,
  } = {}) {
    const options = {
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter,
      magFilter,
      format,
      type,
      stencilBuffer,
      depthBuffer,
      generateMipmaps,
    };
    this._read = new WebGLRenderTarget(width, height, options);
    this._write = new WebGLRenderTarget(width, height, options);
  }

  swap() {
    const t = this._read;
    this._read = this._write;
    this._write = t;
  }

  get read() {
    return this._read;
  }

  get write() {
    return this._write;
  }
}

/**
 * Fullscreen-triangle pass with its own ortho camera/scene.
 * Geometry is a 2-component position triangle spanning the unit ortho frustum.
 */
export class TrianglePass {
  readonly geometry: BufferGeometry;
  private _material: RawShaderMaterial;
  private _mesh: Mesh;
  readonly scene: Scene;
  readonly camera: OrthographicCamera;

  constructor({
    positions = new Float32Array([-0.5, -0.5, 1.5, -0.5, -0.5, 1.5]),
    uvs = new Float32Array([0, 0, 2, 0, 0, 2]),
    material = new RawShaderMaterial({
      uniforms: { t_diffuse: { value: null } },
      vertexShader: TRIANGLE_VERTEX,
      fragmentShader: TRIANGLE_FRAGMENT,
    }),
    texture = null as Texture | null,
  } = {}) {
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(positions, 2));
    this.geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    if (texture) {
      material.uniforms.t_diffuse = { value: texture };
    }
    this._material = material;
    this._mesh = new Mesh(this.geometry, this._material);
    this.camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
    this.scene = new Scene();
    this.scene.add(this._mesh);
  }

  get material() {
    return this._material;
  }
}

export interface CustomUniform {
  id: string;
  type: string;
  value: unknown;
}

/**
 * MeshBasicMaterial with an injected uniform array + onBeforeCompile patching
 * The uniform OBJECTS are shared into the compiled program, so
 * writing `customUniforms[n].value` after compile still works.
 */
export class PatchedBasicMaterial extends MeshBasicMaterial {
  private _customUniforms: CustomUniform[];

  constructor(
    params: MeshBasicMaterialParameters & {
      customUniforms: CustomUniform[];
      onBeforeCompile: (shader: Shader) => void;
    }
  ) {
    const { customUniforms, onBeforeCompile, ...base } = params;
    super(base);
    this._customUniforms = customUniforms;
    this.onBeforeCompile = onBeforeCompile;
  }

  get customUniforms() {
    return this._customUniforms;
  }
}

export interface DepthUniform {
  type: string;
  value: unknown;
}

import { DEPTH_FRAGMENT, DEPTH_VERTEX } from './shaders';

/**
 * Custom depth material writing 1 - smoothstep(near, far, viewZ).
 * Used as the cloud's customDepthMaterial; the bokeh pass renders it.
 */
export class CloudDepthMaterial extends ShaderMaterial {
  private _customUniforms: Record<string, DepthUniform>;

  constructor({
    customUniforms = {} as Record<string, DepthUniform>,
    near = 0.1,
    far = 13,
    transparent = false,
    onBeforeCompile = (_shader: Shader) => {},
  } = {}) {
    let vertex = DEPTH_VERTEX;
    let fragment = DEPTH_FRAGMENT;
    customUniforms.u_near = { type: 'float', value: near };
    customUniforms.u_far = { type: 'float', value: far };
    const uniforms: Record<string, DepthUniform> = {};
    Object.keys(customUniforms).forEach((key) => {
      uniforms[key] = customUniforms[key];
      vertex = `uniform ${customUniforms[key].type} ${key};\n` + vertex;
      fragment = `uniform ${customUniforms[key].type} ${key};\n` + fragment;
    });
    super({
      transparent,
      uniforms: uniforms as never,
      vertexShader: vertex,
      fragmentShader: fragment,
    });
    this._customUniforms = customUniforms;
    this.onBeforeCompile = onBeforeCompile;
  }

  get customUniforms() {
    return this._customUniforms;
  }
}

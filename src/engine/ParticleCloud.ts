// The hero particle cloud.
// 10k/7k instanced pyramids driven by two GPGPU passes (position + spring),
// sampling a 200x200 4-quadrant atlas (t_position/t_color/t_scale) blended
// by u_progress. All constants, uniform indices, keyframes and shader patches
// are verbatim; only the plumbing (no globals, assets injected) is ours.
// Dropped vs the original: the fluid-sim hook (t_fluid stays null).
import gsap from 'gsap';
import {
  DataTexture,
  FloatType,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NearestFilter,
  Object3D,
  type PerspectiveCamera,
  Quaternion,
  RGBAFormat,
  type Shader,
  type Texture,
  UVMapping,
  ClampToEdgeWrapping,
  Vector2,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import {
  CloudDepthMaterial,
  PatchedBasicMaterial,
  PingPongFBO,
  TrianglePass,
  clamp,
  fitViewSize,
  mapRange,
} from './core';
import {
  CHUNK_QUINTIC_INOUT,
  CHUNK_QUINTIC_OUT,
  CHUNK_ROTATION_LOOKAT,
  CHUNK_SNOISE3,
  CLOUD_OUTPUT_FRAGMENT,
  CLOUD_PROJECT_VERTEX,
  CLOUD_WORLDPOS_VERTEX,
  SIM_POS_FRAGMENT,
  SIM_SPRING_FRAGMENT,
  SIM_VERTEX,
} from './shaders';
import { RawShaderMaterial } from 'three';

export interface CloudAssets {
  renderer: WebGLRenderer;
  /** 200x200 8-bit RT holding the rendered position atlas (for CPU order readback). */
  positionRT: WebGLRenderTarget;
  positionTexture: Texture; // EXR atlas (flipY=true, nearest)
  scaleTexture: Texture; // sc png (flipY=false, nearest)
  colorTexture: Texture; // cd png (flipY=false, nearest)
  /** Cloned pyramid geometry from the GLB. */
  geometry: import('three').BufferGeometry;
}

interface OrderEntry {
  x?: number;
  y?: number;
  z?: number;
  index: number;
  order: number;
}

export class ParticleCloud extends Group {
  readonly nb: number;
  private _isMobile: boolean;
  private _loaded = false;
  active = false;
  private _hasRendered = false;
  private _easing = 0.1;
  private _factor: number;
  private _scale: number;
  private _mTg = { x: 0, y: 0 };
  private _mPr = { x: 0, y: 0 };
  private _mDelta = { x: 0, y: 0 };
  readonly royYEnd: number;
  private _params = {
    pr: 0,
    baseRotation: new Vector3(0, -0.25 * Math.PI, 0),
    basePosition: new Vector3(),
  };
  private _position1 = new Vector3(0, -1.19, 0);

  private _renderer!: WebGLRenderer;
  private _geometry!: import('three').BufferGeometry;
  private _material!: PatchedBasicMaterial;
  private _depthMaterial!: CloudDepthMaterial;
  private _mesh!: InstancedMesh;
  private _tParams!: DataTexture;
  private _tParams2!: DataTexture;
  private _tParams3!: DataTexture;
  private _fboPos!: PingPongFBO;
  private _fboSpring!: PingPongFBO;
  private _simulationPos!: TrianglePass;
  private _simulationSpring!: TrianglePass;
  private _pSize!: { width: number; height: number };
  private _pSize2!: { width: number; height: number };

  /** External scroll progress (section progress), 0..~6. */
  sectionProgress = 0;

  /**
   * Choreography mode. 'builtin' replays the built-in keyframes from
   * sectionProgress (used by the local engine-test harness). 'external' lets
   * a driver set `targets` directly — the site's morph/scroll driver.
   */
  choreography: 'builtin' | 'external' = 'builtin';

  /** Targets for 'external' mode; lerped with the same easing. */
  readonly targets = {
    progress: 0, // local atlas u_progress, 0..3
    explode: 0,
    factor: null as number | null, // null = shape default (_factor)
    x: 0,
    y: 0,
    rotY: 0,
    rotZ: 0,
  };

  constructor({ isMobile = false } = {}) {
    super();
    this._isMobile = isMobile;
    this.nb = isMobile ? 7000 : 10000;
    this._factor = isMobile ? 2.5 : 4.35;
    this._scale = isMobile ? 1.2 : 1.55;
    this.royYEnd = isMobile ? 5.8 : 6;
    this.position.copy(this._position1);
  }

  get loaded() {
    return this._loaded;
  }

  get material() {
    return this._material;
  }

  onAssetsLoaded(assets: CloudAssets) {
    this._renderer = assets.renderer;
    this._geometry = assets.geometry;
    this._setupFBO(assets);
    this._setupMaterial(assets);
    this._setupMesh();
    this._loaded = true;
  }

  /** Swap the position atlas (Phase 4 atlas-chain). Legal only at settled integer u_progress. */
  setPositionTexture(texture: Texture) {
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.flipY = true;
    texture.needsUpdate = true;
    this._simulationPos.material.uniforms.t_position.value = texture;
    this._simulationSpring.material.uniforms.t_position.value = texture;
    this._material.customUniforms[0].value = texture;
    this._depthMaterial.customUniforms.t_position.value = texture;
  }

  setColorTexture(texture: Texture) {
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.flipY = false;
    texture.needsUpdate = true;
    this._material.customUniforms[2].value = texture;
    this._depthMaterial.customUniforms.t_color.value = texture;
  }

  private _setupFBO(assets: CloudAssets) {
    // CPU readback of the (8-bit) position RT: per-quadrant sorted orders that
    // drive the staggered show/morph delays. Verbatim from the reference (incl. the
    // duplicate Q1 read used for both `s` and `h`).
    const renderer = this._renderer;
    const rt = assets.positionRT;
    const q1 = new Uint8Array(40000);
    renderer.readRenderTargetPixels(rt, 0, 0, 100, 100, q1);
    const q2 = new Uint8Array(40000);
    renderer.readRenderTargetPixels(rt, 100, 0, 100, 100, q2);
    const q3 = new Uint8Array(40000);
    renderer.readRenderTargetPixels(rt, 0, 100, 100, 100, q3);
    const q4 = new Uint8Array(40000);
    renderer.readRenderTargetPixels(rt, 100, 100, 100, 100, q4);
    const q1b = new Uint8Array(40000);
    renderer.readRenderTargetPixels(rt, 0, 0, 100, 100, q1b);

    const s: OrderEntry[] = [];
    const a: OrderEntry[] = [];
    const l: OrderEntry[] = [];
    const c: OrderEntry[] = [];
    const h: OrderEntry[] = [];
    {
      let idx = 0;
      for (let i = 0; i < q1.length; i += 4)
        s.push({ x: q1[i], y: q1[i + 1], z: q1[i + 2], index: idx++, order: 0 });
      s.sort((m, n) => n.y! - m.y!);
      for (let i = 0; i < s.length; i++) s[i].order = i;
      s.sort((m, n) => m.index - n.index);
    }
    {
      let idx = 0;
      for (let i = 0; i < q2.length; i += 4) a.push({ x: q2[i], index: idx++, order: 0 });
      a.sort((m, n) => m.x! - n.x!);
      for (let i = 0; i < a.length; i++) a[i].order = i;
      a.sort((m, n) => m.index - n.index);
    }
    {
      let idx = 0;
      for (let i = 0; i < q3.length; i += 4) l.push({ x: q3[i], index: idx++, order: 0 });
      l.sort((m, n) => n.x! - m.x!);
      for (let i = 0; i < l.length; i++) l[i].order = i;
      l.sort((m, n) => m.index - n.index);
    }
    {
      let idx = 0;
      for (let i = 0; i < q4.length; i += 4) c.push({ y: q4[i + 1], index: idx++, order: 0 });
      c.sort((m, n) => n.y! - m.y!);
      for (let i = 0; i < c.length; i++) c[i].order = i;
      c.sort((m, n) => m.index - n.index);
    }
    {
      let idx = 0;
      for (let i = 0; i < q1b.length; i += 4) h.push({ y: q1b[i + 1], index: idx++, order: 0 });
      h.sort((m, n) => m.y! - n.y!);
      for (let i = 0; i < h.length; i++) h[i].order = i;
      h.sort((m, n) => m.index - n.index);
    }

    const texArgs = [
      RGBAFormat,
      FloatType,
      UVMapping,
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
      NearestFilter,
      NearestFilter,
      0,
    ] as const;
    this._tParams = new DataTexture(new Float32Array(40000), 100, 100, ...texArgs);
    this._tParams.generateMipmaps = false;
    this._tParams2 = new DataTexture(new Float32Array(40000), 100, 100, ...texArgs);
    this._tParams2.generateMipmaps = false;
    this._tParams3 = new DataTexture(new Float32Array(40000), 100, 100, ...texArgs);
    this._tParams3.generateMipmaps = false;
    for (let i = 0; i < this.nb; i++) {
      this._tParams.image.data[4 * i] = i % 2 === 0 ? Math.random() : -1 * Math.random();
      this._tParams.image.data[4 * i + 1] = Math.floor(i / 100) / 200 + 0.0025;
      this._tParams.image.data[4 * i + 2] = s[i].order;
      this._tParams.image.data[4 * i + 3] = 2e-4 * Math.random() - 1e-4;
      this._tParams2.image.data[4 * i] = a[i].order;
      this._tParams2.image.data[4 * i + 1] = l[i].order;
      this._tParams2.image.data[4 * i + 2] = c[i].order;
      this._tParams2.image.data[4 * i + 3] = h[i].order;
      this._tParams3.image.data[4 * i] = 1 + 5 * Math.random();
      this._tParams3.image.data[4 * i + 1] = 2 * Math.random() - 1;
      this._tParams3.image.data[4 * i + 2] = mapRange(s[i].x!, 0, 256, -1, 1);
      this._tParams3.image.data[4 * i + 3] = 0;
    }
    this._tParams.needsUpdate = true;
    this._tParams2.needsUpdate = true;
    this._tParams3.needsUpdate = true;

    const rtType = this._isMobile ? HalfFloatType : FloatType;
    this._fboPos = new PingPongFBO({ width: 200, height: 200, type: rtType });
    this._fboSpring = new PingPongFBO({ width: 200, height: 200, type: rtType });

    this._simulationPos = new TrianglePass({
      material: new RawShaderMaterial({
        uniforms: {
          t_position: { value: null },
          t_velocity: { value: null },
          t_params: { value: this._tParams },
          t_params2: { value: this._tParams2 },
          t_pos: { value: null },
          t_oPos: { value: null },
          u_show: { value: 0 },
          u_length: { value: this.nb },
          u_explode: { value: 0 },
          u_factor: { value: this._factor },
          u_progress: { value: 0 },
          u_rendered: { value: 0 },
        },
        vertexShader: SIM_VERTEX,
        fragmentShader: SIM_POS_FRAGMENT,
      }),
    });
    const posTex = assets.positionTexture;
    this._simulationPos.material.uniforms.t_position.value = posTex;
    posTex.minFilter = posTex.magFilter = NearestFilter;
    posTex.flipY = true;
    posTex.needsUpdate = true;
    this._simulationPos.material.needsUpdate = true;

    this._simulationSpring = new TrianglePass({
      material: new RawShaderMaterial({
        uniforms: {
          t_position: { value: null },
          t_oTarget: { value: null },
          t_params: { value: this._tParams },
          t_params2: { value: this._tParams2 },
          t_params3: { value: this._tParams3 },
          t_velocity: { value: null },
          t_oVelocity: { value: null },
          u_show: { value: 0 },
          u_length: { value: this.nb },
          u_explode: { value: 0 },
          u_factor: { value: this._factor },
          u_progress: { value: 0 },
          u_spring: { value: 0.006 },
          u_friction: { value: 0.892 },
          u_resolution: { value: new Vector2() },
          u_rendered: { value: 0 },
          u_delay: { value: this._isMobile ? 25e-6 : 5e-4 },
        },
        vertexShader: SIM_VERTEX,
        fragmentShader: SIM_SPRING_FRAGMENT,
      }),
    });
    this._simulationSpring.material.uniforms.t_position.value = posTex;
    this._simulationSpring.material.needsUpdate = true;
  }

  private _setupMaterial(assets: CloudAssets) {
    this._material = new PatchedBasicMaterial({
      transparent: true,
      customUniforms: [
        { id: 't_position', type: 'sampler2D', value: null }, // 0
        { id: 't_scale', type: 'sampler2D', value: null }, // 1
        { id: 't_color', type: 'sampler2D', value: null }, // 2
        { id: 'u_factor', type: 'float', value: this._factor }, // 3
        { id: 'u_time', type: 'float', value: 0 }, // 4
        { id: 'u_scale', type: 'float', value: this._scale }, // 5
        { id: 'u_amplitude', type: 'float', value: 0.619 }, // 6
        { id: 'u_colorFactor', type: 'float', value: 1.3 }, // 7
        { id: 'u_show', type: 'float', value: 0 }, // 8
        { id: 'u_length', type: 'float', value: this.nb }, // 9
        { id: 'u_mouse', type: 'vec2', value: new Vector2(0, 0) }, // 10
        { id: 'u_resolution', type: 'vec2', value: new Vector2(1, 1) }, // 11
        { id: 'u_offset', type: 'vec3', value: new Vector3(0, 0, 0) }, // 12
        { id: 'u_explode', type: 'float', value: 0 }, // 13
        { id: 'u_progress', type: 'float', value: 0 }, // 14
        { id: 'u_rotation', type: 'vec3', value: new Vector3() }, // 15
        { id: 'u_amplitude2', type: 'float', value: 0.5 }, // 16
        { id: 't_simulation', type: 'sampler2D', value: null }, // 17
        { id: 't_fluid', type: 'sampler2D', value: null }, // 18
        { id: 'u_resolution2', type: 'vec2', value: new Vector2() }, // 19
        { id: 'u_progress2', type: 'float', value: 0 }, // 20
        { id: 'u_delta', type: 'vec2', value: new Vector2() }, // 21
        { id: 'u_delay', type: 'vec2', value: (this._isMobile ? 25e-6 : 5e-4) as unknown }, // 22
        { id: 'u_mobileRotation', type: 'float', value: this._isMobile ? 1 * Math.PI : 0 }, // 23
      ],
      onBeforeCompile: function (this: PatchedBasicMaterial, shader: Shader) {
        for (let t = 0; t < this.customUniforms.length; t++) {
          const u = this.customUniforms[t];
          (shader.uniforms as Record<string, unknown>)[u.id] = u;
          shader.vertexShader = `uniform ${u.type} ${u.id};\n` + shader.vertexShader;
          shader.fragmentShader = `uniform ${u.type} ${u.id};\n` + shader.fragmentShader;
        }
        shader.vertexShader = CHUNK_SNOISE3 + shader.vertexShader;
        shader.vertexShader = CHUNK_QUINTIC_INOUT + shader.vertexShader;
        shader.vertexShader = CHUNK_ROTATION_LOOKAT + shader.vertexShader;
        shader.vertexShader = CHUNK_QUINTIC_OUT + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_random;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_angle;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec2 a_id;\n' + shader.vertexShader;
        shader.vertexShader = 'varying vec2 v_id;\n' + shader.vertexShader;
        shader.vertexShader = 'varying vec3 v_pos;\n' + shader.vertexShader;
        shader.vertexShader = 'varying float v_hover;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute float a_order;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute float a_index;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', CLOUD_PROJECT_VERTEX);
        shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', CLOUD_WORLDPOS_VERTEX);
        shader.fragmentShader = 'varying vec3 v_pos;\n' + shader.fragmentShader;
        shader.fragmentShader = 'varying vec2 v_id;\n' + shader.fragmentShader;
        shader.fragmentShader = 'varying float v_hover;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', CLOUD_OUTPUT_FRAGMENT);
      },
    });
    // Texture wiring + sampling states, verbatim (EXR flipY=true; sc/cd flipY=false).
    this._material.customUniforms[0].value = assets.positionTexture;
    this._material.customUniforms[1].value = assets.scaleTexture;
    this._material.customUniforms[2].value = assets.colorTexture;
    const pos = assets.positionTexture;
    const sc = assets.scaleTexture;
    const cd = assets.colorTexture;
    pos.minFilter = pos.magFilter = NearestFilter;
    pos.flipY = true;
    pos.needsUpdate = true;
    sc.minFilter = sc.magFilter = NearestFilter;
    sc.flipY = false;
    sc.needsUpdate = true;
    cd.minFilter = cd.magFilter = NearestFilter;
    cd.flipY = false;
    cd.needsUpdate = true;
    this._material.needsUpdate = true;
  }

  private _setupMesh() {
    this._mesh = new InstancedMesh(this._geometry, this._material, this.nb);
    const mat4 = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    const aRandom = new Float32Array(4 * this.nb);
    const aAngle = new Float32Array(4 * this.nb);
    const aId = new Float32Array(2 * this.nb);
    const aIndex = new Float32Array(this.nb);
    const aOrder = new Float32Array(this.nb);
    let row = 0;
    for (let i = 0; i < this.nb; i++) {
      pos.set(0, 0, 0);
      scl.set(0.1, 0.1, 0.1);
      mat4.compose(pos, quat, scl);
      this._mesh.setMatrixAt(i, mat4);
      mat4.identity();
      aId[2 * i] = (i % 100) / 200 + 0.0025;
      aId[2 * i + 1] = Math.floor(row / 100) / 200 + 0.0025;
      aAngle[4 * i] = Math.random();
      aAngle[4 * i + 1] = Math.random();
      aAngle[4 * i + 2] = Math.random();
      aAngle[4 * i + 3] = Math.random();
      aIndex[i] = i;
      aOrder[i] = 0;
      aRandom[4 * i] = i % 2 === 0 ? Math.random() : -1 * Math.random();
      aRandom[4 * i + 1] = 0.8 * Math.random() + 0.2;
      aRandom[4 * i + 2] = this._isMobile ? 0.5 * Math.random() : 0.5 * Math.random() + 0.5;
      aRandom[4 * i + 3] = 0;
      row++;
    }
    this._geometry.setAttribute('a_index', new InstancedBufferAttribute(aIndex, 1));
    this._geometry.setAttribute('a_order', new InstancedBufferAttribute(aOrder, 1));
    this._geometry.setAttribute('a_id', new InstancedBufferAttribute(aId, 2));
    this._geometry.setAttribute('a_angle', new InstancedBufferAttribute(aAngle, 4));
    this._geometry.setAttribute('a_random', new InstancedBufferAttribute(aRandom, 4));

    this._depthMaterial = new CloudDepthMaterial({
      transparent: true,
      customUniforms: {
        t_position: { type: 'sampler2D', value: this._material.customUniforms[0].value },
        t_scale: { type: 'sampler2D', value: this._material.customUniforms[1].value },
        t_color: { type: 'sampler2D', value: this._material.customUniforms[2].value },
        u_factor: { type: 'float', value: this._factor },
        u_time: { type: 'float', value: 0 },
        u_scale: { type: 'float', value: this._scale },
        u_amplitude: { type: 'float', value: 0.619 },
        u_colorFactor: { type: 'float', value: 1.3 },
        u_show: { type: 'float', value: 0 },
        u_length: { type: 'float', value: this.nb },
        u_mouse: { type: 'vec2', value: new Vector2(0, 0) },
        u_resolution: { type: 'vec2', value: new Vector2(1, 1) },
        u_offset: { type: 'vec3', value: new Vector3(0, 0, 0) },
        u_explode: { type: 'float', value: 0 },
        u_progress: { type: 'float', value: 0 },
        u_rotation: { type: 'vec3', value: new Vector3() },
        u_amplitude2: { type: 'float', value: 0.5 },
        t_simulation: { type: 'sampler2D', value: null },
        t_fluid: { type: 'sampler2D', value: null },
        u_resolution2: { type: 'vec2', value: new Vector2() },
        u_progress2: { type: 'float', value: 0 },
        u_delta: { type: 'vec2', value: new Vector2() },
        // Fix over the verbatim port: the original INVERTED this flag between beauty
        // and depth (desktop beauty tumbles particles via noise rotation,
        // desktop depth billboarded them), so each pyramid rotated in the
        // image while its blur footprint stayed still — visibly detached
        // bokeh. Match the beauty branch exactly.
        u_mobileRotation: { type: 'float', value: this._isMobile ? 1 * Math.PI : 0 },
      },
      onBeforeCompile: (shader: Shader) => {
        shader.vertexShader = CHUNK_SNOISE3 + shader.vertexShader;
        shader.vertexShader = CHUNK_QUINTIC_INOUT + shader.vertexShader;
        shader.vertexShader = CHUNK_ROTATION_LOOKAT + shader.vertexShader;
        shader.vertexShader = CHUNK_QUINTIC_OUT + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_random;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_angle;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec2 a_id;\n' + shader.vertexShader;
        shader.vertexShader = 'varying vec2 v_id;\n' + shader.vertexShader;
        shader.vertexShader = 'varying vec3 v_pos;\n' + shader.vertexShader;
        shader.vertexShader = 'varying float v_hover;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute float a_order;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute float a_index;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', CLOUD_PROJECT_VERTEX);
      },
    });
    this._mesh.customDepthMaterial = this._depthMaterial;
    this.add(this._mesh);
  }

  /** Lerp rate for uniform targets (0.1). 1 = instant (reduced motion). */
  set easing(v: number) {
    this._easing = v;
  }

  /** The on-load gather: scatter -> settled form over 3s.
   *  `instant: true` skips the animation (prefers-reduced-motion). */
  activate({ delay = 0, instant = false } = {}) {
    if (this.active) return;
    if (instant) {
      this._simulationPos.material.uniforms.u_show.value = 1;
      this._simulationSpring.material.uniforms.u_show.value = 1;
      this._material.customUniforms[8].value = 1;
      this._depthMaterial.customUniforms.u_show.value = 1;
      this._params.baseRotation.y = 0;
      this.active = true;
      return;
    }
    const duration = 3;
    gsap.killTweensOf(this._simulationPos.material.uniforms.u_show);
    gsap.to(this._simulationPos.material.uniforms.u_show, { value: 1, duration, ease: 'none', delay });
    gsap.killTweensOf(this._simulationSpring.material.uniforms.u_show);
    gsap.to(this._simulationSpring.material.uniforms.u_show, { value: 1, duration, ease: 'none', delay });
    gsap.killTweensOf(this._material.customUniforms[8]);
    gsap.to(this._material.customUniforms[8], { value: 1, duration, ease: 'none', delay });
    gsap.killTweensOf(this._depthMaterial.customUniforms.u_show);
    gsap.to(this._depthMaterial.customUniforms.u_show, { value: 1, duration, ease: 'none', delay });
    gsap.killTweensOf(this._params.baseRotation);
    gsap.to(this._params.baseRotation, { y: 0, duration, ease: 'power2.out', delay });
    this.active = true;
  }

  deactivate({ delay = 0 } = {}) {
    if (!this.active) return;
    gsap.killTweensOf(this._material.customUniforms[8]);
    gsap.to(this._material.customUniforms[8], { value: 3, duration: 3, ease: 'none', delay });
    gsap.killTweensOf(this._depthMaterial.customUniforms.u_show);
    gsap.to(this._depthMaterial.customUniforms.u_show, { value: 3, duration: 3, ease: 'none', delay });
    this.active = false;
  }

  onMousedown(m: { x: number; y: number }) {
    this._mTg = m;
    this._mPr.x = this._mTg.x;
    this._mPr.y = this._mTg.y;
    this._mDelta.x = 0;
    this._mDelta.y = 0;
  }

  onMousemove(m: { x: number; y: number }) {
    this._mTg = m;
    if (this._isMobile) {
      this._mDelta.x = clamp(50 * (this._mTg.x - this._mPr.x), -0.1, 0.1);
      this._mDelta.y = clamp(50 * (this._mTg.y - this._mPr.y), -0.1, 0.1);
    } else {
      this._mDelta.x = clamp(50 * (this._mTg.x - this._mPr.x), -2, 2);
      this._mDelta.y = clamp(50 * (this._mTg.y - this._mPr.y), -2, 2);
    }
    this._mPr.x = this._mTg.x;
    this._mPr.y = this._mTg.y;
  }

  onMouseleave() {
    this._mDelta.x = 0;
    this._mDelta.y = 0;
  }

  resize({ camera }: { camera: PerspectiveCamera }) {
    if (!this._material) return;
    this._pSize = fitViewSize(camera, 10);
    this._pSize2 = fitViewSize(camera, 6.5);
    (this._material.customUniforms[11].value as Vector2).set(this._pSize.width, this._pSize.height);
    (this._depthMaterial.customUniforms.u_resolution.value as Vector2).set(this._pSize.width, this._pSize.height);
    (this._simulationSpring.material.uniforms.u_resolution.value as Vector2).set(this._pSize.width, this._pSize.height);
    (this._material.customUniforms[19].value as Vector2).set(this._pSize2.width, this._pSize2.height);
    (this._depthMaterial.customUniforms.u_resolution2.value as Vector2).set(this._pSize2.width, this._pSize2.height);
  }

  update(time: number) {
    if (!this._loaded) return;
    this._material.customUniforms[4].value = time;
    this._depthMaterial.customUniforms.u_time.value = time;
    this._updateMouse();
    if (this.choreography === 'external') {
      this._updateExternal();
    } else {
      this._updateRotation();
      if (this._isMobile) this._updateMobilePosition();
      else this._updatePosition();
    }
    this._updateFBO();
  }

  /**
   * Instantly add `delta` to the ACTUAL u_progress on both sims and the
   * material — used by the atlas-chain driver at the moment of an atlas
   * swap (e.g. -3 when moving A.Q4 -> B.Q1). The blended target is identical
   * on both sides of the swap, so the spring state carries over unchanged.
   */
  rebaseProgress(delta: number) {
    (this._material.customUniforms[14].value as number) =
      (this._material.customUniforms[14].value as number) + delta;
    this._simulationPos.material.uniforms.u_progress.value += delta;
    this._simulationSpring.material.uniforms.u_progress.value += delta;
    this._depthMaterial.customUniforms.u_progress.value =
      this._material.customUniforms[14].value;
    this.targets.progress += delta;
  }

  /** Current ACTUAL (lerped) local u_progress. */
  get progressActual(): number {
    return this._simulationSpring.material.uniforms.u_progress.value as number;
  }

  /** Current ACTUAL (lerped) u_explode. */
  get explodeActual(): number {
    return this._simulationSpring.material.uniforms.u_explode.value as number;
  }

  private _updateExternal() {
    const t = this.targets;
    // rotation (same lerp rate as the rotation update)
    const uRot = this._material.customUniforms[15].value as Vector3;
    uRot.x += (0 - uRot.x) * (0.75 * this._easing);
    uRot.y += (t.rotY - uRot.y) * (0.75 * this._easing);
    uRot.z += (t.rotZ - uRot.z) * (0.75 * this._easing);
    const dRot = this._depthMaterial.customUniforms.u_rotation.value as Vector3;
    dRot.x += (0 - dRot.x) * (0.75 * this._easing);
    dRot.y += (t.rotY - dRot.y) * (0.75 * this._easing);
    dRot.z += (t.rotZ - dRot.z) * (0.75 * this._easing);
    this.rotation.y = this._params.baseRotation.y;

    // factor
    const factorTg = t.factor ?? this._factor;
    const mat = this._material.customUniforms;
    (mat[3].value as number) = (mat[3].value as number) + (factorTg - (mat[3].value as number)) * this._easing;
    const sp = this._simulationPos.material.uniforms;
    const ss = this._simulationSpring.material.uniforms;
    sp.u_factor.value += (factorTg - sp.u_factor.value) * this._easing;
    ss.u_factor.value += (factorTg - ss.u_factor.value) * this._easing;

    // explode + progress + offset (shared lerp helpers)
    this._params.basePosition.x = t.x;
    this._params.basePosition.y = t.y;
    this._lerpSharedUniforms(t.explode, t.progress);
    this._lerpOffset();
  }

  private _updateFBO() {
    const renderer = this._renderer;
    const simSpring = this._simulationSpring;
    const simPos = this._simulationPos;
    if (this._hasRendered) {
      simSpring.material.uniforms.t_oTarget.value = this._fboPos.read.texture;
      renderer.setRenderTarget(this._fboSpring.write);
      renderer.render(simSpring.scene, simSpring.camera);
      this._fboSpring.swap();
      simSpring.material.uniforms.t_oVelocity.value = this._fboSpring.read.texture;
      simSpring.material.uniforms.t_velocity.value = this._fboSpring.write.texture;
      simPos.material.uniforms.t_velocity.value = this._fboSpring.write.texture;
      renderer.setRenderTarget(this._fboPos.write);
      renderer.render(simPos.scene, simPos.camera);
      this._fboPos.swap();
      simPos.material.uniforms.t_oPos.value = this._fboPos.read.texture;
      simPos.material.uniforms.t_pos.value = this._fboPos.write.texture;
      this._material.customUniforms[17].value = this._fboPos.write.texture;
      this._depthMaterial.customUniforms.t_simulation.value = this._fboPos.write.texture;
    } else {
      renderer.setRenderTarget(this._fboPos.write);
      renderer.render(simPos.scene, simPos.camera);
      this._fboPos.swap();
      simPos.material.uniforms.t_oPos.value = this._fboPos.read.texture;
      simPos.material.uniforms.t_pos.value = this._fboPos.write.texture;
      this._material.customUniforms[17].value = this._fboPos.write.texture;
      this._depthMaterial.customUniforms.t_simulation.value = this._fboPos.write.texture;
      renderer.setRenderTarget(this._fboSpring.write);
      renderer.render(simSpring.scene, simSpring.camera);
      this._fboSpring.swap();
      simSpring.material.uniforms.t_oVelocity.value = this._fboSpring.read.texture;
      simSpring.material.uniforms.t_velocity.value = this._fboSpring.write.texture;
      simPos.material.uniforms.u_rendered.value = 1;
      simSpring.material.uniforms.u_rendered.value = 1;
      this._hasRendered = true;
    }
  }

  // --- The built-in scroll choreography, verbatim (sectionProgress-keyed). Phase 4
  // replaces these with our own section driver via the same uniforms. ---

  private _updateRotation() {
    const e = this.sectionProgress;
    const rotY =
      clamp(mapRange(e, 0, 1, 0, 0.5 * -Math.PI), 0.5 * -Math.PI, 0) +
      clamp(mapRange(e, 2.7, 3, 0, 0.5 * Math.PI), 0, 0.5 * Math.PI) +
      clamp(mapRange(e, 3.3, 3.5, 0, 0.25 * Math.PI), 0, 0.25 * Math.PI) -
      clamp(mapRange(e, 4.5, 5, 0, 1.25 * Math.PI), 0, 1.25 * Math.PI) +
      clamp(mapRange(e, 5.7, this.royYEnd, 0, Math.PI), 0, Math.PI);
    const rotZ = clamp(mapRange(e, 2.7, 3, 0, -0.489), -0.489, 0) + clamp(mapRange(e, 3.3, 3.5, 0, 0.6), 0, 0.6);
    const uRot = this._material.customUniforms[15].value as Vector3;
    uRot.x += (0 - uRot.x) * (0.75 * this._easing);
    uRot.y += (rotY - uRot.y) * (0.75 * this._easing);
    uRot.z += (rotZ - uRot.z) * (0.75 * this._easing);
    const dRot = this._depthMaterial.customUniforms.u_rotation.value as Vector3;
    dRot.x += (0 - dRot.x) * (0.75 * this._easing);
    dRot.y += (rotY - dRot.y) * (0.75 * this._easing);
    dRot.z += (rotZ - dRot.z) * (0.75 * this._easing);
    this.rotation.y = this._params.baseRotation.y;
  }

  private _updateMouse() {
    this._mDelta.x += (0 - this._mDelta.x) * this._easing;
    this._mDelta.y += (0 - this._mDelta.y) * this._easing;
    const uMouse = this._material.customUniforms[10].value as Vector2;
    uMouse.x += (this._mTg.x - uMouse.x) * (0.75 * this._easing);
    uMouse.y += (this._mTg.y - uMouse.y) * (0.75 * this._easing);
    const dMouse = this._depthMaterial.customUniforms.u_mouse.value as Vector2;
    dMouse.x += (this._mTg.x - dMouse.x) * (0.75 * this._easing);
    dMouse.y += (this._mTg.y - dMouse.y) * (0.75 * this._easing);
    const uDelta = this._material.customUniforms[21].value as Vector2;
    uDelta.x += (this._mDelta.x - uDelta.x) * (0.75 * this._easing);
    uDelta.y += (this._mDelta.y - uDelta.y) * (0.75 * this._easing);
    const dDelta = this._depthMaterial.customUniforms.u_delta.value as Vector2;
    dDelta.x += (this._mDelta.x - dDelta.x) * (0.75 * this._easing);
    dDelta.y += (this._mDelta.y - dDelta.y) * (0.75 * this._easing);
  }

  private _lerpSharedUniforms(explodeTg: number, progressTg: number) {
    const mat = this._material.customUniforms;
    (mat[13].value as number) = (mat[13].value as number) + (explodeTg - (mat[13].value as number)) * this._easing;
    const sp = this._simulationPos.material.uniforms;
    const ss = this._simulationSpring.material.uniforms;
    sp.u_explode.value += (explodeTg - sp.u_explode.value) * this._easing;
    ss.u_explode.value += (explodeTg - ss.u_explode.value) * this._easing;
    (mat[14].value as number) = (mat[14].value as number) + (progressTg - (mat[14].value as number)) * this._easing;
    sp.u_progress.value += (progressTg - sp.u_progress.value) * this._easing;
    ss.u_progress.value += (progressTg - ss.u_progress.value) * this._easing;
    // Fix over the verbatim port: the original never fed u_progress (or u_explode) to
    // the DEPTH material, so during morphs the bokeh depth pass rendered
    // stale per-particle scales — blur landing offset from the beauty render.
    this._depthMaterial.customUniforms.u_progress.value = mat[14].value;
    this._depthMaterial.customUniforms.u_explode.value = mat[13].value;
  }

  private _lerpOffset() {
    const mat = this._material.customUniforms;
    const uOffset = mat[12].value as Vector3;
    uOffset.x += (this._params.basePosition.x - uOffset.x) * this._easing;
    uOffset.y += (this._params.basePosition.y - uOffset.y) * this._easing;
    const dOffset = this._depthMaterial.customUniforms.u_offset.value as Vector3;
    dOffset.x += (this._params.basePosition.x - dOffset.x) * this._easing;
    dOffset.y += (this._params.basePosition.y - dOffset.y) * this._easing;
  }

  private _updatePosition() {
    const e = this.sectionProgress;
    const x =
      clamp(mapRange(e, 0, 1, 3, -4.5), -4.5, 3) +
      clamp(mapRange(e, 1.25, 1.5, 0.905, 5), 0.905, 5) -
      clamp(mapRange(e, 2.8, 3, 0.905, 3), 0.905, 3) +
      clamp(mapRange(e, 3.3, 3.5, 0.905, 6), 0.905, 6) -
      clamp(mapRange(e, 4.5, 5, 0.905, 5), 0.905, 4);
    this._params.basePosition.x = x + 0 * (this._material.customUniforms[10].value as Vector2).x;
    const y =
      clamp(mapRange(e, 2.7, 3, 0, 0.5), 0, 0.5) -
      clamp(mapRange(e, 3.3, 3.5, 0, 0.5), 0, 0.5) +
      clamp(mapRange(e, 5.7, 6, 0, 1.75), 0, 1.75);
    this._params.basePosition.y = y + 0 * (this._material.customUniforms[10].value as Vector2).y;

    const explodeTg =
      clamp(mapRange(e, 1.1, 2.2, 0, 1), 0, 1) -
      clamp(mapRange(e, 2.8, 3, 0, 1), 0, 1) +
      clamp(mapRange(e, 4.5, 5, 0, 1), 0, 1) -
      clamp(mapRange(e, 5.7, 6, 0, 1), 0, 1);

    const factorTg =
      this._factor +
      clamp(mapRange(e, 0, 1, 0, 1), 0, 1) -
      clamp(mapRange(e, 1.25, 1.5, 0, 1), 0, 1) +
      clamp(mapRange(e, 3.3, 3.5, 0, 0.3), 0, 0.3) -
      clamp(mapRange(e, 5.7, 6, 0, 1), 0, 1);
    const mat = this._material.customUniforms;
    (mat[3].value as number) = (mat[3].value as number) + (factorTg - (mat[3].value as number)) * this._easing;
    const sp = this._simulationPos.material.uniforms;
    const ss = this._simulationSpring.material.uniforms;
    sp.u_factor.value += (factorTg - sp.u_factor.value) * this._easing;
    // (verbatim quirk: spring factor eases toward simulationPos's current value)
    ss.u_factor.value += (factorTg - sp.u_factor.value) * this._easing;

    const progressTg =
      clamp(mapRange(e, 2.7, 3, 0, 1), 0, 1) +
      clamp(mapRange(e, 3.3, 3.5, 0, 1), 0, 1) +
      clamp(mapRange(e, 5.7, 6, 0, 1), 0, 1);
    this._lerpSharedUniforms(explodeTg, progressTg);

    const progress2Tg =
      clamp(mapRange(e, 0, 1, 0, 1), 0, 1) -
      clamp(mapRange(e, 2.7, 3, 0, 1), 0, 1) +
      clamp(mapRange(e, 3, 3.5, 0, 1), 0, 1) -
      clamp(mapRange(e, 5.5, 5.5, 0, 1), 0, 1);
    (mat[20].value as number) =
      (mat[20].value as number) + (progress2Tg - (mat[20].value as number)) * this._easing;
    this._depthMaterial.customUniforms.u_progress2.value =
      (this._depthMaterial.customUniforms.u_progress2.value as number) +
      (progress2Tg - (this._depthMaterial.customUniforms.u_progress2.value as number)) * this._easing;
    this._lerpOffset();
  }

  private _updateMobilePosition() {
    const e = this.sectionProgress;
    const x = clamp(mapRange(e, 0, 1, 1.5, 0), 0, 1.5);
    this._params.basePosition.x = x + 0.052 * (this._material.customUniforms[10].value as Vector2).x;
    this._params.basePosition.y = 2 + 0 * (this._material.customUniforms[10].value as Vector2).y;
    const explodeTg =
      clamp(mapRange(e, 1.4, 1.7, 0, 1), 0, 1) -
      clamp(mapRange(e, 2.7, 3, 0, 1), 0, 1) +
      clamp(mapRange(e, 4.5, 5, 0, 1), 0, 1) -
      clamp(mapRange(e, 5.7, 5.8, 0, 1), 0, 1);
    const progressTg =
      clamp(mapRange(e, 2.7, 3, 0, 1), 0, 1) +
      clamp(mapRange(e, 3.3, 3.5, 0, 1), 0, 1) +
      clamp(mapRange(e, 5.7, 5.8, 0, 1), 0, 1);
    this._lerpSharedUniforms(explodeTg, progressTg);
    this._lerpOffset();
  }
}

export type { Object3D };

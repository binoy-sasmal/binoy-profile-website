// The WebGL manager: renderer (DPR 1 desktop /
// 2 mobile), fov-50 particle camera at z=10, asset loading (EXR/GLB/PNG), the
// 200x200 8-bit position RT (rendered once for CPU order readback), post
// composer, grain layer, RAF loop, mouse -> camera sway + cloud hover.
// Dropped vs the original: the secondary 250-pyramid front group (`Ht`), the
// DOM-aligned scene2, and the fluid sim.
import {
  Group,
  NearestFilter,
  PerspectiveCamera,
  Scene,
  Texture,
  UnsignedByteType,
  ClampToEdgeWrapping,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { TextureLoader, type BufferGeometry } from 'three';
import { ParticleCloud } from './ParticleCloud';
import { GrainLayer } from './GrainLayer';
import { FrontCones } from './FrontCones';
import { PostComposer } from './post';
import { TrianglePass } from './core';

export interface EngineUrls {
  positionExr: string;
  colorPng: string;
  scalePng: string;
  modelGlb: string;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  urls: EngineUrls;
  isMobile?: boolean;
  /** Grain layer + shroud. Disable for the spec-pure site. */
  grain?: boolean;
  /** Post chain: true/false for all, or per-pass flags.
   *  `focalDepth` moves the bokeh focus plane (see post.ts; default 0.116
   *  = settled-cloud plane exactly in focus, sweep-verified). */
  post?: boolean | { bloom?: boolean; bokeh?: boolean; vignette?: boolean; focalDepth?: number };
  /** Renderer clear colour (site: 0x06090B — the void token). */
  clearColor?: number;
  /** Foreground parallax pyramids (the front-cones layer). */
  foreground?: boolean;
}

// EXR orientation note (verified empirically during the parity gate):
// r135's EXRLoader stores scanlines bottom-up (data row 0 = image bottom),
// and Chrome WebGL2 + three r135 HONOR flipY=true even for data-texture
// uploads — the two flips compose so that texture v<0.5 samples the image's
// TOP half. Net convention (identical to the clone): quadrant Q1 = image
// top-left = the at-rest shape. Do NOT flip EXR rows on the CPU here; that
// double-flips and swaps the quadrant pairs.

export class ParticleEngine {
  readonly renderer: WebGLRenderer;
  readonly particleCamera: PerspectiveCamera;
  readonly particleScene: Scene;
  readonly cloud: ParticleCloud;
  readonly grainLayer: GrainLayer | null;
  readonly frontCones: FrontCones | null;
  private _composer: PostComposer | null = null;
  private _post: boolean;
  private _m = { x: 0, y: 0 };
  private _raf = 0;
  private _running = false;
  private _loaded = false;
  private _onLoaded: (() => void)[] = [];

  /** Called every frame before the cloud updates (scroll driver hook). */
  onBeforeRender: ((time: number) => void) | null = null;

  constructor({ canvas, urls, isMobile = false, grain = true, post = true, clearColor, foreground = false }: EngineOptions) {
    this._post = post !== false;
    this.renderer = new WebGLRenderer({
      alpha: false,
      antialias: false,
      canvas,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(isMobile ? 2 : 1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (clearColor !== undefined) this.renderer.setClearColor(clearColor);

    this.particleCamera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 30);
    this.particleCamera.position.set(0, 0, 10);
    this.particleCamera.setFocalLength(35);
    this.particleCamera.updateProjectionMatrix();
    this.particleScene = new Scene();

    if (grain) {
      this.grainLayer = new GrainLayer({ dpr: this.renderer.getPixelRatio() });
      this.grainLayer.position.set(0, 0, 9.6);
      this.particleScene.add(this.grainLayer);
    } else {
      this.grainLayer = null;
    }

    this.cloud = new ParticleCloud({ isMobile });
    this.particleScene.add(this.cloud);

    if (foreground) {
      this.frontCones = new FrontCones({ isMobile });
      this.frontCones.position.set(0, 0, 0.1);
      this.particleScene.add(this.frontCones);
    } else {
      this.frontCones = null;
    }

    if (post !== false) {
      const passes = typeof post === 'object' ? post : {};
      this._composer = new PostComposer({
        scene: this.particleScene,
        camera: this.particleCamera,
        renderer: this.renderer,
        isDesktop: !isMobile,
        ...passes,
      });
    }

    this._loadAssets(urls);
    this._addEvents();
  }

  /** External scroll progress, 0..6 — forwarded to the cloud every frame. */
  set sectionProgress(v: number) {
    this.cloud.sectionProgress = v;
  }
  get sectionProgress() {
    return this.cloud.sectionProgress;
  }

  onLoaded(cb: () => void) {
    if (this._loaded) cb();
    else this._onLoaded.push(cb);
  }

  /** Site entry: drop the shroud and gather the cloud. */
  enter() {
    this.grainLayer?.hide({ delay: 0 });
    this.cloud.activate({ delay: 0 });
  }

  private async _loadAssets(urls: EngineUrls) {
    const exrLoader = new EXRLoader();
    const textureLoader = new TextureLoader();
    const gltfLoader = new GLTFLoader();

    const [positionTexture, colorTexture, scaleTexture, gltf] = await Promise.all([
      exrLoader.loadAsync(urls.positionExr),
      textureLoader.loadAsync(urls.colorPng),
      textureLoader.loadAsync(urls.scalePng),
      gltfLoader.loadAsync(urls.modelGlb),
    ]);
    this.renderer.initTexture(positionTexture);
    this.renderer.initTexture(colorTexture);
    this.renderer.initTexture(scaleTexture);

    let geometry: BufferGeometry | null = null;
    gltf.scene.traverse((obj) => {
      if (obj.type === 'Mesh') geometry = (obj as import('three').Mesh).geometry.clone();
    });
    if (!geometry) throw new Error('no mesh found in ' + urls.modelGlb);

    // Verbatim boot step: render the EXR once into a 200x200 8-bit RT; the
    // cloud reads it back to build its per-quadrant stagger orders.
    positionTexture.minFilter = positionTexture.magFilter = NearestFilter;
    positionTexture.flipY = true;
    positionTexture.needsUpdate = true;
    const positionRT = new WebGLRenderTarget(200, 200, {
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      type: UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const bigTriangle = new TrianglePass({ texture: positionTexture });
    this.renderer.setRenderTarget(positionRT);
    this.renderer.render(bigTriangle.scene, bigTriangle.camera);
    this.renderer.setRenderTarget(null);

    this.cloud.onAssetsLoaded({
      renderer: this.renderer,
      positionRT,
      positionTexture,
      scaleTexture,
      colorTexture,
      geometry,
    });
    this.frontCones?.onAssetsLoaded(geometry);
    this.resize();
    this._loaded = true;
    this._onLoaded.forEach((cb) => cb());
    this._onLoaded = [];
  }

  private _addEvents() {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('pointerdown', (e) => {
      this._m.x = 2 * (e.clientX / window.innerWidth - 0.5);
      this._m.y = -2 * (e.clientY / window.innerHeight - 0.5);
      this.cloud.onMousedown(this._m);
    });
    window.addEventListener('pointermove', (e) => {
      this._m.x = 2 * (e.clientX / window.innerWidth - 0.5);
      this._m.y = -2 * (e.clientY / window.innerHeight - 0.5);
      this.cloud.onMousemove(this._m);
      this.frontCones?.onMousemove(this._m);
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.particleCamera.fov = 50;
    this.particleCamera.aspect = w / h;
    this.particleCamera.updateProjectionMatrix();
    this.cloud.resize({ camera: this.particleCamera });
    this.frontCones?.resize({ camera: this.particleCamera });
    this._composer?.resize(w, h);
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = (now: number) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this.update(now / 1000);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
  }

  update(time: number) {
    this.onBeforeRender?.(time);
    this._updateCamera();
    this.grainLayer?.update(time);
    this.frontCones?.update(time);
    this.cloud.update(time);
    if (this._post && this._composer) {
      this.renderer.setRenderTarget(null);
      this._composer.update();
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.particleScene, this.particleCamera);
    }
  }

  private _updateCamera() {
    const ry = -0.075 * this._m.x;
    const rx = 0.05 * this._m.y;
    this.particleCamera.rotation.y += 0.1 * (ry - this.particleCamera.rotation.y);
    this.particleCamera.rotation.x += 0.1 * (rx - this.particleCamera.rotation.x);
  }
}

export type { Group, Texture };

// Post pipeline: a custom BokehPass (a modified three-examples bokeh that
// renders the scene's customDepthMaterial into its own depth RT), then the
// composer stack:
// RenderPass -> UnrealBloom(.4/.159/1) -> Bokeh (desktop) -> Vignette(.3/4).
import {
  Color,
  LinearFilter,
  MeshDepthMaterial,
  Mesh,
  NoBlending,
  type PerspectiveCamera,
  RGBADepthPacking,
  type Scene,
  ShaderMaterial,
  UniformsUtils,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass';
import { BOKEH_FRAGMENT, BOKEH_VERTEX } from './shaders';

const BokehShader = {
  defines: { RINGS: 4, SAMPLES: 6 },
  uniforms: {
    textureWidth: { value: 1 },
    textureHeight: { value: 1 },
    focalDepth: { value: 1.2 },
    focalLength: { value: 35 },
    fstop: { value: 0.9 },
    tColor: { value: null },
    tDepth: { value: null },
    maxblur: { value: 1 },
    showFocus: { value: 0 },
    manualdof: { value: 0 },
    vignetting: { value: 0 },
    depthblur: { value: 0 },
    threshold: { value: 0.5 },
    gain: { value: 2 },
    bias: { value: 0.5 },
    fringe: { value: 0.7 },
    znear: { value: 0.1 },
    zfar: { value: 100 },
    noise: { value: 1 },
    dithering: { value: 1e-4 },
    pentagon: { value: 0 },
    shaderFocus: { value: 0 },
    focusCoords: { value: new Vector2() },
  },
  vertexShader: BOKEH_VERTEX,
  fragmentShader: BOKEH_FRAGMENT,
};

export class CloudBokehPass extends Pass {
  scene: Scene;
  camera: PerspectiveCamera;
  renderTargetDepth: WebGLRenderTarget;
  materialDepth: MeshDepthMaterial;
  materialBokeh: ShaderMaterial;
  uniforms: typeof BokehShader.uniforms;
  fsQuad: FullScreenQuad;
  private _oldClearColor = new Color();

  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    {
      focalDepth = 1,
      focalLength = 35,
      fstop = 0.9,
      maxblur = 1,
      gain = 2,
      bias = 0.5,
      znear = 0.1,
      zfar = 100,
      width = window.innerWidth,
      height = window.innerHeight,
    } = {}
  ) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.renderTargetDepth = new WebGLRenderTarget(width, height, {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    this.renderTargetDepth.texture.name = 'BokehPass.depth';
    this.materialDepth = new MeshDepthMaterial();
    this.materialDepth.depthPacking = RGBADepthPacking;
    this.materialDepth.blending = NoBlending;

    const uniforms = UniformsUtils.clone(BokehShader.uniforms) as typeof BokehShader.uniforms;
    uniforms.tDepth.value = this.renderTargetDepth.texture as never;
    uniforms.textureWidth.value = width;
    uniforms.textureHeight.value = height;
    uniforms.focalDepth.value = focalDepth;
    uniforms.focalLength.value = focalLength;
    uniforms.fstop.value = fstop;
    uniforms.maxblur.value = maxblur;
    uniforms.gain.value = gain;
    uniforms.bias.value = bias;
    uniforms.znear.value = znear;
    uniforms.zfar.value = zfar;
    this.materialBokeh = new ShaderMaterial({
      defines: Object.assign({}, BokehShader.defines),
      uniforms: uniforms as never,
      vertexShader: BokehShader.vertexShader,
      fragmentShader: BokehShader.fragmentShader,
    });
    this.uniforms = uniforms;
    this.needsSwap = true;
    this.fsQuad = new FullScreenQuad(this.materialBokeh);
  }

  setSize(width: number, height: number) {
    this.uniforms.textureWidth.value = width;
    this.uniforms.textureHeight.value = height;
    // Fix over the verbatim port: the original never resized the depth RT, so depth
    // and colour drifted out of alignment after a window resize.
    this.renderTargetDepth.setSize(width, height);
  }

  render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget) {
    // Swap every mesh to its customDepthMaterial (or packed depth) and render depth.
    this.scene.traverse((obj) => {
      const mesh = obj as Mesh & { _material?: Mesh['material'] };
      if (mesh.type === 'Mesh') {
        if (mesh.customDepthMaterial !== undefined) {
          mesh._material = mesh.material;
          mesh.material = mesh.customDepthMaterial;
        } else {
          mesh._material = mesh.material;
          mesh.material = this.materialDepth;
        }
      }
    });
    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0);
    renderer.setClearAlpha(1);
    renderer.setRenderTarget(this.renderTargetDepth);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    this.uniforms.tColor.value = readBuffer.texture as never;
    this.uniforms.znear.value = this.camera.near;
    this.uniforms.zfar.value = this.camera.far;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      renderer.clear();
      this.fsQuad.render(renderer);
    }

    this.scene.traverse((obj) => {
      const mesh = obj as Mesh & { _material?: Mesh['material'] };
      if (mesh.type === 'Mesh' && mesh._material) {
        mesh.material = mesh._material;
        mesh._material = undefined;
      }
    });
    renderer.setClearColor(this._oldClearColor);
    renderer.setClearAlpha(oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
}

export class PostComposer {
  private _composer: EffectComposer;
  readonly bloomPass: UnrealBloomPass;
  readonly bokehPass: CloudBokehPass | null;
  readonly vignettePass: ShaderPass;

  constructor({
    scene,
    camera,
    renderer,
    isDesktop = true,
    bloom = true,
    bokeh = true,
    vignette = true,
    /** Focus plane, in the bokeh shader's LINEARIZED depth space (the shader
     *  zeroes blur where linearize(tDepth) == focalDepth). The cloud's depth
     *  material writes 1 - smoothstep(0.1, 13, viewZ); settled shapes sit at
     *  viewZ = 10 → raw 0.1371 → linearize(0.1371) = 0.1158. Verified by a
     *  focal sweep (spike/shots/fd-*.png): 0.116 sharpest, 0.35 fog.
     *  The reference shipped 0.125 (slightly behind-plane). Tuning knob. */
    focalDepth = 0.116,
    /** Max blur kernel. The reference shipped 10, which lets near-camera particles
     *  smear into large white ghosts over in-focus shapes (our chalk palette
     *  glares more than their dim violet); 5 keeps the DoF but caps the
     *  smear. tuning knob. */
    maxblur = 5,
    width = window.innerWidth,
    height = window.innerHeight,
  }: {
    scene: Scene;
    camera: PerspectiveCamera;
    renderer: WebGLRenderer;
    isDesktop?: boolean;
    bloom?: boolean;
    bokeh?: boolean;
    vignette?: boolean;
    focalDepth?: number;
    maxblur?: number;
    width?: number;
    height?: number;
  }) {
    const renderScene = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(new Vector2(width, height), 1.5, 0.4, 0.85);
    this.bloomPass.threshold = 0.159;
    this.bloomPass.strength = 0.4;
    this.bloomPass.radius = 1;
    this.bokehPass = bokeh && isDesktop
      ? new CloudBokehPass(scene, camera, {
          focalDepth,
          focalLength: 27,
          fstop: 2509,
          maxblur,
          gain: 0,
          bias: 0,
          znear: camera.near,
          zfar: camera.far,
          width,
          height,
        })
      : null;
    this.vignettePass = new ShaderPass(VignetteShader);
    this.vignettePass.uniforms.offset.value = 0.3;
    this.vignettePass.uniforms.darkness.value = 4;
    renderer.toneMappingExposure = Math.pow(1, 5);
    this._composer = new EffectComposer(renderer);
    this._composer.addPass(renderScene);
    if (bloom) this._composer.addPass(this.bloomPass);
    if (this.bokehPass) this._composer.addPass(this.bokehPass);
    if (vignette) this._composer.addPass(this.vignettePass);
  }

  resize(width: number, height: number) {
    this._composer.setSize(width, height);
  }

  update() {
    this._composer.render();
  }
}

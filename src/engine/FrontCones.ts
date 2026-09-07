// Foreground parallax layer: 250 large, slow
// pyramids drifting IN FRONT of the content plane with per-instance mouse
// parallax and spin. Creates the depth sandwich (foreground / content /
// cloud / void). Colours re-pitched to OUR palette.
import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Group,
  type PerspectiveCamera,
  Quaternion,
  type Shader,
  Vector2,
  Vector3,
  type BufferGeometry,
} from 'three';
import { CloudDepthMaterial, PatchedBasicMaterial, fitViewSize } from './core';
import { CHUNK_MAP, CHUNK_ROTATION_LOOKAT, FRONT_OUTPUT_FRAGMENT, FRONT_PROJECT_VERTEX, CLOUD_WORLDPOS_VERTEX } from './shaders';

// Our palette, standing in for the original violet/gold/teal/lilac set.
// Filament (gold) removed 2026-09-05 with the same colour in the cloud's bake
// palette (targets.yaml): the warm specks read as dirt against the chalk+teal
// field, and leaving gold here while the cluster lost it would have looked
// inconsistent — this layer drifts in front of the cloud. Chalk takes its slot.
const COLORS = [
  { r: 93, g: 202, b: 165 }, // teal glow
  { r: 241, g: 239, b: 232 }, // chalk (was filament #D9A441)
  { r: 29, g: 158, b: 117 }, // teal core
  { r: 169, g: 174, b: 169 }, // ash
];

/** Global opacity damp: our palette is much brighter than the original's dim violet,
 *  so at full alpha the near-camera cones bloom+blur into glaring ghosts.
 *  tuning knob. */
const OPACITY = 0.55;

export class FrontCones extends Group {
  private _nb = 250;
  private _easing = 0.1;
  private _loaded = false;
  private _mouseTg = { x: 0, y: 0 };
  private _material!: PatchedBasicMaterial;
  private _depthMaterial!: CloudDepthMaterial;
  private _mesh!: InstancedMesh;
  private _isMobile: boolean;

  constructor({ isMobile = false } = {}) {
    super();
    this._isMobile = isMobile;
  }

  onAssetsLoaded(geometry: BufferGeometry) {
    const geo = geometry.clone();
    this._material = new PatchedBasicMaterial({
      color: new Color('white'),
      vertexColors: true,
      transparent: true,
      customUniforms: [
        { id: 'u_time', type: 'float', value: 0 }, // 0
        { id: 'u_scale', type: 'float', value: 1 }, // 1
        { id: 'u_resolution', type: 'vec2', value: new Vector2() }, // 2
        { id: 'u_mouse', type: 'vec2', value: new Vector2() }, // 3
      ],
      onBeforeCompile: function (this: PatchedBasicMaterial, shader: Shader) {
        for (let t = 0; t < this.customUniforms.length; t++) {
          const u = this.customUniforms[t];
          (shader.uniforms as Record<string, unknown>)[u.id] = u;
          shader.vertexShader = `uniform ${u.type} ${u.id};\n` + shader.vertexShader;
          shader.fragmentShader = `uniform ${u.type} ${u.id};\n` + shader.fragmentShader;
        }
        shader.vertexShader = CHUNK_ROTATION_LOOKAT + shader.vertexShader;
        shader.vertexShader = CHUNK_MAP + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_param;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_angle;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_color;\n' + shader.vertexShader;
        shader.vertexShader = 'varying vec4 v_color;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', FRONT_PROJECT_VERTEX);
        shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', CLOUD_WORLDPOS_VERTEX);
        shader.fragmentShader = 'varying vec4 v_color;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', FRONT_OUTPUT_FRAGMENT);
      },
    });

    this._mesh = new InstancedMesh(geo, this._material, this._nb);
    const mat4 = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    const aColor = new Float32Array(4 * this._nb);
    const aAngle = new Float32Array(4 * this._nb);
    const aParam = new Float32Array(4 * this._nb);
    for (let i = 0; i < this._nb; i++) {
      const x = 2 * Math.random() - 1;
      const y = 2 * Math.random() - 1;
      const z = 9 * Math.random();
      const s = this._isMobile ? 0.075 : 0.05;
      pos.set(x, y, z);
      scl.set(s, s, s);
      mat4.compose(pos, quat, scl);
      this._mesh.setMatrixAt(i, mat4);
      mat4.identity();
      const c = COLORS[i % 4];
      aColor[4 * i] = c.r / 255;
      aColor[4 * i + 1] = c.g / 255;
      aColor[4 * i + 2] = c.b / 255;
      aColor[4 * i + 3] = Math.random() * OPACITY;
      aAngle[4 * i] = 2 * Math.random() - 1;
      aAngle[4 * i + 1] = 2 * Math.random() - 1;
      aAngle[4 * i + 2] = 2 * Math.random() - 1;
      aAngle[4 * i + 3] = 2 * Math.random() - 1 * Math.PI;
      aParam[4 * i] = Math.random();
      aParam[4 * i + 1] = Math.random();
      aParam[4 * i + 2] = Math.random();
      aParam[4 * i + 3] = Math.random();
    }
    geo.setAttribute('a_param', new InstancedBufferAttribute(aParam, 4));
    geo.setAttribute('a_color', new InstancedBufferAttribute(aColor, 4));
    geo.setAttribute('a_angle', new InstancedBufferAttribute(aAngle, 4));

    this._depthMaterial = new CloudDepthMaterial({
      transparent: true,
      customUniforms: {
        u_time: { type: 'float', value: 0 },
        u_scale: { type: 'float', value: 1 },
        u_resolution: { type: 'vec2', value: new Vector2() },
        u_mouse: { type: 'vec2', value: new Vector2() },
      },
      onBeforeCompile: (shader: Shader) => {
        shader.vertexShader = CHUNK_ROTATION_LOOKAT + shader.vertexShader;
        shader.vertexShader = CHUNK_MAP + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_param;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_angle;\n' + shader.vertexShader;
        shader.vertexShader = 'attribute vec4 a_color;\n' + shader.vertexShader;
        shader.vertexShader = 'varying vec4 v_color;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', FRONT_PROJECT_VERTEX);
      },
    });
    this._mesh.customDepthMaterial = this._depthMaterial;
    this.add(this._mesh);
    this._loaded = true;
  }

  onMousemove(m: { x: number; y: number }) {
    this._mouseTg.x = m.x;
    this._mouseTg.y = m.y;
  }

  resize({ camera }: { camera: PerspectiveCamera }) {
    if (!this._loaded) return;
    const size = fitViewSize(camera, 9.9);
    (this._material.customUniforms[2].value as Vector2).set(size.width, size.height);
    (this._depthMaterial.customUniforms.u_resolution.value as Vector2).set(size.width, size.height);
  }

  update(time: number) {
    if (!this._loaded) return;
    this._material.customUniforms[0].value = time;
    this._depthMaterial.customUniforms.u_time.value = time;
    const uMouse = this._material.customUniforms[3].value as Vector2;
    uMouse.x += (0.25 * this._mouseTg.x - uMouse.x) * this._easing;
    uMouse.y += (0.25 * this._mouseTg.y - uMouse.y) * this._easing;
    const dMouse = this._depthMaterial.customUniforms.u_mouse.value as Vector2;
    dMouse.x += (0.25 * this._mouseTg.x - dMouse.x) * this._easing;
    dMouse.y += (0.25 * this._mouseTg.y - dMouse.y) * this._easing;
  }
}

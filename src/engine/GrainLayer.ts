// Fullscreen grain layer + load shroud.
// u_show=0 covers the view in black (except the centre); hide() tweens it to
// 1, revealing the scene with a procedural grain overlay. the design spec forbids
// grain on the final site — this exists for clone parity and can be disabled
// (`enabled: false` leaves the layer out entirely).
import gsap from 'gsap';
import { Group, MeshBasicMaterial, RawShaderMaterial } from 'three';
import { TrianglePass } from './core';
import { GRAIN_FRAGMENT, GRAIN_VERTEX } from './shaders';

export class GrainLayer extends Group {
  objectVisible = true;
  private _pass: TrianglePass;

  constructor({ dpr = 1 } = {}) {
    super();
    this._pass = new TrianglePass({
      material: new RawShaderMaterial({
        uniforms: {
          t_noise: { value: null },
          u_show: { value: 0 },
          u_alpha: { value: dpr >= 2 ? 0.138 : 0.149 },
          u_bright: { value: dpr >= 2 ? 0.185 : 0.252 },
          u_scale: { value: dpr >= 2 ? 1.072 : 1.366 },
          u_time: { value: 0 },
        },
        transparent: true,
        vertexShader: GRAIN_VERTEX,
        fragmentShader: GRAIN_FRAGMENT,
      }),
    });
    // The pass owns a private scene; re-parent its mesh under this group.
    const mesh = this._pass.scene.children[0];
    (mesh as import('three').Mesh).customDepthMaterial = new MeshBasicMaterial({
      opacity: 0,
      transparent: true,
    }) as never;
    this.add(mesh);
  }

  get material() {
    return this._pass.material;
  }

  show({ delay = 0 } = {}) {
    if (this.objectVisible) return;
    gsap.killTweensOf(this._pass.material.uniforms.u_show);
    gsap.to(this._pass.material.uniforms.u_show, {
      duration: 2,
      value: 0,
      ease: 'power2.inOut',
      delay,
      onComplete: () => {
        this.objectVisible = true;
        this.visible = true;
      },
    });
  }

  hide({ delay = 0, instant = false } = {}) {
    if (!this.objectVisible) return;
    if (instant) {
      this._pass.material.uniforms.u_show.value = 1;
      this.objectVisible = false;
      return;
    }
    gsap.killTweensOf(this._pass.material.uniforms.u_show);
    gsap.to(this._pass.material.uniforms.u_show, {
      duration: 2,
      value: 1,
      ease: 'power2.inOut',
      delay,
      onComplete: () => {
        this.objectVisible = false;
      },
    });
  }

  update(time: number) {
    this._pass.material.uniforms.u_time.value = time;
  }
}

// Hero cursor-reveal lens: the real photograph sits under a
// soft radial mask that follows the pointer with weight; where attention
// lands, the model becomes legible. A separate DOM layer — decoupled from
// the WebGL loop except for reading the camera/uniforms to keep the photo
// registered with the particle face.
//
// Registration: the face atlas maps its matte square 1:1 onto the [0,1] box
// (bake frame mode "full"), which renders at sim coords (p*2-1)*u_factor,
// offset by u_offset and the cloud's y (-1.19). Projecting that square's
// corners through the particle camera gives the photo's exact screen rect.
import { Vector3 } from 'three';
import type { ParticleEngine } from '../engine/Engine';

const CLOUD_Y = -1.19;

export interface LensOptions {
  engine: ParticleEngine;
  photo: HTMLImageElement;
  toggle: HTMLButtonElement | null;
  hero: HTMLElement;
  reducedMotion: boolean;
}

export class HeroLens {
  private _engine: ParticleEngine;
  private _photo: HTMLImageElement;
  private _hero: HTMLElement;
  private _lens = { x: -9999, y: -9999 };
  private _target = { x: -9999, y: -9999 };
  private _inside = false;
  private _raf = 0;
  private _corner = new Vector3();
  private _finePointer: boolean;
  private _pinned = false; // Show-photo toggle / tap-to-reveal state
  private _sweepT = 0;
  private _radius = 180;

  constructor({ engine, photo, toggle, hero, reducedMotion }: LensOptions) {
    this._engine = engine;
    this._photo = photo;
    this._hero = hero;
    this._finePointer = window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 768;

    photo.hidden = false;
    photo.style.opacity = '0';
    photo.decoding = 'async';

    if (reducedMotion) {
      // Keyboard/reduced-motion path: a visible control, no hover required.
      if (toggle) {
        toggle.hidden = false;
        toggle.addEventListener('click', () => {
          this._pinned = !this._pinned;
          toggle.textContent = this._pinned ? 'Hide photo' : 'Show photo';
        });
      }
    } else if (this._finePointer) {
      hero.addEventListener('pointermove', (e) => {
        this._target.x = e.clientX;
        this._target.y = e.clientY;
        this._inside = true;
      });
      hero.addEventListener('pointerleave', () => {
        this._inside = false;
      });
    } else {
      // Touch: tap-to-reveal — the whole photo fades in for ~1.5s.
      hero.addEventListener('pointerdown', () => {
        this._pinned = true;
        window.setTimeout(() => (this._pinned = false), 1500);
      });
    }

    this._measureRadius();
    window.addEventListener('resize', () => this._measureRadius());

    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this._update();
    };
    this._raf = requestAnimationFrame(loop);
  }

  private _measureRadius() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--lens-radius');
    const probe = document.createElement('div');
    probe.style.width = v;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    this._radius = probe.getBoundingClientRect().width || 180;
    probe.remove();
  }

  /** Project sim-box corner (bx,by ∈ {0,1}) to viewport pixels. */
  private _projectCorner(bx: number, by: number) {
    const cloud = this._engine.cloud;
    const factor = cloud.material.customUniforms[3].value as number;
    const offset = cloud.material.customUniforms[12].value as { x: number; y: number };
    this._corner.set(
      (bx * 2 - 1) * factor + offset.x,
      (by * 2 - 1) * factor + offset.y + CLOUD_Y,
      0
    );
    this._corner.project(this._engine.particleCamera);
    return {
      x: (this._corner.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this._corner.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  private _update() {
    const cloud = this._engine.cloud;
    if (!cloud.loaded || !this._photo.complete) return;

    // Keep the photo glued to the particle face's projected rect.
    const bl = this._projectCorner(0, 0);
    const tr = this._projectCorner(1, 1);
    const left = Math.min(bl.x, tr.x);
    const top = Math.min(bl.y, tr.y);
    const w = Math.abs(tr.x - bl.x);
    const h = Math.abs(tr.y - bl.y);
    const st = this._photo.style;
    st.left = `${left}px`;
    st.top = `${top}px`;
    st.width = `${w}px`;
    st.height = `${h}px`;

    // The photo may only reveal while the face is SETTLED: targets at the
    // face (not merely nearest to it) AND actuals arrived (so scrolling back
    // up doesn't expose the photo before the particles have re-formed) AND
    // no explosion in flight in either direction.
    const heroVisible = this._hero.getBoundingClientRect().bottom > 80;
    const faceActive =
      cloud.targets.progress < 0.1 &&
      cloud.targets.explode < 0.05 &&
      cloud.progressActual < 0.15 &&
      cloud.explodeActual < 0.1;

    if (this._pinned && heroVisible && faceActive) {
      st.transition = 'opacity 320ms ease';
      st.opacity = '1';
      st.webkitMaskImage = st.maskImage = 'none';
      return;
    }

    if (!this._finePointer && !this._pinned) {
      // Ambient sweep for no-pointer devices: a slow lens drifting across the
      // face (~6s period), so the reveal never requires hover.
      this._sweepT += 1 / 60;
      const t = (Math.sin((this._sweepT / 6) * Math.PI * 2) + 1) / 2;
      this._target.x = left + w * (0.3 + 0.4 * t);
      this._target.y = top + h * 0.3;
      this._inside = heroVisible;
    }

    // Lerp the lens toward the pointer (weighty follow; 0.10–0.12 reads best).
    this._lens.x += (this._target.x - this._lens.x) * 0.11;
    this._lens.y += (this._target.y - this._lens.y) * 0.11;

    const show = this._inside && heroVisible && faceActive;
    st.transition = show ? 'opacity 180ms ease' : 'opacity 320ms ease';
    st.opacity = show ? '1' : '0';

    // Soft radial mask: hard core ~55%, feathered to 0 (no crisp circle).
    const r = this._radius;
    const mx = this._lens.x - left;
    const my = this._lens.y - top;
    const mask = `radial-gradient(circle ${r}px at ${mx.toFixed(1)}px ${my.toFixed(1)}px, black 0%, black 55%, transparent 100%)`;
    st.webkitMaskImage = st.maskImage = mask;
  }

  destroy() {
    cancelAnimationFrame(this._raf);
  }
}

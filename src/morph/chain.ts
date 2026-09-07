// Atlas-chain driver: maps a GLOBAL shape
// progress g in [0..8] onto (atlas texture, local u_progress in [0..3]),
// swapping atlases only while the cloud rests at a shared boundary shape —
// the sampled blend is identical on both sides, so the swap is invisible.
//
//   atlas a: face(0)  scatter(1)  sap(2)       rptu(3)
//   atlas b: rptu(3)  dfki(4)     cognizant(5) graph(6)
//   atlas c: graph(6) brain(7)    globe(8)     globe(8)
import { TextureLoader, type Texture } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader';
import type { ParticleCloud } from '../engine/ParticleCloud';

// RE-INDEXED 2026-09-06 (was dfki 2, sap 3, rptu 4). The Experience copy order
// became SAP -> RPTU -> DFKI -> Cognizant, and scroll.ts anchors each shape at
// its element's CENTRE, so page order IS the order these are visited. Under the
// old indices g ran 3 -> 4 -> 2 -> 5 down the page: the cloud morphed backwards
// through SAP (showing that mark twice), and the 4 -> 2 step crossed this
// atlas chain's a/b boundary in reverse by a whole shape — |g - 3| = 1 > the
// JUMP_EPS below, so `update()` would classify an ordinary slow scroll as a
// teleport and hard-snap the atlas mid-section, which is exactly the visible
// pop the settle-on-the-boundary path exists to prevent.
// These MUST stay in lockstep with the `atlases:` quads in
// tools/bake/targets.yaml — the index is a quadrant address, so an edit here
// without a matching re-bake silently addresses the wrong logo.
export const SHAPE_INDEX: Record<string, number> = {
  face: 0,
  scatter: 1,
  sap: 2,
  rptu: 3,
  dfki: 4,
  cognizant: 5,
  graph: 6,
  brain: 7,
  globe: 8,
};

export const GLOBAL_MAX = 8;

interface AtlasDef {
  pos: string;
  cd: string;
  /** Global shape index of this atlas's Q1. */
  base: number;
}

const ATLAS_DEFS: AtlasDef[] = [
  { pos: '/maps/pos-a.exr', cd: '/maps/cd-a.png', base: 0 },
  { pos: '/maps/pos-b.exr', cd: '/maps/cd-b.png', base: 3 },
  { pos: '/maps/pos-c.exr', cd: '/maps/cd-c.png', base: 6 },
];

const SETTLE_EPS = 0.02;
/** How far past the boundary shape the target `g` may sit before a pending
 *  swap counts as a JUMP and is taken instantly instead of waiting to settle.
 *  Scrolling over the edge overshoots by ~0.01; a nav click or deep link to
 *  the far end of the page overshoots by whole shapes. */
const JUMP_EPS = 0.5;

export class AtlasChain {
  private _cloud: ParticleCloud;
  private _textures: { pos: Texture; cd: Texture }[] = [];
  private _current = 0;
  private _ready = false;
  /** Desired global shape progress, set by the scroll driver. */
  globalTarget = 0;

  constructor(cloud: ParticleCloud) {
    this._cloud = cloud;
  }

  /** Preload atlases b/c (atlas a is the engine's boot atlas). */
  async load() {
    const exr = new EXRLoader();
    const tex = new TextureLoader();
    this._textures = await Promise.all(
      ATLAS_DEFS.map(async (def) => ({
        pos: await exr.loadAsync(def.pos),
        cd: await tex.loadAsync(def.cd),
      }))
    );
    this._ready = true;
  }

  get currentAtlas() {
    return this._current;
  }

  /** Atlas index whose [base, base+3] range contains g (prefers `near`). */
  private _atlasFor(g: number, near: number): number {
    const n = ATLAS_DEFS.length;
    if (g >= ATLAS_DEFS[near].base && g <= ATLAS_DEFS[near].base + 3) return near;
    for (let i = 0; i < n; i++) {
      if (g >= ATLAS_DEFS[i].base && g <= ATLAS_DEFS[i].base + 3) return i;
    }
    return g < 0 ? 0 : n - 1;
  }

  /** Call every frame BEFORE cloud.update(). Sets cloud.targets.progress. */
  update() {
    const cloud = this._cloud;
    const g = Math.max(0, Math.min(GLOBAL_MAX, this.globalTarget));
    const cur = ATLAS_DEFS[this._current];
    const desired = this._atlasFor(g, this._current);

    if (desired === this._current || !this._ready) {
      // Clamped because an atlas only holds shapes [base, base+3]: before the
      // preload resolves, a deep-linked `g` of 8 would otherwise ask atlas A
      // for quadrant 8.
      cloud.targets.progress = Math.max(0, Math.min(3, g - cur.base));
      return;
    }

    const towardHigher = desired > this._current;
    const boundaryLocal = towardHigher ? 3 : 0;

    // A swap is due, and there are two ways to take it.
    //
    // SCROLLING: `g` has just crept past this atlas's edge, so the cloud is
    // already sitting on the boundary shape — settle for a frame or two and
    // swap there. The sampled blend is identical either side, which is what
    // makes the swap invisible. This is the path that must be preserved.
    //
    // A JUMP: a nav-anchor click, a deep link, a refresh partway down, a
    // back/forward restore. `g` teleports and the cloud is a whole atlas away
    // from the boundary it would have to reach — and easing there costs ~10s
    // PER ATLAS, with the wrong shape on screen throughout. Measured before
    // this: clicking nav "Contact" from the hero still showed the graph 20s
    // later, and a direct /#skills load showed the SAP logo under "The
    // toolkit." Nothing is being kept continuous in that case — the reader
    // asked to be somewhere else — so go straight to the destination atlas
    // instead of walking the boundaries.
    //
    // What separates them is how far past this atlas the DESTINATION is — not
    // how far the spring currently lags. Lag was the first thing tried and it
    // is the wrong signal: a ~1s smooth scroll from a nav click leaves the
    // spring ~0.5 behind, under any threshold that gradual scrolling stays
    // below, so nav clicks kept taking the settle path and crawling.
    // `g` is unambiguous. Creeping over the edge while scrolling puts it ~0.01
    // past the boundary shape; a jump to the far end of the page puts it whole
    // shapes past.
    if (Math.abs(g - (cur.base + boundaryLocal)) > JUMP_EPS) {
      const def = ATLAS_DEFS[desired];
      cloud.setPositionTexture(this._textures[desired].pos);
      cloud.setColorTexture(this._textures[desired].cd);
      this._current = desired;
      const local = g - def.base;
      cloud.targets.progress = local;
      // Snap the spring too, or it eases across from where it had drifted to,
      // blending the new atlas's quadrants on the way.
      cloud.rebaseProgress(local - cloud.progressActual);
      return;
    }

    cloud.targets.progress = boundaryLocal;
    if (Math.abs(cloud.progressActual - boundaryLocal) < SETTLE_EPS) {
      const next = this._current + (towardHigher ? 1 : -1);
      const nextDef = ATLAS_DEFS[next];
      cloud.setPositionTexture(this._textures[next].pos);
      cloud.setColorTexture(this._textures[next].cd);
      cloud.rebaseProgress(cur.base - nextDef.base);
      this._current = next;
    }
  }
}

// Scroll driver (Phase 4): reads the [data-shape] sections in DOM order,
// maps scroll position to a GLOBAL shape progress g in [0..8] by piecewise-
// linear interpolation between section anchors, and interpolates per-shape
// placement (offset/rotation) so the cloud travels between sections.
// Scroll-bound, never autoplaying: the user owns the pace.
import Lenis from 'lenis';
import type { ParticleCloud } from '../engine/ParticleCloud';
import { AtlasChain, SHAPE_INDEX } from './chain';

/** Per-shape placement targets (world units at the cloud plane; tuning
 *  knobs; final pass at the end). `factor` scales the
 *  cloud's world radius (default 4.35 desktop / 2.5 mobile). */
interface Placement {
  x: number;
  y: number;
  rotY: number;
  rotZ: number;
  factor?: number;
  /** Held explode level at the settled section (0 = fully formed shape;
   *  1 = blasted apart, particles flung to 1–6x radius, mostly offscreen). */
  explode?: number;
}
// Sides alternate down the page (Binoy, 2026-07-06): R, C, L, R, L, R, L, R, C.
// AMENDED 2026-09-05: slot 6 (Projects) is no longer placed left — it now holds
// full explode, so it has no side. Sequence reads R, C, —, R, R, R, R, —, R, C.
// EXCEPTION (Binoy, 2026-08-03): the four Experience LOGOS all sit RIGHT — the
// copy column is left-aligned, so a left-placed logo ran off the left screen
// edge and tangled with the body text once the marks were enlarged (the "df" of
// dfki, the "R"/"P" of rptu became illegible). The open right half keeps the
// whole mark on-screen and clear of the text. Resting rotY gives a slight 3/4
// angle; face stays FRONTAL (0) — the hero-lens photo registration needs it.
const PLACEMENT: Record<number, Placement> = {
  0: { x: 3.0, y: 0, rotY: 0, rotZ: 0 }, // face — hero right half (keep rotY 0!)
  // scatter — About holds FULL EXPLODE (Binoy, 2026-07-07): particles flung
  // far apart, most beyond the viewport, sparse on screen. No shape at all.
  1: { x: 0.0, y: 0, rotY: 0, rotZ: 0, explode: 1 },
  // Slots 2..5 are the four Experience logos and are DELIBERATELY IDENTICAL, so
  // the 2026-09-06 re-index (page order became SAP, RPTU, DFKI, Cognizant —
  // see SHAPE_INDEX in chain.ts) needed no numbers changed here, only labels.
  // If any of these four ever diverges, it has to be re-checked against
  // SHAPE_INDEX rather than assumed.
  //
  // x 2.9 -> 4.0 (Binoy, 2026-09-06, settled after trying 3.5 and 3.9): at 2.9
  // the marks ran UNDER the copy column. Measured ink-left vs where the copy
  // actually ends, on settled shapes at 1440: sap -107px, rptu -113px,
  // dfki -81px, cognizant +4px (negative = ink under text); same story at
  // 1920/2114. At 4.0 the copy is clear at 1440, 1920 and 2114.
  //
  // KNOWN AND ACCEPTED: this is a WIDE-viewport fix, and it is paid for at the
  // mid widths. Pixels-per-world-unit is `viewportHeight / 9.33` (fov 50 at
  // z 10) — it depends on the window's HEIGHT, while the room to place a mark
  // depends on its WIDTH. So a world-unit shift moves the SAME number of
  // pixels at every width (+1.1 units here = +106px everywhere) while the room
  // to absorb it shrinks as the window narrows. Measured right-edge headroom at
  // 4.0: 370px @2114, 286px @1920, **22px @1440**, **1px @1280**. Below about
  // 1500px the right of the mark is CLIPPED — at 1440 the RPTU "U" is cut in
  // half, at 1280 worse. Binoy signed this off deliberately; it is not an
  // oversight, and it is the reason the four values are a plain constant here
  // rather than something responsive.
  //
  // The ready fix, if the clipping ever matters: TAPER x with the room actually
  // available rather than shrinking `factor`. Room in world units is
  // `(vw/2 - copyRight) / (vh/9.33)`; hold 4.0 above ~1900 and ease to ~3.4 by
  // 1280. A global `factor` shrink is the wrong lever — it costs mark size at
  // every width to fix a problem that only exists at some of them.
  2: { x: 4.0, y: 0, rotY: -0.14, rotZ: 0 }, // sap — right
  3: { x: 4.0, y: 0, rotY: -0.14, rotZ: 0 }, // rptu — right (was left; clipped off-screen)
  4: { x: 4.0, y: 0, rotY: -0.14, rotZ: 0 }, // dfki — right (was left; clipped off-screen)
  5: { x: 4.0, y: 0, rotY: -0.14, rotZ: 0 }, // cognizant — right
  // graph — Projects holds FULL EXPLODE (Binoy, 2026-09-05), same as About.
  // The section is now the card deck; the `</>` glyph read as clutter behind
  // the fanned cards, so the shape never forms here — particles stay flung
  // apart, mostly beyond the viewport. The `graph` chain slot and its baked
  // atlas quadrant stay put (the chain needs all 9 shapes); it is simply never
  // allowed to settle. Restore the old placement to bring the glyph back:
  //   { x: -3.0, y: 0, rotY: 0.16, rotZ: 0.05 }
  6: { x: 0.0, y: 0, rotY: 0, rotZ: 0, explode: 1 },
  7: { x: 3.4, y: 0, rotY: -0.18, rotZ: -0.04, factor: 3.2 }, // brain — right
  8: { x: 0.0, y: 0.3, rotY: 0, rotZ: 0, factor: 3.6 }, // globe — centred behind "Let's talk."
};
const DEFAULT_FACTOR = { desktop: 4.35, mobile: 2.5 };

/** Explode-then-reform between sections: a bell over the
 *  transition — 0 at every settled shape, peaking mid-travel. Scroll-bound,
 *  so scrubbing back and forth breathes the cloud. Amplitude is a tuning knob. */
const EXPLODE_AMPLITUDE = 1.0;

/** Shape-holding plateaus: each shape stays settled for
 *  HOLD of the scroll span on either side of its section anchor; the whole
 *  morph + explosion is compressed into the middle (1 - 2·HOLD) window.
 *  Also guarantees the LAST shape is fully formed before max scroll. tuning knob. */
const HOLD = 0.32;

/** The cloud GROWS while exploding (factor is coupled with explode). */
const EXPLODE_GROWTH = 0.9;

/** Extra Y-rotation sweep while travelling between sections — the cloud
 *  turns into its journey, revealing its 3D-ness (radians, tuning knob). */
const ROTATION_SWEEP = 0.45;

function plateau(t: number): number {
  return Math.min(1, Math.max(0, (t - HOLD) / (1 - 2 * HOLD)));
}

export interface ScrollDriverOptions {
  cloud: ParticleCloud;
  chain: AtlasChain;
  isMobile?: boolean;
  reducedMotion?: boolean;
}

export class ScrollDriver {
  private _cloud: ParticleCloud;
  private _chain: AtlasChain;
  private _isMobile: boolean;
  private _anchors: { y: number; g: number }[] = [];
  private _lenis: Lenis | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _anchorRaf = 0;

  constructor({ cloud, chain, isMobile = false, reducedMotion = false }: ScrollDriverOptions) {
    this._cloud = cloud;
    this._chain = chain;
    this._isMobile = isMobile;
    if (!reducedMotion) {
      this._lenis = new Lenis({ autoRaf: true });
    }
    this._computeAnchors();

    // Anchors are element CENTRES, so every one of them moves whenever the
    // document reflows — and the first computation above necessarily runs
    // before webfonts swap in, which shifts every heading below it. Recomputing
    // only on `resize` (the original behaviour) left the whole chain running
    // against fallback-font positions for the life of the page.
    // That was survivable while anchors were ~2000px apart, but Projects' title
    // anchor now sits 338px after Cognizant's, where a ~100px stale offset is a
    // third of the segment — enough to hold the wrong shape on screen. So:
    // recompute whenever the page actually settles or changes height.
    window.addEventListener('resize', this._scheduleAnchors);
    window.addEventListener('load', this._scheduleAnchors);
    document.fonts?.ready.then(this._scheduleAnchors);
    if ('ResizeObserver' in window) {
      this._resizeObserver = new ResizeObserver(this._scheduleAnchors);
      this._resizeObserver.observe(document.body);
    }
  }

  /** Coalesce recompute requests to one per frame. Read-only, so observing the
   *  body cannot feed back into itself. */
  private _scheduleAnchors = () => {
    if (this._anchorRaf) return;
    this._anchorRaf = requestAnimationFrame(() => {
      this._anchorRaf = 0;
      this._computeAnchors();
    });
  };

  /** Anchors are the CENTRE of each `[data-shape]` element, so a very tall
   *  element anchors its shape very late. A shape index may be REPEATED on
   *  several elements to pin it across a span: between two anchors carrying the
   *  same `g`, `_globalProgress` interpolates g→g and the shape simply holds.
   *  Projects relies on this (two `graph` anchors — see index.html); if you ever
   *  make the anchor list unique, that section regresses. */
  private _computeAnchors() {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-shape]'));
    const vh = window.innerHeight;
    // Clamp to reachable scroll — the last section's ideal anchor can sit past
    // maxScroll (short footer), which would make its shape unreachable.
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
    this._anchors = sections
      .map((el) => {
        const g = SHAPE_INDEX[el.dataset.shape ?? ''];
        if (g === undefined) return null;
        const rect = el.getBoundingClientRect();
        const centerY = rect.top + window.scrollY + rect.height / 2;
        return { y: Math.min(maxScroll, Math.max(0, centerY - vh / 2)), g };
      })
      .filter((a): a is { y: number; g: number } => a !== null)
      .sort((a, b) => a.y - b.y);
  }

  /** Global shape progress for the current scroll position. */
  private _globalProgress(scrollY: number): number {
    const a = this._anchors;
    if (a.length === 0) return 0;
    if (scrollY <= a[0].y) return a[0].g;
    for (let i = 0; i < a.length - 1; i++) {
      if (scrollY < a[i + 1].y) {
        const t = plateau((scrollY - a[i].y) / Math.max(1, a[i + 1].y - a[i].y));
        return a[i].g + t * (a[i + 1].g - a[i].g);
      }
    }
    return a[a.length - 1].g;
  }

  /** Call every frame before cloud.update(). */
  update() {
    const g = this._globalProgress(window.scrollY);
    this._chain.globalTarget = g;
    this._chain.update();

    // interpolate placement between the two neighbouring shapes
    const lo = Math.floor(g);
    const hi = Math.min(8, lo + 1);
    const t = g - lo;
    const A = PLACEMENT[lo];
    const B = PLACEMENT[hi];
    const scale = this._isMobile ? 0.25 : 1;
    const tg = this._cloud.targets;
    tg.x = (A.x + (B.x - A.x) * t) * scale;
    tg.y = (A.y + (B.y - A.y) * t) * scale + (this._isMobile ? 1.6 : 0);
    const bell = lo === hi ? 0 : Math.sin(Math.PI * t);
    const travelDir = Math.sign(B.x - A.x) || (lo % 2 === 0 ? 1 : -1);
    tg.rotY = A.rotY + (B.rotY - A.rotY) * t + bell * ROTATION_SWEEP * travelDir;
    tg.rotZ = A.rotZ + (B.rotZ - A.rotZ) * t;
    const base = this._isMobile ? DEFAULT_FACTOR.mobile : DEFAULT_FACTOR.desktop;
    const fScale = this._isMobile ? base / DEFAULT_FACTOR.desktop : 1;
    const fA = (A.factor ?? DEFAULT_FACTOR.desktop) * fScale;
    const fB = (B.factor ?? DEFAULT_FACTOR.desktop) * fScale;
    tg.factor = fA + (fB - fA) * t + bell * EXPLODE_GROWTH * fScale;
    const heldExplode = (A.explode ?? 0) + ((B.explode ?? 0) - (A.explode ?? 0)) * t;
    tg.explode = Math.max(bell * EXPLODE_AMPLITUDE, heldExplode);
  }

  destroy() {
    this._lenis?.destroy();
    this._resizeObserver?.disconnect();
    if (this._anchorRaf) cancelAnimationFrame(this._anchorRaf);
    window.removeEventListener('resize', this._scheduleAnchors);
    window.removeEventListener('load', this._scheduleAnchors);
  }
}

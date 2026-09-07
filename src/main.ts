// Stylesheets are loaded as <link>s in index.html, deliberately NOT imported
// here — importing them makes the CSS a side effect of this module, and in dev
// Vite then injects it via JS, leaving nothing render-blocking and allowing an
// unstyled first paint. See the comment beside those links.
import { ParticleEngine } from './engine/Engine';
import { AtlasChain } from './morph/chain';
import { ScrollDriver } from './morph/scroll';
import { HeroLens } from './hero/lens';
import { buildNameplate, animateNameplate } from './hero/nameplate';
import { initReveals } from './motion/reveals';
import { initProjectDeck } from './projects/deck';

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
initReveals(prefersReduced);

// Projects card deck (section 4). Runs its own rAF rather than riding
// engine.onBeforeRender so the deck still works with no WebGL field; it reads
// window.scrollY, which Lenis has already damped. Mounted after fonts settle
// so the card and title measurements are taken against the real faces.
const mountDeck = () => initProjectDeck(prefersReduced);
if (document.fonts?.ready) document.fonts.ready.then(mountDeck);
else window.addEventListener('load', mountDeck);

const nav = document.querySelector<HTMLElement>('.nav');
if (nav) {
  const onScroll = () => nav.classList.toggle('nav--scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Brand mark: `b.` on a tile while the hero nameplate is on screen, full
  // wordmark once it has passed under the bar (one clipped SVG, not two assets
  // — see the .nav__brand block in sections.css). Keyed to the NAMEPLATE, not a
  // scroll threshold, so the swap lands exactly as the name leaves — the point
  // is that the name is never shown twice at once. The top rootMargin is the
  // nav's own height (72px since the Résumé pill — previously the bar's tallest
  // item at 77px — was removed 2026-09-05), so "gone" means gone behind the bar,
  // not merely off the viewport top; re-measure it if the bar's contents change.
  // Without a nameplate (no-JS mount, future layouts) the nav just keeps the
  // wordmark, which is the safe default.
  const nameplate = document.querySelector('.hero__nameplate');
  if (nameplate && 'IntersectionObserver' in window) {
    new IntersectionObserver(
      ([entry]) => nav.classList.toggle('nav--past-hero', !entry.isIntersecting),
      { rootMargin: '-72px 0px 0px 0px', threshold: 0 }
    ).observe(nameplate);
  } else {
    nav.classList.add('nav--past-hero');
  }
}

// Hero terminal-block name — built unconditionally so it renders even without
// WebGL. Empty mount falls back to text via CSS.
const nameMount = document.querySelector<HTMLElement>('.hero__nameplate');
if (nameMount) buildNameplate(nameMount);

// The hero COPY intro is pure CSS now (see the inline <style> in index.html) —
// it needs nothing from this bundle. Only the nameplate does, because its
// blocks are built here.
//
// If the bundle arrived late, render the name settled instead of performing.
// The CSS has already faded the :empty fallback in by 0.8s, so replaying the
// write-in would blank a name the reader is already looking at and retype it —
// a smaller version of the bug this whole sequence had before. `is-static` is
// the same path reduced motion takes.
const LATE_MS = 1500;
animateNameplate(prefersReduced || performance.now() > LATE_MS);

// --- The particle field (Phase 4) ---------------------------------------
// The page stays fully legible without any of this (reduced-motion baseline).
const canvas = document.getElementById('field') as HTMLCanvasElement | null;
const isMobile = window.matchMedia('(max-width: 768px)').matches;

if (canvas) {
  const engine = new ParticleEngine({
    canvas,
    urls: {
      positionExr: '/maps/pos-a.exr',
      colorPng: '/maps/cd-a.png',
      scalePng: '/maps/sc.png',
      modelGlb: isMobile ? '/models/py-lod2.glb' : '/models/py-lod7.glb',
    },
    isMobile,
    // Polish pass 2026-07-06: grain + shroud intro, bokeh DoF and the
    // foreground parallax layer are all ON. The design spec nominally forbids
    // grain — kept here as a deliberate final-tuning decision.
    grain: true,
    post: { bloom: true, bokeh: true, vignette: true },
    foreground: true,
    clearColor: 0x06090b,
  });

  engine.cloud.choreography = 'external';
  const chain = new AtlasChain(engine.cloud);
  const scroll = new ScrollDriver({ cloud: engine.cloud, chain, isMobile, reducedMotion: prefersReduced });
  engine.onBeforeRender = () => scroll.update();

  engine.onLoaded(() => {
    // Atlas preload starts HERE, not before the engine boots. It fetches all
    // three atlases, but only A is needed to render the face — B and C cover
    // shapes 3..8, which the reader cannot reach without scrolling well past
    // the hero. Firing it up front put ~483KB of pos-b/pos-c in the same
    // request burst as the four assets that actually gate first render
    // (measured: all six started at the same millisecond), so on a real
    // connection they stole bandwidth from the thing on screen. Deferring also
    // means pos-a/cd-a come from cache rather than being fetched twice.
    // The chain clamps progress to the current atlas until `_ready`, so an
    // improbably fast scroll during the gap degrades to "shape holds", not a
    // crash.
    chain.load().catch((e) => console.error('[field] atlas preload failed', e));

    if (prefersReduced) {
      engine.cloud.easing = 1;
      engine.cloud.activate({ instant: true });
      engine.grainLayer?.hide({ instant: true });
    } else {
      engine.cloud.activate({ delay: 0.15 }); // gather: scatter -> face
      engine.grainLayer?.hide({ delay: 0.1 }); // drop the shroud (intro)
    }
    // NOTE: the nameplate + copy intro is NOT fired here — see the comment at
    // the buildNameplate call above. Firing it on engine load is what caused the
    // hero to render and then blank out.

    // Phase 5: cursor lens — the photo resolving where attention lands.
    const photo = document.querySelector<HTMLImageElement>('.hero__photo');
    const toggle = document.querySelector<HTMLButtonElement>('.hero__photo-toggle');
    const hero = document.getElementById('hero');
    if (photo && hero) {
      new HeroLens({ engine, photo, toggle, hero, reducedMotion: prefersReduced });
    }
  });
  engine.start();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) engine.stop();
    else engine.start();
  });

  // debug/testing handle (harmless in production)
  (window as unknown as Record<string, unknown>).__fieldEngine = {
    engine,
    cloud: engine.cloud,
    get chainCurrent() {
      return chain.currentAtlas;
    },
  };
}

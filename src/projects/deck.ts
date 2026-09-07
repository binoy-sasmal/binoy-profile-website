// Projects card deck — the scroll choreography behind section 4.
//
// The numeric parameters below were tuned as one set and should be changed as
// one: the progress windows, the per-card flip thresholds, the open-then-close
// rotateZ fan, and the cos(t*3+p) idle bob enveloped by cos(l).
// The deck is built for FOUR cards; the fan geometry assumes that count.
// The one
// deliberate change is SEQUENCE_SHIFT below, which moves when the sequence
// starts without altering its shape.
//
// SCROLL SOURCE. This choreography must never animate against RAW scroll: it
// needs a damped scroll position so that every transform inherits the same
// smoothness. We already run Lenis (morph/scroll.ts, `autoRaf: true`), which
// damps and drives the real scroll position — so reading window.scrollY here
// gets the same fluid ramp for free. Do NOT add a second smooth-scroller; it
// would fight Lenis and the motion goes notchy.
//
// The cards are not interactive: every bit of motion is a
// transform recomputed from scroll each frame. The only clickable thing on a
// card is the repo link on its face.

/** The deck breakpoint. MUST match the `max-width: 812px` queries
 *  in styles/sections.css — above it the deck fans and every card position is a
 *  JS transform; below it the cards are statically laid out and only flip. If
 *  the two disagree, the JS writes absolute fan offsets onto in-flow cards. */
const MOBILE_QUERY = '(max-width: 812px)';

/** Degrees of rotateZ per card-step in the fan. With N=4 the mid is 1.5, so
 *  this opens the deck to ±13.5° / ±4.5°. */
const FAN_DEG = 9;

/* Scroll windows, in screenRatio space.

   The base sequence, SHIFTED EARLIER BY 0.34 (Binoy, 2026-09-05). The raw
   values are FAN [-0.6, 0.2], FLIP [-0.5, 0.7], and screenRatio -0.6 is exactly
   where the pin engages — so with FAN_HOLD the deck did not begin to spread
   until -0.44, i.e. 40vh AFTER pinning, by which point the section title has
   already scrolled off the top. The deck should start opening while it is still
   entering and the title is still on screen.

   Both windows are shifted by the same -0.34 and keep their original spans
   (0.8 and 1.2) and FAN_HOLD, so the choreography itself is untouched — the
   stagger, easings, overshoot and the fan's open-then-close are unchanged;
   only the trigger point moved. An earlier attempt that changed the spans instead
   was rejected: shift, do not re-shape.

   0.34 is derived, not guessed. The deck sits at runwayTop + (100vh - cardH)/2
   before the pin engages, so it is 60% visible when runwayTop - scrollY = 408px
   at a 900px viewport, which is screenRatio -0.78. The unshifted fan onset
   is -0.44, hence -0.78 - (-0.44) = -0.34. */
const SEQUENCE_SHIFT = -0.34;
const FAN_FROM = -0.6 + SEQUENCE_SHIFT;
const FAN_TO = 0.2 + SEQUENCE_SHIFT;
const FLIP_FROM = -0.5 + SEQUENCE_SHIFT;
const FLIP_TO = 0.7 + SEQUENCE_SHIFT;
/** Dead band at the head of the fan before any card starts to spread.
 *  With the shift above, the fan's effective onset is FAN_FROM + 0.2*0.8. */
const FAN_HOLD = 0.2;
/** Idle-bob amplitude in px. tuning knob. */
const BOB_PX = 10;

// ---- math helpers (the original's math.* / ease.*) ------------------------
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const saturate = (v: number) => clamp(v, 0, 1);
/** map v from [a,b] onto [out0,out1], clamped, optionally through an easing */
const fit = (
  v: number,
  a: number,
  b: number,
  out0: number,
  out1: number,
  easing?: (t: number) => number
) => {
  let t = clamp((v - a) / (b - a), 0, 1);
  if (easing) t = easing(t);
  return out0 + t * (out1 - out0);
};

const ease = {
  expoOut: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoInOut: (t: number) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : (t *= 2) < 1
          ? 0.5 * Math.pow(1024, t - 1)
          : 0.5 * (-Math.pow(2, -10 * (t - 1)) + 2),
  cubicInOut: (t: number) => ((t *= 2) < 1 ? 0.5 * t * t * t : 0.5 * ((t -= 2) * t * t + 2)),
  /** overshoot s = 2.5949095 — this is what gives the flip its snap */
  backInOut: (t: number) => {
    const s = 2.5949095;
    return (t *= 2) < 1
      ? 0.5 * t * t * ((s + 1) * t - s)
      : 0.5 * ((t -= 2) * t * ((s + 1) * t + s) + 2);
  },
  /** the site's signature curve, a cubic-bezier(.35, 0, 0, 1) */
  signature: (t: number) => bezier(t, 0.35, 0, 0, 1),
};

/** y for a given x on cubic-bezier(x1,y1,x2,y2), solved by bisection */
function bezier(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3;
  const cy = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 24; i++) {
    t = (lo + hi) / 2;
    if (cx(t) < x) lo = t;
    else hi = t;
  }
  return cy(t);
}

interface DocBox {
  top: number;
  height: number;
}

export class ProjectDeck {
  private _title: HTMLElement;
  private _subText: HTMLElement;
  private _runway: HTMLElement;
  private _deck: HTMLElement;
  private _cards: HTMLElement[];

  private _titleChars: HTMLElement[] = [];
  private _subInner: HTMLElement | null = null;
  private _repos: HTMLElement | null = null;

  // Cached document-space geometry. The frame loop never reads layout: a rect
  // read per frame forces a reflow and that alone makes the motion notchy.
  private _cardW = 0;
  private _cardH = 0;
  private _wrapW = 0;
  private _cardOffset = 0;
  private _boxRunway: DocBox = { top: 0, height: 1 };
  private _boxTitle: DocBox = { top: 0, height: 1 };
  private _boxDeck: DocBox = { top: 0, height: 1 };
  private _boxCards: DocBox[] = [];

  private _titleTime = 0;
  private _time = 0;
  private _last = 0;
  private _raf = 0;
  private _resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(root: HTMLElement) {
    this._title = root.querySelector<HTMLElement>('.projects__title')!;
    this._subText = root.querySelector<HTMLElement>('.projects__subheader-text')!;
    this._repos = root.querySelector<HTMLElement>('.projects__repos');
    this._runway = root.querySelector<HTMLElement>('.projects__runway')!;
    this._deck = root.querySelector<HTMLElement>('.projects__deck')!;
    this._cards = Array.from(root.querySelectorAll<HTMLElement>('.pcard'));

    this._splitText();
    this._measure();

    window.addEventListener('resize', this._onResize, { passive: true });
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._update);
  }

  private get _isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  // ---- split the title into per-character spans inside a clipping line box.
  // A multi-word title would stagger by word; ours is a single word, so we
  // stagger by character to keep the same cascading rise rather than animating
  // one flat block.
  private _splitText() {
    const text = this._title.dataset.text ?? this._title.textContent ?? '';
    this._title.textContent = '';
    const line = document.createElement('span');
    line.className = 'projects__title-line';
    this._title.appendChild(line);

    this._titleChars = [];
    for (const ch of Array.from(text)) {
      const span = document.createElement('span');
      span.className = 'projects__title-char';
      span.textContent = ch === ' ' ? ' ' : ch;
      line.appendChild(span);
      this._titleChars.push(span);
    }

    const subText = this._subText.dataset.text ?? this._subText.textContent ?? '';
    this._subText.textContent = '';
    const sLine = document.createElement('span');
    sLine.className = 'projects__subheader-line';
    const sInner = document.createElement('span');
    sInner.className = 'projects__subheader-inner';
    sInner.textContent = subText;
    sLine.appendChild(sInner);
    this._subText.appendChild(sLine);
    this._subInner = sInner;
  }

  private _docBox(el: HTMLElement): DocBox {
    const r = el.getBoundingClientRect();
    return { top: r.top + window.scrollY, height: r.height };
  }

  private _measure() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight / 100}px`);

    // Measure with transforms cleared and the deck at natural height.
    this._deck.style.height = 'auto';
    this._cards.forEach((c) => (c.style.transform = ''));

    const r = this._cards[0].getBoundingClientRect();
    this._cardW = r.width;
    this._cardH = r.height;
    this._wrapW = this._deck.getBoundingClientRect().width;
    this._cardOffset = this._wrapW - this._cardW * this._cards.length;

    // Absolutely-positioned cards contribute no flow height on desktop — give
    // the deck one so the sticky pin can centre it vertically.
    this._deck.style.height = this._isMobile ? 'auto' : `${this._cardH}px`;

    this._boxRunway = this._docBox(this._runway);
    this._boxTitle = this._docBox(this._title);
    this._boxDeck = this._docBox(this._deck);
    this._boxCards = this._cards.map((c) => this._docBox(c));
  }

  /** The original's screenRatio: -1 when the element's top sits at the viewport
   *  bottom (entering), +1 once it has fully passed the viewport top. */
  private _ratioOf(b: DocBox, scrollY: number) {
    return fit(b.top - scrollY, window.innerHeight, -b.height, -1, 1);
  }

  private _onResize = () => {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._measure();
    }, 150);
  };

  private _update = (now: number) => {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this._time += dt;

    const scrollY = window.scrollY;
    const vh = window.innerHeight;
    const mobile = this._isMobile;
    const n_cards = this._cards.length;

    if (!mobile) {
      // Three progress values, all derived from the runway's screenRatio.
      const sr = this._ratioOf(this._boxRunway, scrollY);
      const n = fit(sr, FAN_FROM, FAN_TO, 0, 1); // stack → fan out
      const a = fit(sr, FLIP_FROM, FLIP_TO, 0, 1); // back → front (the flip)
      const l = fit(sr, FLIP_FROM, FLIP_TO, -Math.PI / 2, Math.PI / 2); // bob envelope

      const centreX = this._wrapW / 2 - this._cardW / 2;
      const mid = (n_cards - 1) / 2;

      for (let p = 0; p < n_cards; p++) {
        // Exact-fit spread (analysis §2): with the card width solved for N,
        // this lands on p * (cardW + gap) — edge-to-edge, equal gaps, any
        // viewport, and the last card's right edge on the content width.
        const spreadX = (p / n_cards) * (this._wrapW + this._cardOffset / (n_cards - 1));
        const x = fit(n, FAN_HOLD, 1, centreX, spreadX, ease.expoOut);

        // Later cards flip later, so the deal reads left→right. At N=5 the
        // thresholds come out 0.50 / 0.55 / 0.60 / 0.65 / 0.70.
        const flip = fit(a, 0, 0.7 - Math.abs(n_cards - 1 - p) / 20, 180, 0, ease.backInOut);

        // The |x*2-1| term is what makes the fan OPEN and then CLOSE again
        // rather than ramp monotonically — most of the section's character.
        const fanT = Math.abs(fit(n, 0, 0.75, 0, 1) * 2 - 1);
        const fan = fit(fanT, 1, 0, 0, (p - mid) * FAN_DEG, ease.expoInOut);

        // Idle bob, phase-offset per card, amplitude faded out at both
        // extremes by cos(l) so it never starts or stops abruptly.
        const bob = Math.cos(this._time * 3 + p) * Math.cos(l);

        this._cards[p].style.transform =
          `translate3d(${x}px, ${bob * BOB_PX}px, 0) rotateZ(${fan}deg) rotate3d(0, 1, 0, ${flip}deg)`;
      }

      // "All project repositories" arrives once the deck has finished dealing.
      // Keyed to `a`, the same flip progress the cards use: the last card lands
      // at a = 0.7 (see the threshold above), so the window straddles it: the link
      // is there as the last card lands, and it goes away again on the way back.
      // Measured — 0.7→0.85 was tried first and finished ~0.6vh of scroll after
      // the cards had already settled, which read as a lag. Opacity + translate only; no clip, because it is
      // focusable and a clip box would crop the focus ring.
      if (this._repos) {
        const r = fit(a, 0.66, 0.74, 0, 1, ease.expoOut);
        this._repos.style.opacity = `${r}`;
        this._repos.style.transform = `translate3d(0, ${fit(r, 0, 1, 12, 0)}px, 0)`;
        // `visibility`, not just opacity: an opacity-0 element is still
        // hit-testable AND still in the tab order, so while the deck was dealing
        // an invisible link sat under the cards catching clicks and taking a tab
        // stop. Hiding it properly removes both.
        this._repos.style.visibility = r < 0.02 ? 'hidden' : 'visible';
      }
    } else {
      // Mobile: no stack, no fan. The deck is a static two-up grid and each
      // card flips off its OWN screenRatio, staggered so the two columns do
      // not turn in lockstep.
      const topNow = this._boxDeck.top - scrollY;
      const showOffset = -(topNow - vh) / vh;
      this._deck.style.perspectiveOrigin =
        `center ${fit(showOffset, 0, this._boxDeck.height / vh, 0, 1) * 100}%`;

      for (let p = 0; p < n_cards; p++) {
        const flip = fit(
          this._ratioOf(this._boxCards[p], scrollY),
          -0.85 - (p % 2) / 10,
          0,
          180,
          0,
          ease.cubicInOut
        );
        this._cards[p].style.transform = `rotateY(${flip}deg)`;
      }
      // Mobile has no pin and no dealing sequence to key off — the link simply
      // follows the card grid in flow.
      if (this._repos) {
        this._repos.style.opacity = '1';
        this._repos.style.transform = 'none';
        this._repos.style.visibility = 'visible';
      }
    }

    // ---- title + subheader ------------------------------------------------
    // titleTime advances only while the title is on screen and resets when it
    // leaves, so the intro replays on re-entry.
    const visible = this._ratioOf(this._boxTitle, scrollY) > -1;
    this._titleTime = visible ? this._titleTime + dt : 0;

    for (let f = 0; f < this._titleChars.length; f++) {
      const y = fit(this._titleTime - f / 10, 0, 1, 100, 0, ease.signature);
      this._titleChars[f].style.transform = `translate3d(0, ${y}%, 0)`;
    }

    if (this._subInner) {
      // 0.25s delay, then a 110% → 0 rise on an expoOut.
      const g = ease.expoOut(saturate(this._titleTime - 0.25));
      this._subInner.style.transform = `translate3d(0, ${fit(g, 0, 1, 110, 0)}%, 0)`;
    }

    this._raf = requestAnimationFrame(this._update);
  };

  destroy() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._resizeTimer);
    window.removeEventListener('resize', this._onResize);
  }
}

/** Mount the deck. No-op under reduced motion — the CSS already falls back to a
 *  plain readable grid of face-up cards, so nothing needs animating. */
export function initProjectDeck(reducedMotion: boolean): ProjectDeck | null {
  const root = document.querySelector<HTMLElement>('.projects');
  if (!root || reducedMotion) return null;
  if (!root.querySelector('.pcard')) return null;
  return new ProjectDeck(root);
}

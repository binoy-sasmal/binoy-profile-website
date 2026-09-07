// Hero nameplate — "BINOY SASMAL" as a Claude-Code-style terminal-block wordmark.
// Each letter is a bold 7x9 bitmap rendered as two layers: a solid FRONT of block
// cells and, offset down-right behind it, an outlined ECHO (thin-line wireframe)
// that produces the reference's 3D extruded shadow. The name writes in block-by-
// block (left-to-right) with a caret riding the write front, like a terminal.
// Colour is the site's teal-glow (styled in CSS).
//
// The <h1> keeps a real screen-reader-only "Binoy Sasmal" string; these blocks are
// aria-hidden decoration. Reduced motion: everything renders static (CSS default).
import gsap from 'gsap';

// 7 wide x 9 tall, 2-thick strokes. '#' = on, '.' = off. Only "BINOY SASMAL".
const GLYPHS: Record<string, string[]> = {
  B: ['######.', '##...##', '##...##', '######.', '######.', '##...##', '##...##', '##...##', '######.'],
  I: ['######.', '######.', '..##...', '..##...', '..##...', '..##...', '..##...', '######.', '######.'],
  N: ['##...##', '###..##', '###..##', '##.#.##', '##.#.##', '##..###', '##..###', '##...##', '##...##'],
  O: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  Y: ['##...##', '##...##', '.##.##.', '..###..', '..##...', '..##...', '..##...', '..##...', '..##...'],
  S: ['.#####.', '##...##', '##.....', '##.....', '.#####.', '.....##', '.....##', '##...##', '.#####.'],
  A: ['.#####.', '#######', '##...##', '##...##', '#######', '#######', '##...##', '##...##', '##...##'],
  M: ['##...##', '###.###', '##.#.##', '##.#.##', '##...##', '##...##', '##...##', '##...##', '##...##'],
  L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '######.', '######.'],
};

const GLYPH_W = 7;
const GLYPH_H = 9;
const LETTER_GAP = 1; // empty columns between letters (for the L->R sweep timing)
const WORD_GAP = 3; // extra columns between words

const NAME = 'BINOY SASMAL';

// Animation timing — keep in sync with the caret schedule below.
const START_DELAY = 0.8; // s before the first letter writes (face reads first)
const COL_STEP = 0.009; // s of stagger per bitmap column
const CELL_DUR = 0.3; // s per-cell pop

function makeGrid(bitmap: string[], startCol: number, echo: boolean): HTMLElement {
  const grid = document.createElement('div');
  grid.className = echo ? 'nameplate__grid is-echo' : 'nameplate__grid is-front';
  const on = (r: number, c: number) =>
    r >= 0 && r < GLYPH_H && c >= 0 && c < GLYPH_W && bitmap[r][c] === '#';
  for (let row = 0; row < GLYPH_H; row++) {
    for (let c = 0; c < GLYPH_W; c++) {
      const cell = document.createElement('span');
      cell.className = 'nameplate__cell';
      cell.style.setProperty('--col', String(startCol + c));
      if (bitmap[row][c] === '#') {
        cell.classList.add('is-on');
        // Echo cells draw a border only where they meet empty space, so the
        // outline traces the letter's silhouette (and counters) as one clean
        // wireframe rather than a grid of boxed squares.
        if (echo) {
          if (!on(row - 1, c)) cell.classList.add('edge-t');
          if (!on(row + 1, c)) cell.classList.add('edge-b');
          if (!on(row, c - 1)) cell.classList.add('edge-l');
          if (!on(row, c + 1)) cell.classList.add('edge-r');
        }
      }
      grid.appendChild(cell);
    }
  }
  return grid;
}

/**
 * Build the block DOM into `mount`. Emits one .nameplate__word per space-split
 * word, one .nameplate__glyph per letter (each with an offset outlined echo grid
 * behind a solid front grid), and a floating .nameplate__caret write head.
 */
export function buildNameplate(mount: HTMLElement): void {
  mount.textContent = '';
  const words = NAME.split(' ');
  let col = 0; // running global column, drives the sweep order + caret schedule

  words.forEach((word) => {
    const wordEl = document.createElement('div');
    wordEl.className = 'nameplate__word';

    for (const char of word) {
      const bitmap = GLYPHS[char];
      if (!bitmap) continue;
      const glyph = document.createElement('div');
      glyph.className = 'nameplate__glyph';
      glyph.dataset.startCol = String(col); // leftmost column → reveal time
      glyph.appendChild(makeGrid(bitmap, col, true)); // echo (behind)
      glyph.appendChild(makeGrid(bitmap, col, false)); // front (solid)
      wordEl.appendChild(glyph);
      col += GLYPH_W + LETTER_GAP;
    }

    mount.appendChild(wordEl);
    col += WORD_GAP;
  });

  const caret = document.createElement('span');
  caret.className = 'nameplate__caret';
  mount.appendChild(caret);
}

/**
 * Animate the build-in: front cells pop in left-to-right (stagger keyed to --col),
 * each letter's echo fades in on cue, and the caret rides the write front from
 * letter to letter, dropping to the next line, then fades out once the name lands.
 * Reduced motion leaves everything at its static CSS state.
 */
export function animateNameplate(reducedMotion: boolean): void {
  const mount = document.querySelector<HTMLElement>('.hero__nameplate');
  if (!mount) return;

  if (reducedMotion) {
    mount.classList.add('is-static');
    return;
  }

  const frontCells = gsap.utils.toArray<HTMLElement>('.hero__nameplate .is-front .nameplate__cell.is-on');
  const echoes = gsap.utils.toArray<HTMLElement>('.hero__nameplate .nameplate__grid.is-echo');
  const glyphs = gsap.utils.toArray<HTMLElement>('.hero__nameplate .nameplate__glyph');
  const caret = mount.querySelector<HTMLElement>('.nameplate__caret');
  if (frontCells.length === 0 || !caret || glyphs.length === 0) {
    mount.classList.add('is-done');
    return;
  }

  // Reveal the solid blocks column-by-column, left to right.
  gsap.set(frontCells, { opacity: 0, scale: 0.4 });
  gsap.to(frontCells, {
    opacity: 1,
    scale: 1,
    duration: CELL_DUR,
    ease: 'back.out(1.7)',
    delay: START_DELAY,
    stagger: (_i, el) => Number(el.style.getPropertyValue('--col')) * COL_STEP,
  });
  gsap.set(echoes, { opacity: 0 });

  // Measured letter positions (relative to the position:relative mount) + the
  // time each letter starts writing — so the caret arrives exactly on cue.
  const stops = glyphs.map((g, i) => ({
    x: g.offsetLeft,
    y: g.offsetTop,
    w: g.offsetWidth,
    t: Number(g.dataset.startCol) * COL_STEP,
    echo: echoes[i],
  }));

  const tl = gsap.timeline({
    delay: START_DELAY,
    onComplete: () => {
      // Fully remove the caret (not just hide) so a stale absolute position
      // can't contribute to layout/overflow after a resize.
      gsap.to(caret, {
        autoAlpha: 0,
        duration: 0.2,
        onComplete: () => {
          caret.style.display = 'none';
        },
      });
      mount.classList.add('is-done');
    },
  });
  tl.set(caret, { x: stops[0].x, y: stops[0].y, autoAlpha: 1 }, 0);
  stops.forEach((s, i) => {
    tl.to(s.echo, { opacity: 1, duration: 0.18, ease: 'none' }, s.t);
    if (i > 0) {
      tl.to(
        caret,
        { x: s.x, y: s.y, duration: s.t - stops[i - 1].t, ease: 'none' },
        stops[i - 1].t,
      );
    }
  });
  // Settle the caret just past the final letter before handing off.
  const last = stops[stops.length - 1];
  tl.to(caret, { x: last.x + last.w, y: last.y, duration: 0.14, ease: 'power1.out' }, last.t);
}

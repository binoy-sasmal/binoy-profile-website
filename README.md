# binoysasmal.tech

Personal portfolio of **Binoy Sasmal** — AI / Software Engineer.

> Useful AI, built with foresight.

One persistent field of **10,000 GPU-simulated particles** carries the whole site: it opens
as a portrait, dissolves into raw scatter, reassembles into the marks of the places I've
worked, becomes a graph for systems work, a brain for skills, and a globe for contact.
In the hero, the real photograph resolves only under a cursor lens — *the model becomes
legible exactly where attention lands.*

**Live:** [binoysasmal.tech](https://binoysasmal.tech)

## How it works

- **Particle engine** — three.js GPGPU: two ping-pong FBO passes (position + spring
  physics) drive an `InstancedMesh` of low-poly pyramids. Per-particle position, colour,
  and scale are read from baked data-map textures, never computed in JS.
- **Morphing** — each 200×200 EXR atlas packs four shapes as 100×100 quadrants; a
  `u_progress` uniform blends between quadrants with per-particle stagger while the spring
  sim chases the blend. Nine shapes chain across three atlases, swapped only while the
  field rests on a shape shared by both — so the swap is invisible.
- **Offline bake** — the atlases are generated ahead of time from silhouette and
  procedural sources: ink-weighted sampling, surface-area edge densification,
  distance-transform depth relief, Hilbert-curve rank pairing (so particle *i* travels
  coherently between shapes instead of scrambling), and a stratified slot permutation that
  keeps the mobile 7k subset spatially uniform. The browser only ever loads the small
  baked textures in `public/maps/`.
- **Hero lens** — a DOM layer, decoupled from WebGL: the photo sits under a feathered
  radial mask that trails the pointer, positioned each frame by projecting the particle
  field's bounding box through the camera, so photo and particles stay registered exactly.
- **Projects deck** — four cards fan out across a 400vh sticky runway while flipping
  back→front, every transform derived from a Lenis-damped scroll position.
- **Scroll** — Lenis-smoothed and strictly scroll-bound (the user owns the pace). Reduced
  motion gets settled shapes, static copy, and a visible photo toggle — no hover required
  anywhere.

## Stack

Vite · TypeScript (no framework) · three.js 0.135 (pinned) · GSAP · Lenis ·
self-hosted Space Grotesk + JetBrains Mono.

three.js is **pinned to 0.135** deliberately: newer releases default to sRGB output, which
gamma-shifts the raw-sampled colour maps the engine reads.

## Development

```bash
npm install
npm run dev        # site at http://localhost:5173
npm run build      # typecheck + production build
npm run preview    # serve the production build locally
```

## Repository map

```
src/engine/   GPGPU particle engine (renderer, cloud, post chain, shaders)
src/morph/    atlas chain + scroll driver (section -> shape mapping)
src/hero/     cursor-reveal lens + terminal-block nameplate
src/projects/ the scroll-driven card deck
src/motion/   scroll-triggered content reveals
src/styles/   design tokens + layouts
public/maps/  the baked particle atlases the site ships
```

## Deployment

Built by GitHub Actions and published to GitHub Pages on every push to `main`
(`.github/workflows/deploy.yml`), served from the apex domain via `public/CNAME`.

© 2026 Binoy Sasmal · Kaiserslautern, Germany

// Scroll-triggered content reveals (the DOM half of the polish pass): each
// section's children rise+fade in as the section enters the viewport,
// staggered. Block-level (no line splitting), transform+opacity only
//, IntersectionObserver-driven, one-shot. Reduced motion or
// no-JS: content is simply visible (initial hidden state comes from JS).
import gsap from 'gsap';

const REVEAL_SELECTOR = [
  '.section .eyebrow',
  '.section .display',
  '.section .about__body',
  '.section .role',
  '.section .org__name',
  // NOTE: the Projects section is deliberately absent. Its title, subheader and
  // cards are driven frame-by-frame by projects/deck.ts; a GSAP reveal writing
  // transform/opacity to the same nodes would fight it every frame.
  '.section .skills__group',
  '.section .contact__headline',
  '.section .contact__inner > p',
  '.section .contact__actions',
].join(', ');

export function initReveals(reducedMotion: boolean) {
  if (reducedMotion) return;
  const items = Array.from(document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR));
  if (items.length === 0) return;

  gsap.set(items, { y: 18, opacity: 0 });

  const io = new IntersectionObserver(
    (entries) => {
      // batch what became visible this tick so siblings stagger together
      const shown = entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement);
      if (shown.length === 0) return;
      shown.forEach((el) => io.unobserve(el));
      gsap.to(shown, {
        y: 0,
        opacity: 1,
        duration: 0.8,
        ease: 'power3.out',
        stagger: 0.07,
        overwrite: true,
      });
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.05 }
  );
  items.forEach((el) => io.observe(el));
}

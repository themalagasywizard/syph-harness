---
name: frontend-design
description: Build agency-grade, high-conversion landing pages, marketing sites, and web UIs for any business or product. Use for all frontend, website, landing page, and visual UI tasks.
---

# Universal High-Craft Frontend Design System

Follow this workflow for every website, landing page, or frontend UI task. Keep execution token-efficient: plan once, generate only 3–5 purposeful studio visuals, write each file cleanly in a single pass, then verify.

## 1. Establish Brand Direction & Reference Audit (Before Coding)
- If the user gives a reference URL or brand, inspect its layout rhythm, value propositions, trust signals, and interactive hooks first. Never copy a competitor's brand name, logos, or copy — invent a sharp, original brand identity tailored to the target business.
- Choose a domain-authentic palette (never generic purple-on-white SaaS clichés):
  - **1 Primary Brand Accent** + darker hover + soft tint (`--brand`, `--brand-dark`, `--brand-soft`, `--brand-tint`).
  - **1 High-Contrast Conversion CTA Color** (`--cta`, `--cta-dark`) reserved strictly for primary booking/buy/signup buttons.
  - **Editorial Surface Cadence:** Alternate crisp light surfaces (`#FFFFFF` and `#F7F9FB`) with deep high-contrast dark anchors (`#060F1D` → `#0D1E38` midnight navy or charcoal ink `#101216`) for the hero, social-proof showcase, and pre-footer CTA banner.
- Choose an intentional **2-font pairing** via Google Fonts (`display` + `sans`):
  - Local trades / automotive / sports / energy: condensed display (`Oswald` italic uppercase for H1/H2/KPIs) + `Inter`.
  - SaaS / fintech / AI / B2B: geometric grotesk (`Space Grotesk` or `Plus Jakarta Sans`, tight tracking `-0.03em`) + `Inter`.
  - Hospitality / wellness / luxury / real estate / editorial: refined serif (`Fraunces` or `Cormorant Garamond`) + `Plus Jakarta Sans`.

## 2. Studio Imagery & Visual Rules (Keep Cost Lean)
- When `generate_image` is available, generate **3–5 bespoke studio images max** saved to `assets/img/`:
  1. **Hero background (16:9):** Moody editorial photography with uncluttered dark-toned negative space behind the headline so white + accent display typography pops effortlessly.
  2. **2–4 Key service / product shots (4:3):** Clean commercial studio photography on seamless light or soft-gradient backdrops (`#F3F5F8` or pastel studio sweep), zero text, zero watermarks, zero fake logos.
- **Strict Visual Law:** NEVER ask an image generator to render small UI text, app screenshots, pricing cards, or phone screens. Build device mockups (e.g. 3D angled CSS smartphones, dashboards, VIP cards, badges, road signs, technical schematics) in crisp layered HTML/CSS + inline SVG.
- Never replace real photography with ugly raw CSS-gradient boxes or crude hand-drawn SVG scenes.

## 3. Above-the-Fold & High-Conversion Architecture
Build a clean static stack (`index.html`, `assets/css/styles.css`, `assets/js/main.js`, `assets/img/favicon.svg`) unless the user explicitly asks for React/Next.js/Tailwind. Include:
1. **Scroll-Adaptive Sticky Header:** Transparent over the dark hero, transitioning smoothly on scroll (`> 56px`) to frosted glass (`backdrop-filter: blur(18px)`) with a slim top accent announcement bar, categorized dropdown menu (links jump directly to sections/slides), phone/contact quick action, primary CTA button, and responsive mobile drawer.
2. **Full-Viewport Hero + Immediate Interactive Hook:** Full-bleed photo with cinematic radial + vertical vignette, eyebrow trust pill, bold display `H1`, crisp 1-line subtitle, primary CTA, and an **embedded dark-glass interactive widget** suited to the business (e.g. 2-tab location/map + eligibility/insurance selector, interactive ROI/price estimator, instant quote/booking widget, or live product demo switcher). Always include an offline-safe vector fallback if embedding an external map (Leaflet/OSM).
3. **Interactive Split-Feature Showcase Carousel:** Framed rounded card (`1.5px` crisp dark-ink border, `border-radius: 22px`, ambient elevation) split ~58/42:
   - Left: studio photography + floating dark-glass credential pill + optional animated pulsing hotspot dot.
   - Right: colored top accent bar (`4px`), uppercase eyebrow, single-line counter pill (`N°01 / 06`), bold display title, mini technical schematic or metric box, concise copy, 3 crisp checkmark bullets, and dual CTAs.
   - Circular accent `<` `>` arrows straddling the outer card border + clickable quick-jump pill tabs underneath.
   - **Mandatory CSS Clearance:** Wrap carousels in `.carousel-wrap { padding: 0 30px; }` with arrows at `left: 6px; right: 6px;` and right-panel padding `>= 36px` so arrows **never** overlap card text on any viewport.
4. **Unified 4-Column Bento Value Card:** Single framed container split by subtle hairlines into 4 KPI columns (`01`–`04`), with 1 visually elevated featured highlight column (soft tinted gradient fill, colored top border, pulsing live status pill).
5. **Offers / Pricing / Tiers + Live Urgency or Toggle:** Dedicated section for offers, pricing tiers, or packages (interactive toggle or secondary split carousel + live countdown or savings calculator) followed by a subtle monochrome trust/partner logo marquee with CSS edge fade masks (`mask-image: linear-gradient(...)`) that pauses on hover.
6. **Dark-Surface Social Proof Banner + Customer Stories Marquee:** Deep navy/charcoal rounded showcase combining:
   - Floating white rating trust card (e.g. `4,9/5` Google/Trustpilot with crisp SVG stars),
   - Centered editorial headline,
   - Pure-CSS 3D angled device/review preview mockup on the right,
   - Followed by a smooth infinite horizontal marquee of bordered story/testimonial cards with colored top accent strips and mini vector diagrams.
7. **Pre-Footer Dark CTA Banner + Local/Category Pill Marquee + Architectural Footer:** High-contrast closing CTA strip, regional/category badge strip, and a clean multi-column footer with a subtle oversized brand watermark on the right.
8. **Pre-Filled Multi-Step Conversion Modal:** Every CTA opens a clean 3-to-5-step modal (progress bar, visual choice cards, date/slot or plan picker, real input validation, summary recap, and animated confirmation with reference ID) pre-filled with whatever service, offer, or location the user clicked.

## 4. Micro-Polish & Token-Efficiency Checklist
- **Write complete files in 1 pass per file** (`styles.css` → `index.html` → `main.js`) to minimize turn count and token spend.
- Enforce `white-space: nowrap; flex-shrink: 0;` on all counters, live pills, and status chips so badges never awkwardly wrap.
- Add `font-variant-numeric: tabular-nums` to all KPIs, prices, counters, and countdowns.
- Include responsive breakpoints (`1120px`, `960px`, `640px`), scroll-reveal animations (`IntersectionObserver`), `prefers-reduced-motion` support, and keyboard accessibility (`Escape` closes modals/menus, `aria-expanded`/`aria-selected`).
- Verify every local image path exists, zero console errors, no horizontal overflow, and clean contrast before reporting done. When the in-app browser tools are available (`browser_open`, `browser_inspect`, `browser_screenshot`), open your local preview URL (e.g. `http://localhost:...`), inspect for broken images/overflow/console errors, take 1 screenshot for visual QA, and polish any overlap or clipping before finishing.

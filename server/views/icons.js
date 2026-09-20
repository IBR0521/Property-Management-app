/* Inline SVG icon set. Inline rather than a sprite or a font so the app makes
   no extra requests and icons inherit currentColor. Stroke geometry matches
   the marketing site's icons: 24-box, round caps, 1.8 weight. */
import { raw } from "../lib/render.js";

const svg = (body, w = 24) =>
  raw(`<svg viewBox="0 0 ${w} ${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`);

export const icons = {
  logo: raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>`),
  dashboard: svg(`<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 8h6V4h-6z"/>`),
  wrench: svg(`<path d="M14.5 5.5a3.5 3.5 0 0 0 4.95 4.95l-9.9 9.9a2.5 2.5 0 0 1-3.54-3.54Z"/><path d="m16 3 5 5"/>`),
  users: svg(`<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.2"/><path d="M17 4.5a3.2 3.2 0 0 1 0 6"/><path d="M22 19v-1a4 4 0 0 0-3-3.87"/>`),
  shield: svg(`<path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6z"/><path d="m9 12 2 2 4-4"/>`),
  cash: svg(`<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>`),
  loop: svg(`<path d="M3 11a8 8 0 0 1 13.4-5.9L20 8"/><path d="M20 4v4h-4"/><path d="M21 13a8 8 0 0 1-13.4 5.9L4 16"/><path d="M4 20v-4h4"/>`),
  inbox: svg(`<path d="M4 13 6 5h12l2 8"/><path d="M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/><path d="M4 13h4l1 2h6l1-2h4"/>`),
  cog: svg(`<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 7l1.9 1.1M17.9 15.9l1.9 1.1M4.2 17l1.9-1.1M17.9 8.1l1.9-1.1"/>`),
  phone: svg(`<path d="M6.5 3h-2A1.5 1.5 0 0 0 3 4.6C3 12.5 11.5 21 19.4 21A1.5 1.5 0 0 0 21 19.5v-2a1.5 1.5 0 0 0-1.2-1.47l-2.6-.52a1.5 1.5 0 0 0-1.5.62l-.7 1a15 15 0 0 1-6.13-6.13l1-.7a1.5 1.5 0 0 0 .62-1.5l-.52-2.6A1.5 1.5 0 0 0 6.5 3Z"/>`),
  alert: svg(`<path d="M12 4 2.8 20h18.4z"/><path d="M12 10v4.5"/><path d="M12 17.4h.01"/>`),
  check: svg(`<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>`),
  clock: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`),
  home: svg(`<path d="M4 10.5 12 4l8 6.5"/><path d="M6.5 9.2V20h11V9.2"/><path d="M10.5 20v-5h3v5"/>`),
  doc: svg(`<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>`),
  camera: svg(`<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="12.5" r="3.2"/>`),
  send: svg(`<path d="M21 3 3 10.5l6.5 2.5L12 20z"/><path d="M21 3 9.5 13"/>`),
  back: svg(`<path d="M19 12H5M11 6l-6 6 6 6"/>`),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  key: svg(`<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 3-9.5 9.5"/><path d="m15.5 8.5 3 3L21 9l-3-3"/>`),
  out: svg(`<path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>`),
};

export const navIcon = (k) => icons[k] || icons.dashboard;

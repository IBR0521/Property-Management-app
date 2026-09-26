/* Landing behaviour: the loading curtain, the type reveals, smooth scroll,
   the start dialog, and the menu. */
import Lenis from "lenis";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const html = document.documentElement;

/* Above 1920px the CSS clamp stops scaling, so grow the root size by hand to
   keep the layout proportional on very wide screens. */
const FONT_BASE = 16, BASE_W = 1920, COEF = 0.6666;
function applyScale(){
  const reduction = ((BASE_W - window.innerWidth) / BASE_W) * 100 * COEF;
  const size = FONT_BASE - (FONT_BASE * reduction) / 100;
  if (size > FONT_BASE) html.style.fontSize = size + "px";
  else html.style.removeProperty("font-size");
}
applyScale();
window.addEventListener("resize", applyScale);

const lenis = new Lenis({ smoothWheel: true });
(function raf(t){ lenis.raf(t); requestAnimationFrame(raf); })();
window.scrollTo(0, 0);

const lockScroll = () => { lenis.stop(); html.classList.add("lock"); };
const unlockScroll = () => { lenis.start(); html.classList.remove("lock"); };

/* Wrap every word in its own overflow-hidden clip so each can slide up
   independently. Cached on the element: replaying must not re-split. */
function splitWords(el){
  const words = el.textContent.split(" ");
  el.textContent = "";
  const spans = [];
  words.forEach((word, i) => {
    const clip = document.createElement("span");
    clip.className = "clip";
    const inner = document.createElement("span");
    inner.textContent = word;
    clip.appendChild(inner);
    el.appendChild(clip);
    spans.push(clip);
    if (i < words.length - 1) el.appendChild(document.createTextNode(" "));
  });
  return spans;
}

function playWords(el){
  if (!el) return;
  const stagger = parseInt(el.getAttribute("data-stagger") || "140", 10);
  const dur = parseInt(el.getAttribute("data-dur") || "1100", 10);
  const spans = el._wordSpans || (el._wordSpans = splitWords(el));
  spans.forEach((clip, i) => {
    const inner = clip.firstChild;
    inner.style.transitionDuration = (reduce ? 200 : dur) + "ms";
    inner.style.transitionDelay = (reduce ? 0 : i * stagger) + "ms";
    clip.classList.add("in");
  });
}

function playLines(el){
  if (!el) return;
  const stagger = parseInt(el.getAttribute("data-stagger") || "120", 10);
  const base = parseInt(el.getAttribute("data-basedelay") || "0", 10);
  const dur = parseInt(el.getAttribute("data-dur") || "950", 10);
  el.querySelectorAll(".line > span").forEach((line, i) => {
    line.style.transitionDuration = (reduce ? 200 : dur) + "ms";
    line.style.transitionDelay = (reduce ? 0 : base + i * stagger) + "ms";
  });
  el.classList.add("in");
}

const iv = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    const el = e.target;
    el.style.transitionDelay = (reduce ? 0 : parseInt(el.getAttribute("data-delay") || "0", 10)) + "ms";
    el.classList.add("in");
    iv.unobserve(el);
  });
}, { threshold: 0.15 });
document.querySelectorAll("[data-iv]").forEach((el) => iv.observe(el));

const lineIO = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting){ playLines(e.target); lineIO.unobserve(e.target); } });
}, { threshold: 0.2 });
document.querySelectorAll("[data-lines]:not([data-gate])").forEach((el) => lineIO.observe(el));

document.querySelectorAll("[data-scroll]").forEach((a) => {
  a.addEventListener("click", (ev) => {
    const id = a.getAttribute("href");
    if (!id || id.charAt(0) !== "#") return;
    const target = document.querySelector(id);
    if (!target) return;
    ev.preventDefault();
    lenis.scrollTo(target, { offset: -10 });
  });
});

const modal = document.querySelector("[data-modal]");
const modalForm = document.querySelector("[data-modal-form]");
let modalTitleFired = false;

function openModal(){
  modal.classList.add("open");
  lockScroll();
  const title = modal.querySelector("[data-lines]");
  if (title && !modalTitleFired){
    modalTitleFired = true;
    title.classList.remove("in");
    setTimeout(() => playLines(title), 160);
  }
  setTimeout(() => { const n = document.getElementById("mf-name"); if (n) n.focus(); }, 120);
}

function closeModal(){
  modal.classList.remove("open");
  unlockScroll();
  setTimeout(() => { if (modalForm) modalForm.reset(); }, 350);
}

document.querySelectorAll("[data-open-modal]").forEach((b) => b.addEventListener("click", openModal));
document.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", closeModal));

modalForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const params = new URLSearchParams(new FormData(modalForm));
  window.location.href = "/signup?" + params.toString();
});

const menu = document.querySelector("[data-menu]");
const openMenu = () => { if (menu){ menu.classList.add("open"); lockScroll(); } };
const closeMenu = () => { if (menu){ menu.classList.remove("open"); unlockScroll(); } };

document.querySelectorAll("[data-open-menu]").forEach((b) => b.addEventListener("click", openMenu));
document.querySelectorAll("[data-menu-close]").forEach((b) => b.addEventListener("click", closeMenu));
document.querySelectorAll("[data-menu-link]").forEach((a) => {
  a.addEventListener("click", () => setTimeout(closeMenu, 60));
});

const menuBook = document.querySelector("[data-menu-book]");
if (menuBook) menuBook.addEventListener("click", () => { closeMenu(); setTimeout(openModal, 260); });

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modal.classList.contains("open")) closeModal();
  else if (menu.classList.contains("open")) closeMenu();
});

function startHero(){
  playWords(document.getElementById("hero-title"));
  playLines(document.getElementById("hero-tagline"));
}

const loader = document.querySelector("[data-loader]");

if (!loader){
  startHero();
} else {
  const FILL_MS = 1400;
  const MIN_VISIBLE_MS = reduce ? 200 : FILL_MS;
  const MAX_VISIBLE_MS = 3200;
  const EXIT_MS = reduce ? 0 : 850;

  const T0 = performance.now ? performance.now() : Date.now();
  const since = () => (performance.now ? performance.now() : Date.now()) - T0;

  lockScroll();
  requestAnimationFrame(() => loader.classList.add("ready", "fillon"));

  let revealed = false;
  function reveal(){
    if (revealed) return;
    revealed = true;
    loader.classList.add("done");
    unlockScroll();
    startHero();
    setTimeout(() => { if (loader.parentNode) loader.parentNode.removeChild(loader); }, EXIT_MS + 50);
  }

  const startCountdown = () => setTimeout(reveal, Math.max(0, MIN_VISIBLE_MS - since()));
  if (document.readyState === "complete") startCountdown();
  else window.addEventListener("load", startCountdown);

  setTimeout(reveal, MAX_VISIBLE_MS);
}

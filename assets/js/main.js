/* ==========================================================================
   Quick Property Buyer — behaviour
   --------------------------------------------------------------------------
   Loading curtain, scroll-triggered type reveals, hero parallax, the two
   carousels, the booking modal and the full-screen menu.
   ========================================================================== */
import Lenis from "lenis";

/* --- image pool ----------------------------------------------------------- */
const IMGS = [
  "https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=1600&q=70",
  "https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=1600&q=70",
  "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1600&q=70",
  "https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1600&q=70",
  "https://images.unsplash.com/photo-1580587771525-78b9dba3b914?auto=format&fit=crop&w=1600&q=70",
  "https://images.unsplash.com/photo-1449844908441-8829872d2607?auto=format&fit=crop&w=1600&q=70",
];
const img = (i) => IMGS[((i % IMGS.length) + IMGS.length) % IMGS.length];

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const html = document.documentElement;

/* --- root font size ------------------------------------------------------- */
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

/* --- smooth scroll -------------------------------------------------------- */
const lenis = new Lenis({ smoothWheel: true });
(function raf(t){ lenis.raf(t); requestAnimationFrame(raf); })();
window.scrollTo(0, 0);

const lockScroll = () => { lenis.stop(); html.classList.add("lock"); };
const unlockScroll = () => { lenis.start(); html.classList.remove("lock"); };

/* ==========================================================================
   Type reveals
   ========================================================================== */

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

/* Body copy fades in word by word. Runs once per element. */
function playWordFade(el){
  if (el._done) return;
  el._done = true;
  const stagger = parseInt(el.getAttribute("data-stagger") || "28", 10);
  const delay = parseInt(el.getAttribute("data-delay") || "0", 10);
  const words = el.textContent.split(" ");
  el.textContent = "";
  words.forEach((word, i) => {
    const w = document.createElement("span");
    w.className = "wf";
    w.textContent = word;
    w.style.transitionDelay = (reduce ? 0 : delay + i * stagger) + "ms";
    el.appendChild(w);
    if (i < words.length - 1) el.appendChild(document.createTextNode(" "));
    requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add("in")));
  });
}

/* --- observers ------------------------------------------------------------ */
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

const wfIO = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting){ playWordFade(e.target); wfIO.unobserve(e.target); } });
}, { threshold: 0.2 });
document.querySelectorAll("[data-wordfade]").forEach((el) => wfIO.observe(el));

const ghostIO = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.firstChild.style.transitionDuration = (reduce ? 200 : 700) + "ms";
    e.target.classList.add("in");
    ghostIO.unobserve(e.target);
  });
}, { threshold: 0.2 });
document.querySelectorAll("#trust-title .clip").forEach((el) => ghostIO.observe(el));

/* ==========================================================================
   Parallax
   ========================================================================== */
const plate = document.querySelector("[data-hero-plate]");
const heroSection = document.querySelector(".hero");
const trustSection = document.querySelector(".trust");
const ghostClips = document.querySelectorAll("#trust-title .clip");

/* 0 when the section's top edge is at the bottom of the viewport, 1 once its
   bottom edge has passed the top. */
function sectionProgress(sec){
  const r = sec.getBoundingClientRect();
  return Math.max(0, Math.min(1, (window.innerHeight - r.top) / (window.innerHeight + r.height)));
}

(function parallaxLoop(){
  if (!reduce){
    if (plate && heroSection){
      plate.style.transform = "translateY(" + (sectionProgress(heroSection) * 12) + "%)";
    }
    if (trustSection && ghostClips.length){
      const g = sectionProgress(trustSection);
      ghostClips.forEach((clip) => {
        const [from, to] = (clip.getAttribute("data-gx") || "0,0").split(",").map(parseFloat);
        clip.style.transform = "translateX(" + (from + (to - from) * g) + "%)";
      });
    }
  }
  requestAnimationFrame(parallaxLoop);
})();

/* --- anchor links --------------------------------------------------------- */
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

/* ==========================================================================
   Hero "what's on" carousel
   ========================================================================== */
const collSlides = [
  { img: img(1), brand: "This Week", title: "What's On", cta: "See more" },
  { img: img(2), brand: "Just In", title: "New & Notable", cta: "Take a look" },
  { img: img(4), brand: "Popular", title: "Local Favorites", cta: "Explore" },
];
const collCard = document.querySelector("[data-coll-card]");
const collImg = document.querySelector("[data-coll-img]");
const collBrand = document.querySelector("[data-coll-brand]");
const collTitle = document.querySelector("[data-coll-title]");
const collCta = document.querySelector("[data-coll-cta]");
const collDots = document.querySelector("[data-coll-dots]");
let collIndex = 0, collTimer = null;

function renderDots(host, count, active, onPick){
  host.innerHTML = "";
  for (let i = 0; i < count; i++){
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Go to slide " + (i + 1));
    if (i === active){ b.className = "active"; b.setAttribute("aria-current", "true"); }
    const bar = document.createElement("span");
    bar.className = "bar";
    b.appendChild(bar);
    b.addEventListener("click", () => onPick(i));
    host.appendChild(b);
  }
}

function collPaint(){
  const s = collSlides[collIndex];
  collImg.src = s.img;
  collBrand.textContent = s.brand;
  collTitle.textContent = s.title;
  collCta.innerHTML = s.cta + " &rarr;";
  renderDots(collDots, collSlides.length, collIndex, collGo);
}

function collGo(idx){
  collIndex = (idx + collSlides.length) % collSlides.length;
  if (reduce){ collPaint(); return; }
  collCard.style.opacity = "0";
  collCard.style.transform = "translateY(16px) scale(0.96)";
  setTimeout(() => {
    collPaint();
    collCard.style.opacity = "1";
    collCard.style.transform = "none";
  }, 260);
}

function collStart(){
  if (collTimer) return;
  collTimer = setInterval(() => collGo(collIndex + 1), 3800);
}
renderDots(collDots, collSlides.length, collIndex, collGo);

/* ==========================================================================
   Trust card carousel
   --------------------------------------------------------------------------
   Each slide also swaps the four oversized ghost words behind the card.
   ========================================================================== */
const coachSlides = [
  { img: img(4), nm: "Our Team", rl: "Here to Help", h: ["People","Care","First","Always"] },
  { img: img(3), nm: "Friendly Faces", rl: "Always Around", h: ["Warm","Real","Welcome","People"] },
  { img: img(0), nm: "The Crew", rl: "Behind It All", h: ["Local","Every","& Proud","Visit"] },
];
const coachImg = document.querySelector("[data-coach-img]");
const coachNm = document.querySelector("[data-coach-nm]");
const coachRl = document.querySelector("[data-coach-rl]");
const coachDots = document.querySelector("[data-coach-dots]");
const coachEl = document.getElementById("coach");
const coachFig = coachImg.parentNode;
let coachIndex = 0, coachBusy = false;
const COACH_OUT = 96;

/* Retext the ghost headline and replay its reveal from the top. */
function refireGhost(words){
  const clips = document.querySelectorAll("#trust-title .clip");
  clips.forEach((clip, i) => {
    clip.firstChild.textContent = words[i];
    clip.classList.remove("in");
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clips.forEach((clip, j) => {
      clip.firstChild.style.transitionDelay = (reduce ? 0 : j * 70) + "ms";
      clip.classList.add("in");
    });
  }));
}

/* dir is the way the card LEAVES: +1 exits right (the next arrow), -1 exits
   left. The incoming card always enters from the opposite edge, and the jump
   across is untweened so only the two visible halves animate. */
function coachGo(idx, dir){
  const d = dir < 0 ? -1 : 1;
  coachIndex = (idx + coachSlides.length) % coachSlides.length;
  const s = coachSlides[coachIndex];

  refireGhost(s.h);
  renderDots(coachDots, coachSlides.length, coachIndex, (i) => coachGo(i, i > coachIndex ? 1 : -1));

  if (reduce){ setCoachSlide(s); return; }

  coachBusy = true;
  coachEl.classList.add("swap");
  coachFig.style.setProperty("--cx", (d * COACH_OUT) + "px");
  coachFig.style.setProperty("--co", "0");

  setTimeout(() => {
    setCoachSlide(s);
    coachEl.classList.remove("swap");
    coachEl.classList.add("jump");
    coachFig.style.setProperty("--cx", (-d * COACH_OUT) + "px");
    void coachFig.offsetWidth;           // flush the untweened reposition
    coachEl.classList.remove("jump");
    coachFig.style.setProperty("--cx", "0px");
    coachFig.style.setProperty("--co", "1");
    coachBusy = false;
  }, 260);
}

function setCoachSlide(s){
  coachImg.src = s.img;
  coachNm.textContent = s.nm;
  coachRl.textContent = s.rl;
}

renderDots(coachDots, coachSlides.length, coachIndex, (i) => coachGo(i, i > coachIndex ? 1 : -1));

const coachPrev = document.querySelector("[data-coach-prev]");
if (coachPrev) coachPrev.addEventListener("click", () => { if (!coachBusy) coachGo(coachIndex - 1, -1); });
const coachNext = document.querySelector("[data-coach-next]");
if (coachNext) coachNext.addEventListener("click", () => { if (!coachBusy) coachGo(coachIndex + 1, 1); });

/* ==========================================================================
   Booking modal
   ========================================================================== */
const modal = document.querySelector("[data-modal]");
const modalForm = document.querySelector("[data-modal-form]");
const modalSuccess = document.querySelector("[data-modal-success]");
const modalSubmit = document.querySelector("[data-modal-submit]");
let modalTitleFired = false;

function openModal(){
  modal.classList.add("open");
  lockScroll();
  if (!modalTitleFired){
    modalTitleFired = true;
    setTimeout(() => playLines(modal.querySelector("[data-lines]")), 120);
  }
  setTimeout(() => { const n = document.getElementById("mf-name"); if (n) n.focus(); }, 120);
}

function closeModal(){
  modal.classList.remove("open");
  unlockScroll();
  // Reset behind the exit transition so the panel never visibly snaps back.
  setTimeout(() => {
    modalForm.classList.remove("hide");
    modalSuccess.classList.add("hide");
    modalForm.reset();
    modalSubmit.textContent = "Request a visit";
    modalSubmit.disabled = false;
  }, 350);
}

document.querySelectorAll("[data-open-modal]").forEach((b) => b.addEventListener("click", openModal));
document.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", closeModal));

modalForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  modalSubmit.textContent = "Sending...";
  modalSubmit.disabled = true;

  const name = (document.getElementById("mf-name").value || "").trim();
  const first = name ? name.split(" ")[0] : "there";

  function done(){
    document.querySelector("[data-success-msg]").textContent =
      "Thanks, " + first + " - our team will be in touch to lock in your visit.";
    modalForm.classList.add("hide");
    modalSuccess.classList.remove("hide");
  }

  // Anything that stops the fetch falls back to a native submit, which posts
  // to the same endpoint, so an enquiry is never dropped quietly behind a
  // success panel that had no request behind it.
  try {
    fetch(modalForm.action, { method: "POST", body: new FormData(modalForm) })
      .then((r) => { if (!r || !r.ok) throw new Error("send failed"); done(); })
      .catch(() => modalForm.submit());
  } catch (e) {
    modalForm.submit();
  }
});

/* ==========================================================================
   Full-screen menu
   ========================================================================== */
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

/* ==========================================================================
   Loading curtain
   --------------------------------------------------------------------------
   The hero type is gated behind the curtain lifting, so the reveal has to run
   from here whether or not the curtain exists.
   ========================================================================== */
function startHero(){
  playWords(document.getElementById("hero-title"));
  playLines(document.getElementById("hero-tagline"));
  collStart();
}

const loader = document.querySelector("[data-loader]");

if (!loader){
  startHero();
} else {
  // The progress bar is a 1.28s transition after a 0.12s delay, so it is
  // visually complete 1.4s after "fillon" goes on. Leaving earlier clips the
  // bar mid-fill; staying longer parks a full bar on screen doing nothing.
  const FILL_MS = 1400;
  const MIN_VISIBLE_MS = reduce ? 200 : FILL_MS;
  const MAX_VISIBLE_MS = 3200;
  const EXIT_MS = reduce ? 0 : 850;

  // One clock for everything. Measuring the minimum from "load" while the
  // safety cap counts from script start makes the two race, and the curtain
  // gets yanked away mid-fill by whichever lands first.
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

  // Wait out whatever is left of the bar, not a fresh full countdown: a page
  // that took longer than the bar to load reveals at once.
  const startCountdown = () => setTimeout(reveal, Math.max(0, MIN_VISIBLE_MS - since()));
  if (document.readyState === "complete") startCountdown();
  else window.addEventListener("load", startCountdown);

  setTimeout(reveal, MAX_VISIBLE_MS);   // last resort
}

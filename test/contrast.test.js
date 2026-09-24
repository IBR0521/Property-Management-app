/* Colour contrast.

   The application is mostly dense tables of money read by people who do this
   all day, and the secondary text — the `.cellsub` line under a name, the
   help text under a field — is where contrast quietly fails. It is set in
   grey at 0.75rem, which is 12px, which is where a ratio that looked fine in
   a heading becomes unreadable.

   WCAG 2.1 AA asks for 4.5:1 on normal text, 3:1 on text at 24px or 18.66px
   bold and over, and 3:1 on the boundary of a control you have to find. Those
   are the numbers asserted here, computed from the stylesheets rather than
   judged by eye.

   The pairs are listed by hand and that is deliberate. Deciding which colour
   sits on which is a reading of the cascade, and a regex that tried to work
   it out would be confidently wrong. Listing them makes the claim explicit
   and checkable. What is *not* left to hand is whether the tokens still
   exist: a pair naming a colour that has been renamed fails rather than
   quietly passing. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrast, tokensFrom, resolve } from "./helpers/contrast.js";

const css = [
  readFileSync(new URL("../assets/css/styles.css", import.meta.url), "utf8"),
  readFileSync(new URL("../app-assets/app.css", import.meta.url), "utf8"),
];
const tokens = tokensFrom(css);

/* [foreground, background, what it is, minimum] */
const NORMAL = 4.5;   // body text
const LARGE = 3;      // 24px, or 18.66px bold
const UI = 3;         // the edge of something you have to find

const PAIRS = [
  ["var(--ink)", "var(--background)", "body text", NORMAL],
  ["var(--ink)", "var(--surface-card)", "text on a panel", NORMAL],
  ["var(--ink-soft)", "var(--background)", "the .cellsub line under a name, at 12px", NORMAL],
  ["var(--ink-soft)", "var(--surface-card)", "help text under a field", NORMAL],
  ["var(--ink-soft)", "var(--surface)", "a panel foot, on the darker page background", NORMAL],
  ["var(--brand)", "var(--surface-card)", "a link in a table", NORMAL],
  ["var(--brand)", "var(--background)", "a link on the page", NORMAL],

  ["var(--warn)", "var(--warn-wash)", "a warning chip", NORMAL],
  ["var(--ok)", "var(--ok-wash)", "an ok chip", NORMAL],
  ["var(--danger)", "var(--danger-wash)", "a danger chip", NORMAL],

  ["#ffffff", "var(--brand-deep)", "the sidebar", NORMAL],
  ["#ffffff", "var(--brand)", "the current nav item", NORMAL],
  ["#ffffff", "var(--warn)", "a count badge", NORMAL],
  ["#ffffff", "var(--danger)", "a destructive button", NORMAL],
];

/* --- what does not pass, written down -------------------------------------

   These are measured failures, not oversights, and they are here rather than
   quietly left out of the list above. Each carries the ratio as it is today;
   the test fails if any of them gets *worse*, so the palette cannot drift
   further while nobody is looking.

   Fixing them means changing the palette, and that is a decision about how
   the product looks rather than a bug to be fixed in passing — so it belongs
   to whoever owns the design, and it is in the phase report as a decision
   waiting on them.

   What is left is the borders. Reaching 3:1 against white would take the
   hairline from #e6e8ec to around #8f96a3, turning every panel edge and every
   field outline from a whisper into a visible grey rule. That is a redesign,
   not a tweak. The mitigation today is that no control is identified by its
   border alone: fields carry labels, panels carry headings, and the focus
   state uses --brand-light with a 2px ring rather than the hairline.

   The secondary-text grey used to be here too. It was #717784, which came to
   4.49:1 on white against a 4.5 requirement — missing by a hundredth, at the
   12px size where it matters most. It is #6a7079 now, which clears 4.5:1 on
   white and on the page background both, and the three pairs that depend on
   it have moved up into the list above. */
const ACCEPTED = [
  ["var(--hairline)", "var(--surface-card)", "the edge of a panel", 1.22, UI,
    "decorative: a panel is identified by its heading, not its rule"],
  ["var(--ghost)", "var(--background)", "a disabled control's edge", 1.40, UI,
    "a disabled control is exempt from 1.4.11, and this is also used for dividers"],
];

describe("the tokens these claims are about still exist", () => {
  test("every colour named resolves to something readable", () => {
    const unresolved = [];
    for (const [fg, bg, what] of [...PAIRS, ...ACCEPTED]) {
      if (!resolve(fg, tokens)) unresolved.push(`${what}: ${fg}`);
      if (!resolve(bg, tokens)) unresolved.push(`${what}: ${bg}`);
    }
    assert.deepEqual(unresolved, [],
      `renamed or removed tokens — these pairs are no longer checking anything:\n${unresolved.join("\n")}`);
  });
});

describe("text", () => {
  for (const [fg, bg, what, min] of PAIRS) {
    test(`${what} reaches ${min}:1`, () => {
      const ratio = contrast(resolve(fg, tokens), resolve(bg, tokens));
      assert.ok(ratio >= min,
        `${what}: ${resolve(fg, tokens)} on ${resolve(bg, tokens)} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
    });
  }
});

describe("what does not pass, and has not got worse", () => {
  for (const [fg, bg, what, recorded, target, why] of ACCEPTED) {
    test(`${what} is still about ${recorded}:1 (${why})`, () => {
      const ratio = contrast(resolve(fg, tokens), resolve(bg, tokens));
      assert.ok(ratio >= recorded - 0.02,
        `${what} has got worse: ${ratio.toFixed(2)}:1, was ${recorded}:1`);
      /* And if somebody fixes it, this says so rather than passing silently
         on a number that is no longer the truth. */
      if (ratio >= target) {
        assert.fail(
          `${what} now reaches ${ratio.toFixed(2)}:1 and meets ${target}:1 — `
          + "move it into PAIRS and delete it from ACCEPTED");
      }
    });
  }
});

describe("the arithmetic itself", () => {
  /* The published anchors. If these drift the rest of the file is decoration. */
  test("black on white is 21:1", () => {
    assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
  });
  test("white on white is 1:1", () => {
    assert.equal(Math.round(contrast("#ffffff", "#ffffff")), 1);
  });
  test("#767676 on white is the documented 4.54:1 boundary", () => {
    assert.ok(Math.abs(contrast("#767676", "#ffffff") - 4.54) < 0.02);
  });
  test("it linearises, rather than comparing raw channel values", () => {
    /* Mid grey. The naive version gives about 2.2; the correct one 3.95. */
    assert.ok(Math.abs(contrast("#808080", "#ffffff") - 3.95) < 0.05);
  });
});

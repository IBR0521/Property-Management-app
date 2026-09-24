/* Which exported functions the suite actually reaches.

   Not line coverage — this counts *names*. Every `export function` in
   server/ is listed, and then every test file is read for references to it.
   A name nothing mentions is not necessarily dead, but it is certainly not
   asserted about, and the distinction between "we have 1,900 tests" and
   "every function is tested" is exactly this list. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walkDir(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

const srcFiles = [...walkDir("server"), ...walkDir("api")]
  .filter((p) => !p.includes("/migrations/"));
const testFiles = walkDir("test");
const testText = testFiles.map((p) => readFileSync(p, "utf8")).join("\n");
const srcText = srcFiles.map((p) => readFileSync(p, "utf8")).join("\n");

const EXPORT_RE = /export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)|export\s+const\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;

const exports_ = [];
for (const file of srcFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(EXPORT_RE)) {
    exports_.push({ file, name: m[1] || m[2] });
  }
}

const seen = new Map();
for (const e of exports_) if (!seen.has(e.name)) seen.set(e.name, e);

const untested = [];
for (const [name, e] of seen) {
  const re = new RegExp(`\\b${name}\\b`);
  if (!re.test(testText)) untested.push(e);
}

/* A name no test mentions, but which the application itself calls, is covered
   indirectly — every route is walked. One nothing calls at all is dead. */
const dead = [];
for (const e of untested) {
  const uses = (srcText.match(new RegExp(`\\b${e.name}\\b`, "g")) || []).length;
  if (uses <= 1) dead.push(e);
}

/* `registerX` is a route registrar. It is exercised by every request the walk
   makes, so counting it as untested would understate the suite by forty
   names and hide the ones that matter. */
const isRegistrar = (n) => /^register[A-Z]/.test(n);
const realUntested = untested.filter((e) => !isRegistrar(e.name));
const registrars = untested.filter((e) => isRegistrar(e.name));

console.log(`exported functions: ${seen.size}`);
console.log(`named in a test:    ${seen.size - untested.length}  (${
  ((seen.size - untested.length) / seen.size * 100).toFixed(1)}%)`);
console.log(`not named in any test: ${untested.length}`);
console.log(`  of those, referenced nowhere else in server/ (likely dead): ${dead.length}`);
console.log(`  route registrars (exercised by the walk): ${registrars.length}`);
console.log(`  everything else: ${realUntested.length}`);
console.log(`\ncovered by name or by the walk: ${
  ((seen.size - realUntested.length) / seen.size * 100).toFixed(1)}%`);

if (dead.length) {
  console.log("\n--- referenced nowhere else in server/ (candidates for deletion) ---");
  for (const e of dead.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  ${e.file.replace(/^server\//, "")}  ${e.name}`);
  }
}
if (realUntested.length) {
  console.log("\n--- not named in any test, not a registrar ---");
  for (const e of realUntested.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`  ${e.file.replace(/^server\//, "")}  ${e.name}`);
  }
}

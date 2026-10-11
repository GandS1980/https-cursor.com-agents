// End-to-end smoke test: builds nothing itself — run `npm run build` first.
// Serves dist/ with `vite preview`, drives the real UI in headless Chromium and checks the
// three headline features: dynamic beatgrids, multi-service crates with pre-analysis, cue loops.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 4173;
const APP_URL = `http://localhost:${PORT}/`;
const shots = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });

// Spawn vite itself (not via npx) so killing it really stops the server.
const server = spawn(process.execPath, [new URL("../node_modules/vite/bin/vite.js", import.meta.url).pathname, "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (code) => reject(new Error(`preview exited ${code}`)));
  setTimeout(() => reject(new Error("preview did not start")), 20_000);
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(APP_URL);

  // --- Streaming services: real ones explain the partner requirement ------------------------
  await page.click('[data-testid="connect-tidal"]');
  const tidalError = await page.locator(".service.error .service-error").first().textContent({ timeout: 5000 });
  check("TIDAL reports partner access requirement", /partner/i.test(tidalError ?? ""), tidalError?.slice(0, 60));

  // --- Two simultaneous logins → two crates, pre-analysed before loading ---------------------
  await page.click('[data-testid="connect-demo-electronic"]');
  await page.click('[data-testid="connect-demo-groove"]');
  await page.waitForFunction(() => document.querySelectorAll(".service.connected").length >= 3, null, { timeout: 15_000 });
  const crateNames = await page.locator(".crate").allTextContents();
  check("each logged-in service is its own crate", crateNames.some((c) => c.includes("Electronic")) && crateNames.some((c) => c.includes("Funk")), crateNames.join(" | "));

  await page.waitForFunction(() => {
    const cells = [...document.querySelectorAll("td.bpm-cell")];
    return cells.length >= 7 && cells.every((c) => /^\d/.test(c.textContent ?? ""));
  }, null, { timeout: 120_000 });
  const table = await page.$$eval("tbody tr", (rows) => rows.map((r) => ({
    title: r.querySelector(".title")?.textContent,
    bpm: r.querySelector(".bpm-cell")?.textContent,
    key: r.querySelector(".key-cell")?.textContent,
    camelot: r.querySelector(".camelot-cell")?.textContent,
  })));
  const byTitle = Object.fromEntries(table.map((r) => [r.title, r]));
  console.table(table);
  check("pre-analysis BPM/key shown before loading", byTitle["Warehouse Pressure"]?.bpm === "128.0" && byTitle["Warehouse Pressure"]?.key === "Am",
    `Warehouse ${byTitle["Warehouse Pressure"]?.bpm} ${byTitle["Warehouse Pressure"]?.key}`);
  check("drum & bass tempo detected", byTitle["Amen Theory"]?.bpm === "174.0", byTitle["Amen Theory"]?.bpm);
  check("variable-tempo tracks flagged with ~", (byTitle["Live Room Drift"]?.bpm ?? "").endsWith("~"), byTitle["Live Room Drift"]?.bpm);

  await page.fill("input.search", "bpm:120-130 key:~8A");
  await page.waitForTimeout(600);
  const filtered = await page.locator("tbody td.title").allTextContents();
  check("cross-service search with bpm/key filters", filtered.includes("Warehouse Pressure") && !filtered.includes("Amen Theory"), filtered.join(", "));
  await page.fill("input.search", "");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}library.png` });

  // --- Lucid-style beatgrids: flexible vs fixed --------------------------------------------
  await page.locator("tr", { hasText: "Tempo Steps" }).locator('[data-testid="load-a"]').click();
  await page.waitForFunction(() => /^\d/.test(document.querySelector('.deck-a [data-testid="bpm"]')?.textContent ?? ""), null, { timeout: 60_000 });
  const flexSegments = await page.locator(".deck-a .segment").allTextContents();
  check("flexible grid splits 126 → 130 BPM", flexSegments.length === 2 && flexSegments[0].startsWith("126") && flexSegments[1].startsWith("130"), flexSegments.join(" → "));
  await page.locator(".deck-a .grid-mode button", { hasText: "Fixed" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".deck-a .segment").length === 1, null, { timeout: 60_000 });
  check("fixed grid collapses to one tempo", true, await page.locator(".deck-a .segment").first().textContent());
  await page.locator(".deck-a .grid-mode button", { hasText: "Flexible" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".deck-a .segment").length === 2, null, { timeout: 10_000 });

  // --- Playback + BPM readout follows the tempo change ----------------------------------------
  await page.evaluate(() => { const d = window.__deckforge.deckA; d.player.seek(73); d.togglePlay(); });
  await page.waitForTimeout(700);
  const before = await page.locator('.deck-a [data-testid="bpm"]').textContent();
  await page.waitForTimeout(2600);
  const after = await page.locator('.deck-a [data-testid="bpm"]').textContent();
  const pos = await page.evaluate(() => window.__deckforge.deckA.player.position());
  check("playback advances", pos > 75, `position ${pos.toFixed(2)} s`);
  check("live BPM readout follows the grid across the change", before === "126.00" && after === "130.00", `${before} → ${after}`);
  await page.screenshot({ path: `${shots}deck-tempo-change.png` });

  // --- Cue loops: save the active loop to a pad, recall it with one touch ------------------
  await page.evaluate(() => window.__deckforge.deckA.player.seek(20));
  await page.waitForTimeout(150);
  await page.click('[data-testid="padmode-cueloop"]');
  await page.click('[data-testid="loop-A-4"]');
  const loop = await page.evaluate(() => ({ ...window.__deckforge.deckA.model.loop }));
  await page.click('[data-testid="pad-A-1"]');
  const padClass = await page.getAttribute('[data-testid="pad-A-1"]', "class");
  check("active loop saved to pad 1", (padClass ?? "").includes("loop"), `loop ${loop.start?.toFixed(3)}–${loop.end?.toFixed(3)}`);

  await page.click('[data-testid="loopexit-A"]');
  await page.evaluate(() => window.__deckforge.deckA.player.seek(100));
  await page.waitForTimeout(300);
  await page.click('[data-testid="pad-A-1"]');
  await page.waitForTimeout(3000); // > one 4-beat loop at 126 BPM (1.9 s): must have wrapped
  const recalled = await page.evaluate(() => ({ pos: window.__deckforge.deckA.player.position(), loop: window.__deckforge.deckA.model.loop }));
  check("pad recalls and engages the loop from elsewhere in the track",
    recalled.loop.active && Math.abs(recalled.loop.start - loop.start) < 1e-6 && recalled.pos >= loop.start - 0.01 && recalled.pos < loop.end + 0.01,
    `position ${recalled.pos.toFixed(3)} inside ${loop.start.toFixed(3)}–${loop.end.toFixed(3)}`);
  await page.screenshot({ path: `${shots}cue-loop.png` });

  // --- Second deck + sync ---------------------------------------------------------------
  await page.locator("tr", { hasText: "Warehouse Pressure" }).locator('[data-testid="load-b"]').click();
  await page.waitForFunction(() => /^\d/.test(document.querySelector('.deck-b [data-testid="bpm"]')?.textContent ?? ""), null, { timeout: 60_000 });
  await page.locator(".deck-b .transport.sync").click();
  const bBpm = await page.locator('.deck-b [data-testid="bpm"]').textContent();
  const aBpm = await page.locator('.deck-a [data-testid="bpm"]').textContent();
  check("sync matches deck B's tempo to deck A", Math.abs(Number(aBpm) - Number(bBpm)) < 0.05, `A ${aBpm} / B ${bBpm}`);
  await page.screenshot({ path: `${shots}both-decks.png` });

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`);
process.exit(failed.length ? 1 : 0);

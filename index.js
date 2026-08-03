// Nova Tutorial Recorder worker.
// Polls the tutorial-worker edge function, records the Nova app with Playwright,
// composites the mascot MP4 with ffmpeg, uploads the final 9:16 MP4, and reports back.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fetch from "node-fetch";

const {
  WORKER_API_URL,
  TUTORIAL_WORKER_TOKEN,
  POLL_INTERVAL_MS = "10000",
} = process.env;

const WORKER_VERSION = "2026-08-04-nova-handshake-v34-a7c31d9";
const NARRATION_TAIL_MS = 800;

// ---------------------------------------------------------------------------
// v28: platform caption safe zones (all values in real 1080x1920 pixels).
// Research basis (2026 UI): every vertical platform overlays an engagement
// column on the RIGHT (~20% of width) and a caption/username strip at the
// BOTTOM (TikTok/Reels ~25-30%, Shorts ~25%, Facebook Reels ~28%). The top
// strip carries navigation. Safe area = center / left, upper-to-middle frame.
// Alignment 2 = bottom-center, 1 = bottom-left (ASS numpad convention).
// ---------------------------------------------------------------------------
const CAPTION_FRAME_W = 1080;
const CAPTION_FRAME_H = 1920;
const CAPTION_SAFE_ZONES = {
  // Bottom strip ~29% (555px) + right rail 20% -> sit captions at ~600px up,
  // shifted left of the engagement column.
  tiktok: { alignment: 2, marginV: 620, marginL: 80, marginR: 260, fontSize: 52, mascotBottom: 660 },
  // Reels has the tallest bottom strip (~30%) plus the audio ticker.
  instagram_reels: { alignment: 2, marginV: 700, marginL: 80, marginR: 280, fontSize: 52, mascotBottom: 740 },
  instagram: { alignment: 2, marginV: 700, marginL: 80, marginR: 280, fontSize: 52, mascotBottom: 740 },
  // Facebook Reels: bottom strip ~28%, right rail slightly narrower.
  facebook_reels: { alignment: 2, marginV: 650, marginL: 80, marginR: 240, fontSize: 52, mascotBottom: 690 },
  facebook: { alignment: 2, marginV: 650, marginL: 80, marginR: 240, fontSize: 52, mascotBottom: 690 },
  // Shorts: description + audio attribution eat the bottom ~25%.
  youtube_shorts: { alignment: 2, marginV: 560, marginL: 80, marginR: 260, fontSize: 52, mascotBottom: 600 },
  // Long-form YouTube: only the progress bar / controls at the very bottom.
  youtube: { alignment: 2, marginV: 200, marginL: 90, marginR: 90, fontSize: 54, mascotBottom: 240 },
  linkedin: { alignment: 2, marginV: 420, marginL: 90, marginR: 200, fontSize: 52, mascotBottom: 460 },
  x: { alignment: 2, marginV: 420, marginL: 90, marginR: 200, fontSize: 52, mascotBottom: 460 },
};
const DEFAULT_CAPTION_ZONE = CAPTION_SAFE_ZONES.tiktok;
const resolveCaptionZone = (platform) => {
  const key = String(platform || process.env.CAPTION_PLATFORM || "tiktok")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return CAPTION_SAFE_ZONES[key] || DEFAULT_CAPTION_ZONE;
};
// v23: every scene is a live frame burst (real motion: taps, animations, menus
// opening) instead of one frozen screenshot.
const SCENE_FRAME_INTERVAL_MS = 100;

if (!WORKER_API_URL || !TUTORIAL_WORKER_TOKEN) {
  console.error("Missing required env vars. See .env.example");
  process.exit(1);
}

const api = async (body) => {
  const res = await fetch(WORKER_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TUTORIAL_WORKER_TOKEN}` },
    body: JSON.stringify({ worker_version: WORKER_VERSION, ...body }),
  });
  if (!res.ok) throw new Error(`worker api ${body.action} ${res.status}: ${await res.text()}`);
  return res.json();
};

const sh = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

const getMediaDurationMs = (file) => new Promise((resolve) => {
  const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (chunk) => { out += chunk.toString(); });
  p.on("exit", () => {
    const seconds = Number.parseFloat(out.trim());
    resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0);
  });
});

const interpolate = (value, nova) => String(value ?? "")
  .replaceAll("${DEMO_SEED_TOKEN}", nova.seed_token ?? "")
  .replaceAll("${NOVA_APP_URL}", nova.app_url ?? "");

const stepLabel = (index, step) => `step ${index + 1} ${step.action} ${step.selector ?? step.url ?? ""}`.trim();

let cachedNovaStorageState = null;
let cachedNovaStorageStateAt = 0;
let cachedNovaLoginPayload = null;
let cachedNovaLoginPayloadAt = 0;
const STORAGE_STATE_TTL_MS = 45 * 60 * 1000;

const requireSelector = (step, index) => {
  if (!step.selector) throw new Error(`${stepLabel(index, step)} failed: selector is required`);
  return step.selector;
};

const splitSelectorList = (selector) => {
  const parts = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (const ch of String(selector ?? "")) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [selector];
};

const extractHasText = (selector) => {
  const out = [];
  const re = /:has-text\(("([^"]+)"|'([^']+)')\)/g;
  let match;
  while ((match = re.exec(String(selector ?? "")))) out.push(match[2] ?? match[3]);
  return out;
};

const clickVisibleText = async (page, text) => page.evaluate((needle) => {
  const normalizedNeedle = String(needle ?? "").trim().toLowerCase();
  if (!normalizedNeedle) return false;
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, input, textarea, [data-tour], [tabindex], div, span"));
  const target = candidates.find((element) => {
    const label = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
    ].filter(Boolean).join(" ").trim().toLowerCase();
    return label.includes(normalizedNeedle) && visible(element);
  });
  if (!target) return false;
  const clickable = target.closest("button, [role='button'], a, input, textarea, [tabindex], [data-tour]") ?? target;
  clickable.scrollIntoView({ block: "center", inline: "center" });
  clickable.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return true;
}, text).catch(() => false);

const clickSelector = async (page, selector, options = {}) => {
  const selectors = splitSelectorList(selector);
  let lastError = null;

  for (const candidate of selectors) {
    const locator = page.locator(candidate).first();
    const found = await locator.waitFor({ state: "attached", timeout: options.timeout ?? 5000 }).then(() => true).catch((error) => {
      lastError = error;
      return false;
    });
    if (!found) continue;

    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);

    try {
      await locator.click({ timeout: 5000 });
      return true;
    } catch (firstError) {
      lastError = firstError;
      const message = String(firstError?.message ?? firstError);
      if (!message.includes("not stable") && !message.includes("detached") && !message.includes("Timeout")) {
        continue;
      }
    }

    await page.waitForTimeout(500);
    const clicked = await page.evaluate((sel) => {
      let element = null;
      try { element = document.querySelector(sel); } catch { return false; }
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      if (element instanceof HTMLElement) {
        element.click();
        return true;
      }
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }, candidate);
    if (clicked) return true;
  }

  for (const text of extractHasText(selector)) {
    if (await clickVisibleText(page, text)) return true;
  }

  // Last-ditch: for the chat mode picker, click any visible button whose label
  // contains "text" or "type" when we're on /chat. Handles unknown labels.
  const selStr = String(selector ?? "");
  if (/chat-text|Text Chat|chat-mode/i.test(selStr)) {
    const clicked = await page.evaluate(() => {
      const url = location.pathname;
      if (!url.startsWith("/chat")) return false;
      const btns = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          const s = window.getComputedStyle(b);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        });
      const target = btns.find((b) => {
        const label = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || "")).toLowerCase();
        return /\b(text|type|message|keyboard)\b/.test(label) && !/voice|speak|mic/.test(label);
      });
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      target.click();
      return true;
    }).catch(() => false);
    if (clicked) {
      console.log("[recording] clicked chat mode via label heuristic");
      return true;
    }
  }

  if (options.optional) {
    console.log(`[recording] optional click target not found, continuing: ${selector}`);
    return false;
  }

  throw new Error(`selector not found after retry: ${selector}${lastError ? ` (${String(lastError.message ?? lastError).split("\n")[0]})` : ""}`);
};

const fillSelector = async (page, selector, text) => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout: 15000 });
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await locator.fill(text ?? "", { timeout: 10000 });
};

const ensureRouteForClick = async (page, selector, nova) => {
  const sel = String(selector ?? "");
  const route = sel.includes("profile-alex") || /has-text\(["']Alex["']\)/.test(sel)
    ? "/profiles"
    : sel.includes("Type your message") || sel.includes("Send message") || sel.includes("Text Chat")
      ? "/chat"
      : sel.includes("Meltdown") || sel.includes("Elopement") || sel.includes("Wandering")
        ? "/crisis"
        : sel.includes("sensory-") || /Breathe|Breathing|Jar|Float|Bubble|Pop|Draw|Sand|Koi|Sound|Body Scan|Aurora/i.test(sel)
          ? "/sensory"
          : null;
  if (!route) return;
  const current = new URL(page.url()).pathname;
  if (current === route) return;
  const url = new URL(`${nova.app_url}${route}`);
  url.searchParams.set("demo", "1");
  url.searchParams.set("recording", "1");
  url.searchParams.set("skipOnboarding", "1");
  url.searchParams.set("lang", "en");
  console.log(`[recording] selector implies ${route}; navigating before click`);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
};

// Every click is treated as best effort: the narration keeps playing and the
// page stays on the right screen even if one micro-interaction target moved.
const isSafeOptionalClick = () => true;

const novaOrigin = (nova) => new URL(nova.app_url).origin;

const languageStorageEntries = () => ([
  ["language", "en"],
  ["locale", "en"],
  ["i18nextLng", "en"],
  ["selectedLanguage", "en"],
  ["preferredLanguage", "en"],
  ["preferred-language", "en"],
  ["nova_language", "en"],
  ["nova-language", "en"],
  ["nova:language", "en"],
  ["nova:selected-language", "en"],
  ["languageSelected", "true"],
  ["hasSelectedLanguage", "true"],
  ["nova_language_selected", "true"],
  ["nova:language-selected", "true"],
  ["firstLaunchComplete", "true"],
  ["hasCompletedFirstLaunch", "true"],
  ["hasSeenFirstLaunch", "true"],
  ["onboardingComplete", "true"],
  ["hasCompletedOnboarding", "true"],
  ["nova_first_launch_complete", "true"],
  ["nova:first-launch-complete", "true"],
  ["recording", "1"],
  ["nova_recording", "1"],
  ["demo", "1"],
  ["nova_demo", "1"],
]);

const findSession = (value) => {
  if (!value || typeof value !== "object") return null;
  if (value.access_token && value.refresh_token) return value;
  if (value.session?.access_token && value.session?.refresh_token) return value.session;
  if (value.data?.session?.access_token && value.data?.session?.refresh_token) return value.data.session;
  if (value.user && value.access_token) return value;
  return null;
};

const parseJsonSafely = async (res) => {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
};

const isCacheFresh = (timestamp) => timestamp && Date.now() - timestamp < STORAGE_STATE_TTL_MS;

const fetchDemoLoginPayload = async (nova, force = false) => {
  if (!force && cachedNovaLoginPayload && isCacheFresh(cachedNovaLoginPayloadAt)) {
    console.log("[auth] reusing cached demo login payload");
    return cachedNovaLoginPayload;
  }

  const novaHeaders = {
    "x-seed-token": nova.seed_token,
    ...(nova.anon_key ? { apikey: nova.anon_key, authorization: `Bearer ${nova.anon_key}` } : {}),
  };
  const loginRes = await fetch(nova.demo_login_url, { method: "POST", headers: novaHeaders });
  const loginPayload = await parseJsonSafely(loginRes);
  if (!loginRes.ok) throw new Error(`demo-login ${loginRes.status}: ${loginPayload.text.slice(0, 500)}`);

  cachedNovaLoginPayload = loginPayload.json;
  cachedNovaLoginPayloadAt = Date.now();
  console.log("[auth] refreshed demo login payload");
  return cachedNovaLoginPayload;
};

const buildInitialStorageState = (nova, loginPayload) => {
  const origin = novaOrigin(nova);
  const entries = languageStorageEntries().map(([name, value]) => ({ name, value }));
  const session = findSession(loginPayload);

  if (session && nova.auth_storage_key) {
    entries.push({ name: nova.auth_storage_key, value: JSON.stringify(session) });
    console.log("[auth] seeded browser auth storage from demo-login response");
  } else if (nova.auth_storage_key) {
    console.log("[auth] demo-login response did not include a browser session; using warmup autologin fallback");
  }

  return { cookies: [], origins: [{ origin, localStorage: entries }] };
};

const installStartupState = async (context, nova, loginPayload) => {
  const session = findSession(loginPayload);
  await context.addInitScript(({ authStorageKey, languageEntries, sessionValue }) => {
    for (const [key, value] of languageEntries) {
      window.localStorage.setItem(key, value);
      window.sessionStorage.setItem(key, value);
    }
    if (authStorageKey && sessionValue) {
      window.localStorage.setItem(authStorageKey, sessionValue);
    }
  }, {
    authStorageKey: nova.auth_storage_key,
    languageEntries: languageStorageEntries(),
    sessionValue: session ? JSON.stringify(session) : null,
  });
};

const applyStartupStateToPage = async (page, nova, loginPayload) => {
  const session = findSession(loginPayload);
  await page.evaluate(({ authStorageKey, languageEntries, sessionValue }) => {
    for (const [key, value] of languageEntries) {
      window.localStorage.setItem(key, value);
      window.sessionStorage.setItem(key, value);
    }
    if (authStorageKey && sessionValue) {
      window.localStorage.setItem(authStorageKey, sessionValue);
    }
  }, {
    authStorageKey: nova.auth_storage_key,
    languageEntries: languageStorageEntries(),
    sessionValue: session ? JSON.stringify(session) : null,
  });
};

const detectLanguageGate = async (page) => page.evaluate(() => {
  const text = document.body?.innerText ?? "";
  return /Welcome to Nova/i.test(text) && /Choose your language|Elige tu idioma|Choisissez votre langue/i.test(text);
}).catch(() => false);

// v26: spot screens that are about to be filmed while still empty. Returns the
// matched phrase (for the warning log) or null when the screen looks lived in.
const detectEmptyState = async (page) => page.evaluate(() => {
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
  const patterns = [
    /No [a-z ]{0,30}(yet|created|added|saved)/i,
    /Nothing here yet/i,
    /You (haven't|have not) [a-z ]{0,40}yet/i,
    /Create your first [a-z ]{0,30}/i,
    /Add your first [a-z ]{0,30}/i,
    /Get started by [a-z ]{0,30}/i,
    /No results found/i,
    /Your [a-z ]{0,25} is empty/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0].slice(0, 80);
  }
  return null;
}).catch(() => null);

const hasAuthStorage = (state, nova) => Boolean(
  nova.auth_storage_key
  && state?.origins?.some((origin) => origin.localStorage?.some((entry) => entry.name === nova.auth_storage_key && entry.value)),
);

const clickByText = async (page, pattern) => page.evaluate((source) => {
  const regex = new RegExp(source, "i");
  const elements = Array.from(document.querySelectorAll("button, [role='button'], a, div, span, li"));
  const target = elements.find((element) => regex.test((element.textContent ?? "").trim()));
  if (!target) return false;
  const clickable = target.closest("button, [role='button'], a") ?? target;
  clickable.scrollIntoView({ block: "center", inline: "center" });
  clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return true;
}, pattern.source).catch(() => false);

// Warm-up: open the app in a HIDDEN context, click through the language picker
// (and anything else the app shows on first launch), let auto-login finish,
// then export the resulting storageState. We reuse this state for the recorded
// context so the video starts on the homepage instead of the language screen.
const warmUpStorageState = async ({ browser, nova, loginPayload }) => {
  const initialStorageState = buildInitialStorageState(nova, loginPayload);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    storageState: initialStorageState,
  });
  await installStartupState(context, nova, loginPayload);
  const page = await context.newPage();

  const autologinUrl = `${nova.app_url}/?demo=1&recording=1&skipOnboarding=1&lang=en&autologin=${encodeURIComponent(nova.seed_token ?? "")}`;
  console.log("[warmup] goto", autologinUrl.replace(nova.seed_token ?? "###", "***"));
  await page.goto(autologinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await applyStartupStateToPage(page, nova, loginPayload).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

  // Try to dismiss the language picker. Click an English option if present,
  // then any Continue/Get Started/Next button. All best-effort.
  const languageCandidates = [
    'button:has-text("English")',
    '[role="button"]:has-text("English")',
    'text=/^English$/i',
    'button:has-text("EN")',
  ];
  for (const sel of languageCandidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      break;
    }
  }
  await clickByText(page, /^English$/i);
  await page.waitForTimeout(600);

  const continueCandidates = [
    'button:has-text("Continue")',
    'button:has-text("Get Started")',
    'button:has-text("Get started")',
    'button:has-text("Next")',
    'button:has-text("Done")',
    'button:has-text("Start")',
  ];
  for (let pass = 0; pass < 3; pass += 1) {
    let clicked = false;
    for (const sel of continueCandidates) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        clicked = true;
        await page.waitForTimeout(300);
        break;
      }
    }
    if (!clicked) clicked = await clickByText(page, /^(Continue|Get Started|Get started|Next|Done|Start)$/i);
    if (clicked) await page.waitForTimeout(300);
    if (!clicked) break;
  }

  if (await detectLanguageGate(page)) {
    console.log("[warmup] language gate still visible; forcing startup flags and retrying");
    await applyStartupStateToPage(page, nova, loginPayload).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await clickByText(page, /^English$/i);
    await page.waitForTimeout(400);
    await clickByText(page, /^(Continue|Get Started|Get started|Next|Done|Start)$/i);
    await page.waitForTimeout(400);
  }

  // Give the app time to finish auto-login and strip the token from the URL.
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);

  await applyStartupStateToPage(page, nova, loginPayload).catch(() => {});
  const state = await context.storageState();
  console.log("[warmup] captured storage state", {
    finalUrl: page.url(),
    hasAuthStorage: hasAuthStorage(state, nova),
    languageGateVisible: await detectLanguageGate(page),
  });
  await context.close();
  return state;
};

const prepareRecordedPage = async ({ browser, workDir, storageState, nova, loginPayload }) => {
  const recordingStartedAt = Date.now();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    recordVideo: { dir: workDir, size: { width: 390, height: 844 } },
    storageState,
  });
  await installStartupState(context, nova, loginPayload);
  const page = await context.newPage();
  return { context, page, recordingStartedAt };
};

// v30: keeps a headless page's render loop from being throttled. Playwright
// pages are never OS-focused, so Chrome quietly demotes them to "background
// tab" behavior (Page.setWebLifecycleState defaults to "frozen"/"hidden"
// scheduling), which throttles requestAnimationFrame and timers to ~1Hz after
// a couple of seconds. That is exactly the "records ~3s then freezes" symptom:
// the screencast has nothing new to send because the page stopped painting.
const forceActivePage = async (page) => {
  await page.bringToFront().catch(() => {});
  const session = await page.context().newCDPSession(page).catch(() => null);
  if (!session) return;
  await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await session.detach().catch(() => {});
};

const prepareScenePage = async ({ browser, storageState, nova, loginPayload }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    // v29: 1x for the captured context. Output is 390x844 anyway, and 2x frames
    // were starving the animation loop during capture.
    deviceScaleFactor: 1,
    storageState,
  });
  await installStartupState(context, nova, loginPayload);
  const page = await context.newPage();
  await forceActivePage(page);
  return { context, page };
};

// Fetch narration MP3 for a `narrate` step via the tutorial-worker edge fn.
const fetchNarrationAudio = async (text) => {
  const res = await fetch(WORKER_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TUTORIAL_WORKER_TOKEN}` },
    body: JSON.stringify({ worker_version: WORKER_VERSION, action: "narrate", text }),
  });
  if (!res.ok) throw new Error(`narrate ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { buffer: Buffer.from(j.audioBase64, "base64"), durationMs: j.durationMs };
};

// Pre-generate audio for every narrate step so the recording can pace accurately
// and we don't wait on network mid-record. Returns [{stepIndex, durationMs, buffer}].
// IMPORTANT: the edge function reports durationMs from raw MP3 byte size which is
// wildly inaccurate for eleven_v3 (VBR + header overhead). We always re-measure
// each MP3 with ffprobe so the "screen waits for narration" gate, timeline
// startMs values, and the final ffmpeg -t cap all match the real audio length.
const preloadNarration = async (script, workDir) => {
  const out = [];
  for (let i = 0; i < script.length; i += 1) {
    const s = script[i];
    if (s.action !== "narrate") continue;
    if (!s.text?.trim()) {
      const durationMs = Math.max(500, Number(s.ms) || 2500);
      const probePath = join(workDir, `narr-probe-${i}.mp3`);
      await createSilenceMp3(probePath, durationMs);
      const buffer = await readFile(probePath);
      out.push({ stepIndex: i, durationMs, buffer, text: "" });
      continue;
    }
    console.log(`[narrate] generating audio for step ${i + 1}: "${s.text.slice(0, 60)}..."`);
    const audio = await fetchNarrationAudio(s.text);
    const probePath = join(workDir, `narr-probe-${i}.mp3`);
    await writeFile(probePath, audio.buffer);
    const measuredMs = await getMediaDurationMs(probePath);
    const durationMs = measuredMs > 0 ? measuredMs : audio.durationMs;
    if (audio.durationMs && Math.abs(durationMs - audio.durationMs) > 500) {
      console.log(`[narrate] step ${i + 1} duration corrected: reported=${audio.durationMs}ms actual=${durationMs}ms`);
    }
    out.push({ stepIndex: i, durationMs, buffer: audio.buffer, text: s.text });
  }
  return out;
};

const applyContinuousNarrationTimeline = (narrationMap) => {
  let cursor = 0;
  for (const n of narrationMap || []) {
    n.startMs = cursor;
    cursor += Math.max(0, Number(n.durationMs) || 0);
  }
  return cursor;
};

// Strip performance cues like [warm], [excited] from narration copy for on-screen captions.
const cleanCaptionText = (t) => String(t ?? "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();

const LEGACY_FILLER_PATTERNS = [
  /\bright this way\b/i,
  /\bhere comes the next one\b/i,
  /\bone moment\b/i,
  /\bjust a second\b/i,
  /\bhold on\b/i,
  /\blet me (open|pull|bring|get) (that|this|it) (up|for you)\b/i,
  /\bcoming right up\b/i,
  /\bbringing (that|this|it) up now\b/i,
  /\bhere we go\b/i,
  /\bup next\b/i,
];

const isLegacyFillerNarration = (text) => {
  const cleaned = String(text ?? "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;
  const wordCount = cleaned.split(" ").length;
  return wordCount <= 14 && LEGACY_FILLER_PATTERNS.some((pattern) => pattern.test(cleaned));
};

const stripLegacyFillerNarration = (script) => (script || []).filter((step) => {
  if (step?.action !== "narrate") return true;
  return !isLegacyFillerNarration(step.text);
});

const msToSrtTs = (ms) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const cs = ms % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(cs, 3)}`;
};

const msToVttTs = (ms) => msToSrtTs(ms).replace(",", ".");

// Build SRT + WebVTT from narrationMap; segments are concatenated with no gaps,
// so cue N runs from sum(prev durations) to that + its own duration.
const buildCaptions = (narrationMap) => {
  const srtLines = [];
  const vttLines = ["WEBVTT", ""];
  let cursor = 0;
  let idx = 1;
  for (const n of narrationMap) {
    const text = cleanCaptionText(n.text);
    const start = Number.isFinite(n.startMs) ? n.startMs : cursor;
    const end = start + n.durationMs;
    if (!text) { cursor = end; continue; }
    srtLines.push(String(idx));
    srtLines.push(`${msToSrtTs(start)} --> ${msToSrtTs(end)}`);
    srtLines.push(text);
    srtLines.push("");
    vttLines.push(`${msToVttTs(start)} --> ${msToVttTs(end)}`);
    vttLines.push(text);
    vttLines.push("");
    cursor = end;
    idx += 1;
  }
  return { srt: srtLines.join("\n"), vtt: vttLines.join("\n") };
};

const createSilenceMp3 = async (targetPath, durationMs) => {
  const seconds = Math.max(0.05, durationMs / 1000).toFixed(3);
  await sh("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=mono",
    "-t", seconds,
    "-q:a", "9",
    "-acodec", "libmp3lame",
    targetPath,
  ]);
};

const writeTimedNarrationTrack = async ({ workDir, narrationTimeline, narrationMp3 }) => {
  if (!narrationTimeline.length) return false;

  // v14: concatenate narration segments back-to-back with NO silence between
  // them. Narration is the timeline now; screens race under it. This is what
  // keeps a 30-45s script from stretching into 3 minutes just because a page
  // took 10s to load between two beats.
  const segmentPaths = [];
  for (let i = 0; i < narrationTimeline.length; i += 1) {
    const n = narrationTimeline[i];
    const p = join(workDir, `narr-${i}.mp3`);
    await writeFile(p, n.buffer);
    segmentPaths.push(p);
  }

  const listPath = join(workDir, "narration.txt");
  await writeFile(listPath, segmentPaths.map((p) => `file '${p}'`).join("\n"));
  await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "libmp3lame", "-q:a", "4", narrationMp3]);
  return true;
};

const normalizeVideoDuration = async ({ inputPath, outputPath, durationMs, loop = false }) => {
  const durationSec = Math.max(0.1, durationMs / 1000).toFixed(3);
  const args = ["-y"];
  if (loop) args.push("-stream_loop", "-1");
  args.push(
    "-i", inputPath,
    "-t", durationSec,
    "-vf", "fps=30,format=yuv420p,setpts=PTS-STARTPTS",
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  );
  await sh("ffmpeg", args);
  return getMediaDurationMs(outputPath);
};

const concatFileLine = (file) => `file '${String(file).replace(/'/g, "'\\''")}'`;

// v23: each scene is a burst of live frames captured while the beat's taps and
// animations actually happen. Frames play at real speed; if the burst is shorter
// than the spoken line, the last frame freezes for the remainder. If it is
// longer, frames are evenly compressed into the narration window.
const writeSceneVideo = async ({ workDir, scenes, outputPath }) => {
  if (!scenes.length) throw new Error("no deterministic scenes captured");
  const listPath = join(workDir, "scenes.txt");
  const lines = [];
  let lastFile = null;
  for (const scene of scenes) {
    const targetMs = Math.max(500, scene.durationMs);
    const frames = (scene.framePaths ?? []).length ? scene.framePaths : [scene.imagePath];
    const intervalMs = scene.frameIntervalMs ?? SCENE_FRAME_INTERVAL_MS;
    const times = Array.isArray(scene.frameTimes) && scene.frameTimes.length === frames.length ? scene.frameTimes : null;
    if (frames.length === 1) {
      lines.push(concatFileLine(frames[0]));
      lines.push(`duration ${(targetMs / 1000).toFixed(3)}`);
    } else if (times) {
      // Real per-frame timing from the screencast. Scale to fit the spoken line:
      // stretch the tail when capture was short, compress evenly when it ran long.
      const raw = frames.map((_, i) => Math.max(20, (i === frames.length - 1 ? targetMs : times[i + 1]) - times[i]));
      const realMs = raw.reduce((a, b) => a + b, 0);
      const scale = realMs > targetMs ? targetMs / realMs : 1;
      const durations = raw.map((ms) => ms * scale);
      if (realMs < targetMs) durations[durations.length - 1] += targetMs - realMs;
      frames.forEach((file, i) => {
        lines.push(concatFileLine(file));
        lines.push(`duration ${(durations[i] / 1000).toFixed(3)}`);
      });
    } else {
      const realMs = frames.length * intervalMs;
      if (realMs <= targetMs) {
        // Real-time playback, then hold the final frame to fill the spoken line.
        const tailMs = targetMs - realMs + intervalMs;
        frames.forEach((file, i) => {
          lines.push(concatFileLine(file));
          lines.push(`duration ${(((i === frames.length - 1 ? tailMs : intervalMs)) / 1000).toFixed(3)}`);
        });
      } else {
        const per = targetMs / frames.length;
        for (const file of frames) {
          lines.push(concatFileLine(file));
          lines.push(`duration ${(per / 1000).toFixed(3)}`);
        }
      }
    }
    lastFile = frames[frames.length - 1];
  }
  // concat demuxer needs the final image repeated or the last duration is ignored.
  lines.push(concatFileLine(lastFile));
  await writeFile(listPath, lines.join("\n"));
  await sh("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-vf", "fps=30,scale=390:844:force_original_aspect_ratio=increase,crop=390:844,format=yuv420p,setpts=PTS-STARTPTS",
    "-an",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    outputPath,
  ]);
  return getMediaDurationMs(outputPath);
};

// v29: capture through the Chrome DevTools screencast so frames arrive as the
// page actually paints (25-30 fps) instead of a 10 fps screenshot loop that
// stalls canvas/WebGL animations. Falls back to the screenshot loop if the CDP
// session is unavailable. Frame timestamps are recorded so playback uses real
// per-frame timing.
const startScreenshotLoopCapture = (page, dir, intervalMs, frames, frameTimes, state, prefix = "f") => {
  const startedAt = Date.now();
  return (async () => {
    let i = frames.length;
    while (!state.stopped) {
      const tick = Date.now();
      const framePath = join(dir, `${prefix}-${String(i).padStart(5, "0")}.jpg`);
      try {
        const buf = await page.screenshot({ type: "jpeg", quality: 80, fullPage: false, timeout: 4000, animations: "allow" });
        const tmpPath = `${framePath}.tmp`;
        await writeFile(tmpPath, buf);
        await rename(tmpPath, framePath);
        frames.push(framePath);
        frameTimes.push(Date.now() - startedAt);
        i += 1;
      } catch {
        /* ignore transient capture failures */
      }
      const wait = intervalMs - (Date.now() - tick);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();
};

const startFrameCapture = (page, dir, intervalMs = SCENE_FRAME_INTERVAL_MS) => {
  const frames = [];
  const frameTimes = [];
  const state = { stopped: false };
  const startedAt = Date.now();
  let session = null;
  let writeChain = Promise.resolve();
  let loopRun = null;

  const started = (async () => {
    try {
      session = await page.context().newCDPSession(page);
      let i = 0;
      session.on("Page.screencastFrame", (frame) => {
        // Ack immediately so Chrome keeps sending frames while we write to disk.
        session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        if (state.stopped) return;
        const elapsed = Date.now() - startedAt;
        const framePath = join(dir, `f-${String(i).padStart(5, "0")}.jpg`);
        i += 1;
        writeChain = writeChain.then(async () => {
          try {
            const tmpPath = `${framePath}.tmp`;
            await writeFile(tmpPath, Buffer.from(frame.data, "base64"));
            await rename(tmpPath, framePath);
            frames.push(framePath);
            frameTimes.push(elapsed);
          } catch {
            /* ignore transient write failures */
          }
        });
      });
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: 390,
        maxHeight: 844,
        everyNthFrame: 1,
      });
      // CDP only emits when Chrome believes the page has visual damage. Canvas,
      // WebGL, and throttled headless tabs can therefore go quiet even while an
      // activity should still be moving. A low-rate screenshot watchdog forces
      // fresh paints and supplies recovery frames without replacing the smooth
      // screencast stream.
      loopRun = startScreenshotLoopCapture(page, dir, 500, frames, frameTimes, state, "watch");
    } catch (e) {
      console.warn(`[capture] screencast unavailable, falling back to screenshot loop: ${String(e).slice(0, 120)}`);
      session = null;
      loopRun = startScreenshotLoopCapture(page, dir, intervalMs, frames, frameTimes, state);
    }
  })();

  return {
    frames,
    frameTimes,
    stop: async () => {
      await started.catch(() => {});
      state.stopped = true;
      if (session) {
        await session.send("Page.stopScreencast").catch(() => {});
        await writeChain.catch(() => {});
        await session.detach().catch(() => {});
      }
      if (loopRun) await loopRun.catch(() => {});
      const ordered = frames.map((path, index) => ({ path, at: frameTimes[index] ?? 0 }))
        .sort((a, b) => a.at - b.at);
      frames.splice(0, frames.length, ...ordered.map((entry) => entry.path));
      frameTimes.splice(0, frameTimes.length, ...ordered.map((entry) => entry.at));
    },
  };
};


// PUT a sidecar file (srt/vtt) to storage via the same signed upload flow and return the view URL.
const uploadSidecar = async (flowId, ext, contentType, body) => {
  const { uploadUrl, viewUrl } = await api({ action: "getUploadUrl", id: flowId, ext });
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body });
  if (!res.ok) throw new Error(`sidecar ${ext} upload ${res.status}: ${await res.text()}`);
  return viewUrl;
};

const normalizeScriptSteps = (script) => {
  const mapped = (script || []).map((step, originalIndex) => ({ step, originalIndex }));
  const out = [];
  let skippedAutologin = false;

  for (const item of mapped) {
    const { step } = item;
    const isAutologinGoto = step.action === "goto" && String(step.url ?? "").includes("autologin=");
    if (isAutologinGoto) {
      skippedAutologin = true;
      continue;
    }

    // When the off-camera autologin goto is stripped, also strip its paired
    // app-ready waits. Otherwise a multi-feature script can sit on a blank or
    // static prep frame for 10 to 15 seconds before the first real feature.
    if (skippedAutologin && step.action === "waitForEvent" && step.event === "nova:app-ready") continue;
    if (skippedAutologin && step.action === "wait" && (step.ms ?? 0) <= 2500) {
      skippedAutologin = false;
      continue;
    }

    skippedAutologin = false;
    out.push(item);
  }

  // Older saved flows put every click before `narrate`, which means live frame
  // capture began only after the interaction had already finished. Reorder each
  // metadata-tagged beat so navigation/readiness stays off camera, narration
  // starts, and then the visible interaction runs while frames are rolling.
  const reordered = [];
  for (let i = 0; i < out.length;) {
    const beatId = out[i].step?.beatId;
    if (!beatId) {
      reordered.push(out[i]);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < out.length && out[end].step?.beatId === beatId) end += 1;
    const group = out.slice(i, end);
    const narrationIndex = group.findIndex(({ step }) => step.action === "narrate");
    if (narrationIndex > 0) {
      const before = group.slice(0, narrationIndex);
      const narration = group[narrationIndex];
      const after = group.slice(narrationIndex + 1);
      const setup = [];
      const live = [];
      let interactionStarted = false;
      for (const entry of before) {
        if (entry.step.action === "goto") interactionStarted = false;
        if (["click", "type", "zoomTo", "slowScroll", "drawHeart"].includes(entry.step.action)) interactionStarted = true;
        if (interactionStarted) live.push(entry);
        else setup.push(entry);
      }
      if (live.length) {
        reordered.push(...setup, narration, ...live, ...after);
      } else {
        reordered.push(...group);
      }
    } else {
      reordered.push(...group);
    }
    i = end;
  }

  if (!reordered.length || (reordered[0].step.action !== "goto" && reordered[0].step.action !== "narrate")) {
    reordered.unshift({ step: { action: "goto", url: "/" }, originalIndex: -1 });
  }
  return reordered;
};

const routeMatches = (actualUrl, expectedUrl, nova) => {
  try {
    const expected = new URL(interpolate(expectedUrl || "/", nova), nova.app_url);
    const actual = new URL(actualUrl);
    if (actual.pathname !== expected.pathname) return false;
    const expectedTool = expected.searchParams.get("tool");
    return !expectedTool || actual.searchParams.get("tool") === expectedTool;
  } catch {
    return false;
  }
};

const waitForVisualStability = async (page, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    const signature = await page.evaluate(() => {
      const body = document.body;
      if (!body) return "missing";
      const rect = body.getBoundingClientRect();
      return [document.readyState, body.innerText.length, document.images.length, Math.round(rect.height), document.querySelectorAll("[aria-busy='true']").length].join(":");
    }).catch(() => "error");
    if (signature === previous && !signature.endsWith(":1")) stableCount += 1;
    else stableCount = 0;
    if (stableCount >= 2) return true;
    previous = signature;
    await page.waitForTimeout(200);
  }
  return false;
};

const runScript = async (page, script, nova, narrationMap, timelineBaseMs = Date.now(), recordingBudgetMs = 0, options = {}) => {
  const steps = normalizeScriptSteps(script);
  const stepReport = { skipped: [], ran: 0, total: steps.length, scenes: [], scene_checks: [], empty_state_warnings: [], worker_version: WORKER_VERSION };
  const captureScenes = !!options.captureScenes;
  const sceneWorkDir = options.sceneWorkDir;
  const flowId = options.flowId;
  const totalNarrateSteps = steps.filter((s) => s.step.action === "narrate").length;

  // Pair each narrate step with the following non-narrate steps; after those
  // run, pad so the group lasts at least as long as the narration audio.
  // Screen actions run silently under the current narration. If the screen work
  // takes longer than the line, the next line waits silently until the screen is ready.
  let currentNarration = null; // { durationMs, startedAt }
  const recordingDeadlineAt = recordingBudgetMs > 0 ? timelineBaseMs + recordingBudgetMs : Number.POSITIVE_INFINITY;
  const remainingBudgetMs = () => Math.max(0, recordingDeadlineAt - Date.now());
  const hasHitDeadline = () => Number.isFinite(recordingDeadlineAt) && remainingBudgetMs() <= 0;
  const waitWithinBudget = async (ms) => {
    const budget = remainingBudgetMs();
    if (budget <= 0) return false;
    await page.waitForTimeout(Math.min(ms, budget));
    return ms <= budget;
  };
  // v23 live scene capture state. A scene keeps recording frames while the
  // beat's clicks/taps run, then holds live until the spoken line is over,
  // and is closed right before the next navigation.
  let activeCapture = null;
  let activeScene = null;
  const finishActiveScene = async ({ holdForNarration = true } = {}) => {
    if (!activeCapture) return;
    if (holdForNarration && currentNarration) {
      const elapsed = Date.now() - currentNarration.startedAt;
      const remaining = currentNarration.durationMs - elapsed;
      if (remaining > 0) await page.waitForTimeout(remaining).catch(() => {});
    }
    const capture = activeCapture;
    const scene = activeScene;
    activeCapture = null;
    activeScene = null;
    await capture.stop();
    if (scene) {
      const isClosingCta = scene.screenActionId?.startsWith("cta.")
        || String(scene.expectedUrl ?? "").includes("/promo-cta");
      // Chrome can emit a stale screencast frame from the document that was
      // open before a cross-route navigation. The CTA is a static closing
      // screen, so its verified post-navigation screenshot is the source of
      // truth and must not be replaced by stale frames from the prior scene.
      scene.framePaths = isClosingCta ? [scene.imagePath] : capture.frames.slice();
      scene.frameTimes = isClosingCta ? [] : (capture.frameTimes ?? []).slice();
      scene.frameIntervalMs = SCENE_FRAME_INTERVAL_MS;
      console.log(`SCENE_FRAMES index=${scene.index} frames=${scene.framePaths.length}`);
    }
  };
  // Track whether the most recent goto only changed query params on the same
  // path. Nova does not emit a new nova:route-ready event for query-only
  // changes, so a subsequent waitForEvent("nova:route-ready") would burn its
  // full timeout (often 12s) and create long silent gaps. When this flag is
  // true, we treat the route as already ready.
  let lastGotoPath = null;
  let lastGotoSamePath = false;

  for (const [index, item] of steps.entries()) {
    const { step, originalIndex } = item;
    try {
      // Setup steps (goto / critical) MUST run even if the narration clock has
      // "expired" — they prepare the next beat's screen so the following spoken
      // line lands on the correct visual. Only non-critical filler is skipped.
      const isSetupStep = step.action === "goto" || step.critical;
      if (hasHitDeadline() && !isSetupStep && step.action !== "narrate") {
        console.log(`[recording] narration clock expired before ${stepLabel(originalIndex >= 0 ? originalIndex : index, step)}; stopping visual steps`);
        break;
      }

      if (step.action === "narrate") {
        // Close any still-open live scene (back-to-back narrate steps) before
        // this line takes over the clock.
        if (captureScenes) await finishActiveScene();
        // v14: do NOT pad between beats. Narration audio is rendered as one
        // continuous back-to-back track separately; screens just race to keep
        // up. Only the final beat's tail pad matters (handled after the loop).
        const narr = (narrationMap || []).find((n) => n.stepIndex === originalIndex || n.stepIndex === index)
          ?? (captureScenes ? { durationMs: 500 } : null);
        currentNarration = narr
          ? { durationMs: narr.durationMs, startedAt: Date.now() }
          : null;
        // BEAT_READY log: proves which URL was on screen at the moment this
        // spoken line started, so we can verify screens landed before words.
        const urlAtSpeak = (() => { try { return page.url(); } catch { return "unknown"; } })();
        console.log(`BEAT_READY url=${urlAtSpeak} line="${(step.text ?? "").slice(0, 80)}" audio_ms=${narr?.durationMs ?? 0}`);
        if (captureScenes && sceneWorkDir && narr) {
          const expectedUrl = step.expectedUrl || "/";
          const actualUrl = (() => { try { return page.url(); } catch { return "unknown"; } })();
          const routeOk = routeMatches(actualUrl, expectedUrl, nova);
          const stable = routeOk ? await waitForVisualStability(page) : false;
          // v26: warn (never fail) when a screen is about to be filmed while it
          // is still showing an empty state. Empty screens on camera read as
          // "nobody uses this app", so we surface which screen needs seeding.
          const emptyState = routeOk ? await detectEmptyState(page) : null;
          const check = {
            beatId: step.beatId ?? `beat-${stepReport.scenes.length + 1}`,
            feature: step.beatFeature ?? "Scene",
            screenActionId: step.screenActionId ?? null,
            expectedUrl,
            actualUrl,
            // v34: route match is the only hard requirement. Animation-heavy
            // Calm tools never reach a "visually stable" signature, so treating
            // instability as a failure dropped every good scene.
            ok: routeOk,
            unstable: routeOk && !stable,
            empty_state: emptyState,
            error: !routeOk ? "Expected Nova route was not open" : null,
          };
          stepReport.scene_checks.push(check);
          if (emptyState) {
            stepReport.empty_state_warnings.push({ feature: check.feature, url: actualUrl, match: emptyState });
            console.warn(`SCENE_EMPTY_STATE feature="${check.feature}" url=${actualUrl} match="${emptyState}"`);
          }
          if (flowId) postProgress(flowId, {
            stage: "scene-validation",
            current: stepReport.scene_checks.length,
            total: totalNarrateSteps,
            note: `${check.feature} ${check.ok ? (emptyState ? "ready (empty state)" : "ready") : "skipped"}`,
            scene_check: check,
          });
          if (!check.ok) {
            const isClosingCta = String(check.screenActionId ?? "").startsWith("cta.")
              || String(check.expectedUrl ?? "").includes("/promo-cta");
            if (isClosingCta) {
              throw new Error(`Closing CTA validation failed: ${check.error ?? "CTA page was not ready"}; expected=${expectedUrl}; actual=${actualUrl}`);
            }
            // v25/v26: soft validation. The scene is dropped, its narration time
            // is absorbed by the neighbouring scenes, and the render continues.
            console.warn(`SCENE_SOFT_SKIP feature="${check.feature}" reason="${check.error}" expected=${expectedUrl} actual=${actualUrl}`);
          } else {
            const sceneIndex = stepReport.scenes.length;
            const imagePath = join(sceneWorkDir, `scene-${String(sceneIndex).padStart(3, "0")}.png`);
            await page.screenshot({ path: imagePath, fullPage: false });
            const scene = {
              index: sceneIndex,
              imagePath,
              framePaths: [],
              frameIntervalMs: SCENE_FRAME_INTERVAL_MS,
              durationMs: Math.max(500, narr.durationMs || 0),
              line: step.text ?? "",
              url: urlAtSpeak,
              stepIndex: originalIndex >= 0 ? originalIndex : index,
              beatId: check.beatId,
              feature: check.feature,
              screenActionId: check.screenActionId,
              expectedUrl: check.expectedUrl,
              ok: true,
            };
            stepReport.scenes.push(scene);
            // v23: start rolling live frames so the taps/menus/animations that run
            // under this line end up in the final video instead of a frozen still.
            const sceneFrameDir = join(sceneWorkDir, `frames-${String(sceneIndex).padStart(3, "0")}`);
            await mkdir(sceneFrameDir, { recursive: true });
            activeScene = scene;
            await forceActivePage(page);
            activeCapture = startFrameCapture(page, sceneFrameDir, SCENE_FRAME_INTERVAL_MS);
            console.log(`SCENE_CAPTURE index=${sceneIndex} duration_ms=${scene.durationMs} url=${urlAtSpeak} line="${(step.text ?? "").slice(0, 80)}"`);
            if (flowId) postProgress(flowId, {
              stage: "scene-capture",
              current: sceneIndex + 1,
              total: totalNarrateSteps,
              note: (step.text ?? "").slice(0, 80),
            });
          }
        }
        stepReport.ran += 1;
        continue;
      }

      if (step.action === "goto") {
        // Close the previous live scene before we navigate away from it.
        if (captureScenes) await finishActiveScene();
        const rawUrl = interpolate(step.url, nova);
        if (!rawUrl) throw new Error("url is required");
        let url = rawUrl.startsWith("http") ? rawUrl : `${nova.app_url}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
        const recorderFlags = { demo: "1", recording: "1", skipOnboarding: "1", lang: "en" };
        const u = new URL(url);
        for (const [k, v] of Object.entries(recorderFlags)) {
          if (!u.searchParams.has(k)) u.searchParams.set(k, v);
        }
        // Preselect the Alex demo profile so /chat and /profiles land ready to record.
        if ((u.pathname.startsWith("/chat") || u.pathname.startsWith("/profiles")) && !u.searchParams.has("profile")) {
          u.searchParams.set("profile", "alex");
        }
        url = u.toString();
        const currentPath = (() => { try { return new URL(page.url()).pathname; } catch { return null; } })();
        const targetPath = u.pathname;
        lastGotoPath = targetPath;
        if (page.url() === url) {
          console.log("[recording] already on", page.url());
          lastGotoSamePath = true;
        } else {
          // Setup gotos always get at least 8s so an exhausted narration budget
          // can never starve the navigation that prepares the next beat.
          const budget = remainingBudgetMs();
          const gotoTimeout = Math.max(8000, Math.min(30000, budget || 30000));
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoTimeout });
          // v14: don't wait for full networkidle — Nova's chat/streaming widgets
          // rarely idle within 10s, so this used to burn the full timeout on
          // every navigation. domcontentloaded + a short settle is enough;
          // real readiness gates use waitForEvent("nova:app-ready").
          await page.waitForTimeout(Math.min(600, Math.max(200, budget)));
          // v29: animation-heavy Calm tools (canvas/WebGL) need a beat to spin
          // their render loop up before capture starts, or the first seconds
          // record as a frozen frame.
          if (/sensory|calm|breath|gravity|slime|glitter|paint|bubble|aurora|star/i.test(u.pathname + u.search)) {
            await page.waitForTimeout(Math.min(900, Math.max(300, remainingBudgetMs() || 900))).catch(() => {});
          }
          const finalPath = (() => { try { return new URL(page.url()).pathname; } catch { return null; } })();
          lastGotoSamePath = !!(currentPath && finalPath && currentPath === finalPath);
          console.log("[recording] opened", page.url(), lastGotoSamePath ? "(same path)" : "");
          // v30: a fresh document resets Chrome's page lifecycle scheduling,
          // which is what let the freeze reappear on the 2nd/3rd scene even
          // after the initial page load was forced active.
          await forceActivePage(page);
        }
      } else if (step.action === "click") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        await ensureRouteForClick(page, selector, nova);
        const clicked = await clickSelector(page, selector, { optional: true, timeout: 6000 });
        if (!clicked) {
          // v34: a missing click target is reported but never aborts the beat.
          // Hard-failing here in v33 left the page mid-beat and cascaded into
          // every following scene failing route validation.
          stepReport.skipped.push({
            action: "click",
            caption: step.caption ?? null,
            error: `click target was not found: ${selector}`,
          });
          console.warn(`CLICK_SOFT_SKIP selector=${selector}`);
        }
        // After Text Chat click, confirm the chat input actually rendered.
        if (/chat-text|Text Chat/i.test(String(selector))) {
          const ok = await page.locator('[data-tour="chat-input"], [data-recorder="chat-input"], textarea').first()
            .waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
          if (!ok) console.log("[recording] chat input never rendered after Text Chat click; continuing");
        }
      } else if (step.action === "type") {
        await fillSelector(page, requireSelector(step, originalIndex >= 0 ? originalIndex : index), interpolate(step.text, nova));
      } else if (step.action === "wait") {
        await waitWithinBudget(step.ms ?? 500);
      } else if (step.action === "waitForChatReply") {
        // Wait for a new assistant chat bubble to appear so Nova's response
        // is on camera before the next step runs.
        const timeout = Math.max(250, Math.min(step.timeoutMs ?? 20000, remainingBudgetMs() || (step.timeoutMs ?? 20000)));
        const holdMs = step.holdMs ?? 2000;
        const baseline = await page.evaluate(() => {
          const candidates = document.querySelectorAll(
            "[data-role='assistant'], [data-message-role='assistant'], [data-tour='chat-message-assistant'], .assistant-message, .nova-message, [data-nova-role='assistant']",
          );
          return candidates.length;
        }).catch(() => 0);
        const grew = await page.waitForFunction(
          (base) => {
            const candidates = document.querySelectorAll(
              "[data-role='assistant'], [data-message-role='assistant'], [data-tour='chat-message-assistant'], .assistant-message, .nova-message, [data-nova-role='assistant']",
            );
            return candidates.length > base;
          },
          baseline,
          { timeout },
        ).then(() => true).catch(() => false);
        if (!grew) {
          console.log(`[recording] chat reply not detected within ${timeout}ms, holding anyway`);
        }
        await waitWithinBudget(holdMs);
      } else if (step.action === "slowScroll") {
        const durationMs = Math.max(1000, step.ms ?? 5000);
        await page.evaluate(async (duration) => {
          const root = document.scrollingElement ?? document.documentElement;
          const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
          if (maxY <= 0) return;
          const startY = window.scrollY;
          const started = performance.now();
          await new Promise((resolve) => {
            const tick = (now) => {
              const progress = Math.min(1, (now - started) / duration);
              const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
              window.scrollTo(0, startY + (maxY - startY) * eased);
              if (progress < 1) requestAnimationFrame(tick);
              else resolve();
            };
            requestAnimationFrame(tick);
          });
        }, durationMs);
      } else if (step.action === "drawHeart") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        const target = page.locator(selector).first();
        await target.waitFor({ state: "visible", timeout: 8000 });
        const box = await target.boundingBox();
        if (!box) throw new Error("drawing surface has no visible bounds");
        const durationMs = Math.max(1200, step.ms ?? 2800);
        const points = [];
        for (let i = 0; i <= 72; i += 1) {
          const t = (Math.PI * 2 * i) / 72;
          const x = 16 * Math.sin(t) ** 3;
          const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
          points.push({
            x: box.x + box.width * (0.5 + x / 40),
            y: box.y + box.height * (0.48 - y / 36),
          });
        }
        await page.mouse.move(points[0].x, points[0].y);
        await page.mouse.down();
        const delay = Math.max(8, Math.floor(durationMs / points.length));
        for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 1 }).then(() => page.waitForTimeout(delay));
        await page.mouse.up();
      } else if (step.action === "zoomTo") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "attached", timeout: 15000 });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      } else if (step.action === "scroll") {
        // v30: slow, steppy scroll so the screencast captures real intermediate
        // frames instead of one instant jump. Scrolls a selector's container if
        // given, otherwise the window. deltaY/steps/stepDelayMs are tunable per
        // step so a long feed can scroll slower than a short settings list.
        const targetSelector = step.selector ?? null;
        const totalDeltaY = step.deltaY ?? 600;
        const steps = Math.max(1, step.steps ?? 12);
        const stepDelayMs = step.stepDelayMs ?? 90;
        const perStep = totalDeltaY / steps;
        if (targetSelector) {
          const locator = page.locator(targetSelector).first();
          const box = await locator.boundingBox().catch(() => null);
          if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        }
        for (let i = 0; i < steps; i += 1) {
          if (targetSelector) {
            await page.evaluate(({ sel, dy }) => {
              const el = document.querySelector(sel);
              (el ?? window).scrollBy?.(0, dy) ?? window.scrollBy(0, dy);
            }, { sel: targetSelector, dy: perStep }).catch(() => {});
          } else {
            await page.mouse.wheel(0, perStep).catch(() => {});
          }
          await waitWithinBudget(stepDelayMs);
        }
      } else if (step.action === "draw") {
        // v30: simulate a hand drawing/tracing gesture (e.g. sensory draw/sand
        // canvases) as a real pointer-down + slow multi-point drag + pointer-up
        // sequence, so the screencast captures the stroke actually being drawn
        // instead of a single click producing an instant mark.
        const points = Array.isArray(step.points) ? step.points : [];
        if (points.length < 2) throw new Error("draw requires at least 2 points");
        const stepDelayMs = step.stepDelayMs ?? 40;
        const segmentsPerLeg = Math.max(1, step.segmentsPerLeg ?? 8);
        await page.mouse.move(points[0].x, points[0].y);
        await page.mouse.down();
        for (let i = 1; i < points.length; i += 1) {
          const from = points[i - 1];
          const to = points[i];
          for (let s2 = 1; s2 <= segmentsPerLeg; s2 += 1) {
            const t = s2 / segmentsPerLeg;
            await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            await waitWithinBudget(stepDelayMs);
          }
        }
        await page.mouse.up();
      } else if (step.action === "waitForEvent") {
        const event = step.event;
        const timeout = Math.max(250, Math.min(step.ms ?? 15000, remainingBudgetMs() || (step.ms ?? 15000)));
        if (!event) throw new Error("waitForEvent requires an event name");
        // v15: query-param-only navigations do not emit a fresh route-ready event
        // in Nova. A waitForEvent("nova:route-ready") after such a goto would burn
        // its full timeout and create a long silent gap. Treat it as satisfied.
        if (event === "nova:route-ready" && lastGotoSamePath) {
          console.log(`[recording] route-ready skipped (same-path navigation)`);
          lastGotoSamePath = false;
        } else {
          const baseline = await page.evaluate(
            (ev) => ((window.__nova && window.__nova.events) || []).filter((e) => e === ev).length,
            event,
          ).catch(() => 0);
          const fired = await page.waitForFunction(
            ({ ev, base }) => (((window.__nova && window.__nova.events) || []).filter((e) => e === ev).length) > base,
            { ev: event, base: baseline },
            { timeout },
          ).then(() => true).catch(() => false);
          if (!fired) console.log(`[recording] event ${event} not fired within ${timeout}ms, continuing`);
        }
        lastGotoSamePath = false;
      } else {
        throw new Error(`unknown action: ${step.action}`);
      }
      stepReport.ran += 1;
    } catch (e) {
      const labelIndex = originalIndex >= 0 ? originalIndex : index;
      const msg = String(e?.message ?? e).split("\n")[0];
      if (hasHitDeadline()) {
        console.log(`[recording] narration clock expired during ${stepLabel(labelIndex, step)}; stopping visual steps`);
        break;
      }
      // Soft-fail: log the failed step and keep going. The pre-generated
      // narration audio plays through regardless; a missing selector or a
      // transient wait failure should never kill the whole render.
      // The only hard-fail is a `goto` that couldn't even reach a URL, since
      // downstream steps can't recover from being on the wrong page.
      if (step.action === "goto") {
        throw new Error(`${stepLabel(labelIndex, step)} failed: ${msg}`);
      }
      console.log(`[recording] SKIP ${stepLabel(labelIndex, step)} failed: ${msg}`);
      stepReport.skipped.push({
        index: labelIndex,
        action: step.action,
        selector: step.selector ?? null,
        text: step.text ?? null,
        error: msg.slice(0, 400),
        url_at_failure: (() => { try { return page.url(); } catch { return null; } })(),
      });
    }
  }

  if (captureScenes) {
    // Close the final live scene: hold on camera until its spoken line is over,
    // then stop the frame burst. Assembly holds/compresses frames to the
    // measured narration duration, so the audio clock still wins.
    await finishActiveScene();
  } else if (recordingBudgetMs > 0) {
    const remaining = remainingBudgetMs();
    if (remaining > 0) await page.waitForTimeout(remaining);
  } else {
    // Pad the tail of the final narration group so the last line finishes speaking.
    if (currentNarration) {
      const elapsed = Date.now() - currentNarration.startedAt;
      const remaining = currentNarration.durationMs - elapsed;
      if (remaining > 0) await page.waitForTimeout(remaining);
    }

    // Give the last spoken line breathing room so the final syllable is never
    // clipped by browser video finalization or ffmpeg muxing.
    await page.waitForTimeout(400);
  }

  return stepReport;
};

const stage = (name, extra = "") => console.log(`\n===== [stage:${name}] ${extra} =====`);

// Fire-and-forget progress heartbeat. Never let a failed heartbeat break a render.
const postProgress = (flowId, progress) => {
  if (!flowId) return;
  api({ action: "heartbeat", id: flowId, progress }).catch((e) => {
    console.log("[progress] heartbeat failed:", String(e?.message ?? e).slice(0, 120));
  });
};

const stageWithProgress = (flowId, name, extra = "", extraProgress = {}) => {
  stage(name, extra);
  postProgress(flowId, { stage: name, note: extra, ...extraProgress });
};

const processFlow = async ({ flow, nova }) => {
  const flowStart = Date.now();
  console.log(`\n########## Processing flow ${flow.id} (${flow.name}) ##########`);
  if (!flow.mascot_url) {
    throw new Error("no mascot_url provided; Nova must appear on screen in every tutorial");
  }
  stageWithProgress(flow.id, "mascot-source", `${flow.mascot_is_image ? "image" : "MP4"} ${flow.mascot_url.slice(0, 100)}`);
  const workDir = await mkdtemp(join(tmpdir(), `flow-${flow.id}-`));
  const recordingMp4 = join(workDir, "recording.mp4");
  const fullRecordingMp4 = join(workDir, "recording-full.mp4");
  const paddedRecordingMp4 = join(workDir, "recording-padded.mp4");
  const normalizedRecordingMp4 = join(workDir, "recording-normalized.mp4");
  const normalizedMascotMp4 = join(workDir, "mascot-normalized.mp4");
  const compositedPath = join(workDir, "composited.mp4");
  const mascotIsImage = !!flow.mascot_is_image || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(flow.mascot_url || "");
  const mascotExt = mascotIsImage ? (flow.mascot_url.match(/\.(png|jpe?g|webp|gif)/i)?.[0] || ".png") : ".mp4";
  const mascotPath = join(workDir, `mascot${mascotExt}`);
  const narrationMp3 = join(workDir, "narration.mp3");
  const srtPath = join(workDir, "captions.srt");
  const vttPath = join(workDir, "captions.vtt");
  const flowScript = stripLegacyFillerNarration(flow.script || []);
  // v28: caption + mascot placement follows the target platform's safe zone.
  const captionPlatform = String(flow.caption_platform || process.env.CAPTION_PLATFORM || "tiktok").toLowerCase();
  const CAPTION_PRESET = resolveCaptionZone(captionPlatform);

  // Narration duration is required before capture. Without it, scenes only roll
  // for the fallback 500ms plus interaction waits, then ffmpeg freezes the last
  // frame for the rest of the spoken line.
  stageWithProgress(flow.id, "narration-preload", `${flowScript.filter((step) => step.action === "narrate").length} lines`);
  let narrationMap = await preloadNarration(flowScript, workDir);
  let narrationClockMs = applyContinuousNarrationTimeline(narrationMap);

  // Narration audio is written after recording, using actual per-line start
  // times. If a screen transition runs long, the final audio track gets silence,
  // not spoken filler.
  let hasNarration = false;
  let captionsSrtUrl = null;
  let captionsVttUrl = null;

  stageWithProgress(flow.id, "browser-launch");
  const browser = await chromium.launch({
    args: [
      // Software GL so canvas/WebGL surfaces in the Calm tools actually animate
      // in headless Chromium instead of painting once and freezing.
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      // v30: the screencast froze ~3s in because headless pages are never OS-
      // focused, so Chrome's per-tab "intensive wake up throttling" and
      // occlusion tracking treat them as backgrounded and cut rAF/timers down
      // to ~1Hz shortly after load. These flags plus the forced lifecycle
      // state below (see forceActivePage) are what actually keep the render
      // loop running for the whole scene, not just the args disabling window
      // backgrounding above.
      "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,TranslateUI",
      "--disable-ipc-flooding-protection",
    ],
  });

  // 1. Reuse the initialized demo account state between renders.
  stageWithProgress(flow.id, "auth-warmup");
  let loginPayload = await fetchDemoLoginPayload(nova, !cachedNovaStorageState || !isCacheFresh(cachedNovaStorageStateAt));
  let storageState = cachedNovaStorageState && isCacheFresh(cachedNovaStorageStateAt)
    ? cachedNovaStorageState
    : null;
  if (storageState) {
    console.log("[auth] reusing cached browser storage state");
  } else {
    storageState = await warmUpStorageState({ browser, nova, loginPayload });
    cachedNovaStorageState = storageState;
    cachedNovaStorageStateAt = Date.now();
  }

  // 2. Deterministic mode: open Nova off camera, drive each beat to its target
  // screen, and capture a still at the exact moment its narration should begin.
  // The final video is assembled from these stills, each held for the measured
  // narration duration. No live page timing can freeze or drift under the audio.
  stageWithProgress(flow.id, "scene-capture-start", `${flowScript.length} script steps`);
  const { context, page } = await prepareScenePage({ browser, storageState, nova, loginPayload });
  let scriptStartedAt = Date.now();

  let prepOk = false;
  try {
    const prepUrl = `${nova.app_url.replace(/\/+$/, "")}/?demo=1&recording=1&skipOnboarding=1&lang=en&profile=alex`;
    console.log("[scenes] prep-navigate", prepUrl);
    await page.goto(prepUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    prepOk = await page.locator("body").waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
  } catch (e) {
    console.log("[scenes] prep-navigate failed:", String(e?.message ?? e).split("\n")[0]);
  }
  if (!prepOk || page.url() === "about:blank") throw new Error("Nova prep navigation did not render before scene capture started");
  scriptStartedAt = Date.now();

  let stepReport = { skipped: [], ran: 0, total: flowScript.length, scenes: [], scene_checks: [], worker_version: WORKER_VERSION };
  try {
    stepReport = await runScript(page, flowScript, nova, narrationMap, scriptStartedAt, 0, { captureScenes: true, sceneWorkDir: workDir, flowId: flow.id });
    if (await detectLanguageGate(page)) {
      cachedNovaStorageState = null;
      cachedNovaStorageStateAt = 0;
      cachedNovaLoginPayload = null;
      cachedNovaLoginPayloadAt = 0;
      throw new Error("scene capture started on the language picker instead of an initialized Nova session");
    }
  } finally {
    await context.close();
    await browser.close();
  }
  stageWithProgress(flow.id, "scene-capture-done", `${stepReport.ran}/${stepReport.total} ran, ${stepReport.scenes.length} scenes, ${stepReport.skipped.length} skipped`);

  // v25: a beat that could not be validated or captured no longer kills the
  // render. We log it, and the neighbouring scene absorbs its narration time so
  // audio and picture stay in sync.
  const failedScenes = stepReport.scene_checks.filter((scene) => !scene.ok);
  if (failedScenes.length) {
    console.warn(`SCENE_SOFT_FAIL flow=${flow.id} features=${failedScenes.map((s) => s.feature).join(", ")}`);
  }
  const spokenBeats = flowScript.filter((step) => step.action === "narrate").length;
  if (stepReport.scenes.length !== spokenBeats) {
    console.warn(`SCENE_COUNT_MISMATCH flow=${flow.id} captured=${stepReport.scenes.length} spoken=${spokenBeats}`);
  }

  const finalScene = stepReport.scenes[stepReport.scenes.length - 1];
  const finalIsCta = !!finalScene && (
    String(finalScene.screenActionId ?? "").startsWith("cta.")
    || String(finalScene.expectedUrl ?? "").includes("/promo-cta")
    || String(finalScene.url ?? "").includes("/promo-cta")
  );
  if (!finalIsCta) {
    throw new Error(`Closing CTA was not captured as the final scene. Final scene was ${finalScene?.url ?? "missing"}.`);
  }

  stageWithProgress(flow.id, "all-scenes-approved", `${stepReport.scenes.length} screens ready`);
  const scenesByStep = new Map(stepReport.scenes.map((scene) => [scene.stepIndex, scene]));
  for (const scene of stepReport.scenes) scene.durationMs = 0;
  let lastScene = null;
  const orphanNarrations = [];
  for (const narration of [...narrationMap].sort((a, b) => a.stepIndex - b.stepIndex)) {
    const scene = scenesByStep.get(narration.stepIndex);
    const ms = Math.max(0, narration.durationMs || 0);
    if (scene) {
      scene.durationMs += ms;
      lastScene = scene;
    } else if (lastScene) {
      lastScene.durationMs += ms;
      orphanNarrations.push(narration.stepIndex);
    } else {
      orphanNarrations.push(narration.stepIndex);
    }
  }
  // Any narration before the very first captured scene is absorbed by that scene.
  if (orphanNarrations.length && stepReport.scenes.length) {
    const leading = narrationMap
      .filter((n) => orphanNarrations.includes(n.stepIndex) && n.stepIndex < stepReport.scenes[0].stepIndex)
      .reduce((sum, n) => sum + Math.max(0, n.durationMs || 0), 0);
    if (leading > 0) stepReport.scenes[0].durationMs += leading;
    console.warn(`SCENE_ORPHAN_NARRATION flow=${flow.id} steps=${orphanNarrations.join(",")}`);
  }
  for (const scene of stepReport.scenes) scene.durationMs = Math.max(500, scene.durationMs);

  if (narrationMap.length > 0) {
    stageWithProgress(flow.id, "narration-timeline", `${narrationMap.length} segments`);
    hasNarration = await writeTimedNarrationTrack({ workDir, narrationTimeline: narrationMap, narrationMp3 });

    // Build + persist SRT/VTT sidecars aligned to the actual narration timeline.
    const { srt, vtt } = buildCaptions(narrationMap);
    await writeFile(srtPath, srt);
    await writeFile(vttPath, vtt);
    try {
      captionsSrtUrl = await uploadSidecar(flow.id, "srt", "application/x-subrip", srt);
      captionsVttUrl = await uploadSidecar(flow.id, "vtt", "text/vtt", vtt);
      console.log(`[captions] uploaded srt+vtt sidecars`);
    } catch (e) {
      console.error("[captions] sidecar upload failed, continuing with burn only", e);
    }
  }

  if (!stepReport.scenes.length) throw new Error("no scenes captured from tutorial narration");
  stageWithProgress(flow.id, "assemble-scenes", `${stepReport.scenes.length} stills`);
  const sceneRecordingMs = await writeSceneVideo({ workDir, scenes: stepReport.scenes, outputPath: recordingMp4 });

  const narrationTrackMs = hasNarration ? await getMediaDurationMs(narrationMp3) : 0;
  const narrationEndMs = Math.max(
    narrationTrackMs,
    narrationMap.reduce((max, n) => Math.max(max, (Number.isFinite(n.startMs) ? n.startMs : 0) + n.durationMs), 0),
  );
  const trimmedRecordingMs = sceneRecordingMs || await getMediaDurationMs(recordingMp4);
  // v19: narration is the authoritative clock. Scenes are already assembled to
  // the same per-line durations, then trimmed or padded to the narration tail.
  const targetVideoMs = hasNarration && narrationEndMs > 0
    ? narrationEndMs + NARRATION_TAIL_MS
    : (trimmedRecordingMs > 0 ? trimmedRecordingMs : 0);
  let baseRecordingMp4 = recordingMp4;
  if (targetVideoMs > 0) {
    const padMs = targetVideoMs - trimmedRecordingMs;
    if (padMs > 80) {
      const padSec = (padMs / 1000).toFixed(3);
      stageWithProgress(flow.id, "pad-recording-tail", `${padSec}s`);
      await sh("ffmpeg", ["-y", "-i", recordingMp4, "-vf", `tpad=stop_mode=clone:stop_duration=${padSec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", paddedRecordingMp4]);
      baseRecordingMp4 = paddedRecordingMp4;
    } else if (padMs < -80) {
      stageWithProgress(flow.id, "trim-recording-to-narration", `${(-padMs / 1000).toFixed(3)}s cut`);
    }
    // normalizeVideoDuration hard-caps the base recording at exactly
    // targetVideoMs (via `-t`), so an over-long recording gets truncated to
    // match the narration clock.
    const normalizedBaseMs = await normalizeVideoDuration({
      inputPath: baseRecordingMp4,
      outputPath: normalizedRecordingMp4,
      durationMs: targetVideoMs,
      loop: false,
    });
    baseRecordingMp4 = normalizedRecordingMp4;
    console.log(`[timing] narration=${narrationEndMs}ms recording=${trimmedRecordingMs}ms target=${targetVideoMs}ms normalized_recording=${normalizedBaseMs}ms`);
  }

  // 3. Single-pass composite: screen recording (base) + mascot overlay (bottom-right,
  // TikTok safe zone) + narration audio track. One final MP4, everything synced.
  const inputs = ["-y", "-i", baseRecordingMp4];
  const filterParts = [];
  let videoLabel = "0:v";
  let mascotInputIdx = -1;

  if (flow.mascot_url) {
    const rawUrl = String(flow.mascot_url).trim();
    let absoluteUrl = rawUrl;
    if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
      if (rawUrl.startsWith("/")) absoluteUrl = `${nova.app_url.replace(/\/+$/, "")}${rawUrl}`;
      else throw new Error(`mascot_url is not a valid fetchable URL: ${rawUrl}`);
    }
    const mascotBuf = await (await fetch(absoluteUrl)).arrayBuffer();
    await writeFile(mascotPath, Buffer.from(mascotBuf));
    const mascotSourceMs = await getMediaDurationMs(mascotPath);
    if (!mascotIsImage && targetVideoMs > 0) {
      const normalizedMascotMs = await normalizeVideoDuration({
        inputPath: mascotPath,
        outputPath: normalizedMascotMp4,
        durationMs: targetVideoMs,
        loop: true,
      });
      console.log(`[timing] mascot_source=${mascotSourceMs}ms normalized_mascot=${normalizedMascotMs}ms`);
    } else {
      console.log(`[timing] mascot_source=${mascotSourceMs}ms image=${mascotIsImage}`);
    }
    mascotInputIdx = inputs.length / 2; // after -y placeholder trick, count -i entries
    inputs.push("-i", mascotPath);
  }
  if (hasNarration) inputs.push("-i", narrationMp3);

  // Rebuild input index tracking properly.
  const inputFiles = [baseRecordingMp4];
  if (flow.mascot_url) inputFiles.push(!mascotIsImage && targetVideoMs > 0 ? normalizedMascotMp4 : mascotPath);
  if (hasNarration) inputFiles.push(narrationMp3);
  const recIdx = 0;
  const mascotIdx = flow.mascot_url ? 1 : -1;
  const audioIdx = hasNarration ? (flow.mascot_url ? 2 : 1) : -1;

  const ffArgs = ["-y"];
  for (let i = 0; i < inputFiles.length; i += 1) {
    const f = inputFiles[i];
    // Still images need ffmpeg to synthesize frames. Animated mascots are
    // normalized to the full authoritative target duration before this step.
    if (i === mascotIdx && mascotIsImage) ffArgs.push("-loop", "1", "-framerate", "30");
    ffArgs.push("-i", f);
  }

  if (mascotIdx >= 0) {
    // Mascot as a small corner overlay (bottom-LEFT) on top of the screen recording,
    // lifted above the platform's bottom caption/username strip.
    // (v28) bottom offset comes from the platform safe-zone preset.
    filterParts.push(`[${mascotIdx}:v][${recIdx}:v]scale2ref=w=iw*0.22:h=ow/mdar[m][base]`);
    filterParts.push(`[base][m]overlay=20:H-h-${CAPTION_PRESET.mascotBottom}[vout]`);
    videoLabel = "[vout]";
  } else {
    filterParts.push(`[${recIdx}:v]null[vout]`);
    videoLabel = "[vout]";
  }

  // Burn captions on top of whatever the video chain produced so far.
  // v28: captions are ON by default and positioned inside the selected platform's
  // safe zone (see CAPTION_SAFE_ZONES). Set BURN_CAPTIONS=0 to disable burning;
  // the .srt/.vtt sidecars are uploaded either way.
  const burnCaptions = flow.burn_captions === false
    ? false
    : /^(1|true|yes|on)$/i.test(String(process.env.BURN_CAPTIONS ?? "1"));
  if (hasNarration && burnCaptions) {
    // ffmpeg subtitles filter path escaping: escape :, ', \
    const esc = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const p = CAPTION_PRESET;
    const fontSize = Number(process.env.CAPTION_FONT_SIZE || p.fontSize);
    const marginV = Number(process.env.CAPTION_MARGIN_V || p.marginV);
    const style = `FontName=DejaVu Sans,FontSize=${fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=${p.alignment},MarginV=${marginV},MarginL=${p.marginL},MarginR=${p.marginR},Bold=1`;
    // original_size pins libass to the real 1080x1920 frame so margins are true pixels
    // (without it libass assumes 384px-tall script res and margins get multiplied ~5x,
    //  which is what pushed captions to the top of frame before v28).
    filterParts.push(`${videoLabel}subtitles='${esc}':original_size=${CAPTION_FRAME_W}x${CAPTION_FRAME_H}:force_style='${style}'[vsub]`);
    videoLabel = "[vsub]";
    console.log(`[captions] platform=${captionPlatform} align=${p.alignment} marginV=${marginV} font=${fontSize}`);
  }

  if (filterParts.length) {
    ffArgs.push("-filter_complex", filterParts.join(";"));
    ffArgs.push("-map", videoLabel);
  } else {
    ffArgs.push("-map", `${recIdx}:v`);
  }

  if (audioIdx >= 0) {
    ffArgs.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "192k");
  } else {
    ffArgs.push("-an");
    if (mascotIsImage) ffArgs.push("-shortest");
  }
  if (targetVideoMs > 0) ffArgs.push("-t", (targetVideoMs / 1000).toFixed(3));
  ffArgs.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", compositedPath);
  stageWithProgress(flow.id, "compositing", `mascot=${mascotIdx >= 0} narration=${hasNarration}`);
  await sh("ffmpeg", ffArgs);
  const finalVideoMs = await getMediaDurationMs(compositedPath);
  console.warn(`TIMING_REPORT flow=${flow.id} worker=${WORKER_VERSION} narration_track_ms=${narrationTrackMs} narration_clock_ms=${narrationClockMs} target_ms=${targetVideoMs} recording_ms=${trimmedRecordingMs} final_ms=${finalVideoMs}`);
  console.log(`[timing] final=${finalVideoMs}ms target=${targetVideoMs}ms`);
  if (targetVideoMs > 0 && finalVideoMs + 250 < targetVideoMs) {
    throw new Error(`final video cut short: final=${finalVideoMs}ms target=${targetVideoMs}ms`);
  }
  if (targetVideoMs > 0 && finalVideoMs > targetVideoMs + 1500) {
    throw new Error(`final video exceeded narration clock: final=${finalVideoMs}ms target=${targetVideoMs}ms`);
  }

  // 4. Upload the final composite.
  stageWithProgress(flow.id, "upload-final-mp4");
  const { uploadUrl, viewUrl } = await api({ action: "getUploadUrl", id: flow.id, ext: "mp4" });
  const buf = await readFile(compositedPath);
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: buf,
  });
  if (!upRes.ok) throw new Error(`storage upload ${upRes.status}: ${await upRes.text()}`);

  const publicStepReport = {
    ...stepReport,
    recorder_plan: flow.recorder_plan ?? null,
    scene_count: stepReport.scenes?.length ?? 0,
    scenes: (stepReport.scenes ?? []).map((scene, index) => ({
      index,
      durationMs: scene.durationMs,
      line: scene.line,
      url: scene.url,
      stepIndex: scene.stepIndex,
      beatId: scene.beatId,
      feature: scene.feature,
      screenActionId: scene.screenActionId,
      expectedUrl: scene.expectedUrl,
      ok: scene.ok,
    })),
    worker_version: WORKER_VERSION,
  };

  await rm(workDir, { recursive: true, force: true });
  stage("finished", `${Math.round((Date.now() - flowStart) / 1000)}s total`);
  return { composited_url: viewUrl, recording_url: null, duration_ms: finalVideoMs || targetVideoMs || null, captions_srt_url: captionsSrtUrl, captions_vtt_url: captionsVttUrl, step_report: publicStepReport };
};

const loop = async () => {
  while (true) {
    try {
      const { flow, nova } = await api({ action: "claim" });
      if (!flow) {
        console.log("[loop] no work, sleeping…");
        await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
        continue;
      }
      console.log(`[claim] ${flow.id} ${flow.name}`);
      try {
        const { composited_url, recording_url, duration_ms, captions_srt_url, captions_vtt_url, step_report } = await processFlow({ flow, nova });
        await api({ action: "complete", id: flow.id, composited_url, recording_url, duration_ms, captions_srt_url, captions_vtt_url, step_report });
        console.log(`[done]  ${flow.id}`);
      } catch (e) {
        console.error(`[fail]  ${flow.id}`, e);
        await api({ action: "fail", id: flow.id, error: e.message, step_report: e.stepReport ?? null });
      }
    } catch (e) {
      console.error("[loop]", e);
      await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
    }
  }
};

loop();

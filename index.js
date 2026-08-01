// Nova Tutorial Recorder worker.
// Polls the tutorial-worker edge function, records the Nova app with Playwright,
// composites the mascot MP4 with ffmpeg, uploads the final 9:16 MP4, and reports back.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fetch from "node-fetch";

const {
  WORKER_API_URL,
  TUTORIAL_WORKER_TOKEN,
  POLL_INTERVAL_MS = "10000",
} = process.env;

const WORKER_VERSION = "2026-08-01-soft-steps-v22-a1b2c3d";
const NARRATION_TAIL_MS = 800;

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

const prepareScenePage = async ({ browser, storageState, nova, loginPayload }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    storageState,
  });
  await installStartupState(context, nova, loginPayload);
  const page = await context.newPage();
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
    if (s.action !== "narrate" || !s.text?.trim()) continue;
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

const writeSceneVideo = async ({ workDir, scenes, outputPath }) => {
  if (!scenes.length) throw new Error("no deterministic scenes captured");
  const listPath = join(workDir, "scenes.txt");
  const lines = [];
  for (const scene of scenes) {
    lines.push(concatFileLine(scene.imagePath));
    lines.push(`duration ${(Math.max(500, scene.durationMs) / 1000).toFixed(3)}`);
  }
  // concat demuxer needs the final image repeated or the last duration is ignored.
  lines.push(concatFileLine(scenes[scenes.length - 1].imagePath));
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

  if (!out.length || (out[0].step.action !== "goto" && out[0].step.action !== "narrate")) {
    out.unshift({ step: { action: "goto", url: "/" }, originalIndex: -1 });
  }
  return out;
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
  const stepReport = { skipped: [], ran: 0, total: steps.length, scenes: [], scene_checks: [], worker_version: WORKER_VERSION };
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
          const check = {
            beatId: step.beatId ?? `beat-${stepReport.scenes.length + 1}`,
            feature: step.beatFeature ?? "Scene",
            screenActionId: step.screenActionId ?? null,
            expectedUrl,
            actualUrl,
            ok: routeOk && stable,
            error: !routeOk ? "Expected Nova route was not open" : !stable ? "Screen did not become visually stable" : null,
          };
          stepReport.scene_checks.push(check);
          if (flowId) postProgress(flowId, {
            stage: "scene-validation",
            current: stepReport.scene_checks.length,
            total: totalNarrateSteps,
            note: `${check.feature} ${check.ok ? "ready" : "failed"}`,
            scene_check: check,
          });
          if (!check.ok) {
            const validationError = new Error(`${check.feature} validation failed: ${check.error}. Expected ${expectedUrl}, got ${actualUrl}`);
            validationError.stepReport = stepReport;
            throw validationError;
          }
          const sceneIndex = stepReport.scenes.length;
          const imagePath = join(sceneWorkDir, `scene-${String(sceneIndex).padStart(3, "0")}.png`);
          await page.screenshot({ path: imagePath, fullPage: false });
          const scene = {
            imagePath,
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
          console.log(`SCENE_CAPTURE index=${sceneIndex} duration_ms=${scene.durationMs} url=${urlAtSpeak} line="${(step.text ?? "").slice(0, 80)}"`);
          if (flowId) postProgress(flowId, {
            stage: "scene-capture",
            current: sceneIndex + 1,
            total: totalNarrateSteps,
            note: (step.text ?? "").slice(0, 80),
          });
        }
        stepReport.ran += 1;
        continue;
      }

      if (step.action === "goto") {
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
          const finalPath = (() => { try { return new URL(page.url()).pathname; } catch { return null; } })();
          lastGotoSamePath = !!(currentPath && finalPath && currentPath === finalPath);
          console.log("[recording] opened", page.url(), lastGotoSamePath ? "(same path)" : "");
        }
      } else if (step.action === "click") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        await ensureRouteForClick(page, selector, nova);
        await clickSelector(page, selector, { optional: true, timeout: 4000 });
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
      } else if (step.action === "zoomTo") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "attached", timeout: 15000 });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
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
    // Deterministic scene mode does not record real time. Each captured still is
    // later held for its exact narration duration, so no deadline padding here.
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

  // Validate and capture every requested Nova screen before generating paid
  // narration. This stops bad routes and selectors before they consume credits.
  let narrationMap = [];
  let narrationClockMs = 0;
  console.log("[validation] paid narration remains blocked until every requested screen is approved");

  // Narration audio is written after recording, using actual per-line start
  // times. If a screen transition runs long, the final audio track gets silence,
  // not spoken filler.
  let hasNarration = false;
  let captionsSrtUrl = null;
  let captionsVttUrl = null;

  stageWithProgress(flow.id, "browser-launch");
  const browser = await chromium.launch();

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

  const failedScenes = stepReport.scene_checks.filter((scene) => !scene.ok);
  if (failedScenes.length) throw new Error(`Scene validation failed for ${failedScenes.map((scene) => scene.feature).join(", ")}`);
  if (stepReport.scenes.length !== flowScript.filter((step) => step.action === "narrate").length) {
    throw new Error(`Scene validation incomplete: captured ${stepReport.scenes.length} of ${flowScript.filter((step) => step.action === "narrate").length} spoken beats`);
  }

  stageWithProgress(flow.id, "all-scenes-approved", `${stepReport.scenes.length} screens ready`);
  stageWithProgress(flow.id, "narration-preload", `${flowScript.filter((s) => s.action === "narrate").length} lines`);
  narrationMap = await preloadNarration(flowScript, workDir);
  narrationClockMs = applyContinuousNarrationTimeline(narrationMap);
  for (const scene of stepReport.scenes) {
    const narration = narrationMap.find((item) => item.stepIndex === scene.stepIndex);
    if (!narration) throw new Error(`Narration missing for approved scene ${scene.feature}`);
    scene.durationMs = Math.max(500, narration.durationMs || 0);
  }

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
    // Mascot as a small corner overlay (bottom-LEFT) on top of the screen recording.
    // Scale relative to the base recording width (~22%) using scale2ref so a huge
    // source PNG/MP4 does not cover the screen.
    filterParts.push(`[${mascotIdx}:v][${recIdx}:v]scale2ref=w=iw*0.22:h=ow/mdar[m][base]`);
    // 20px left margin, 160px bottom margin (keep clear of TikTok-style captions).
    filterParts.push(`[base][m]overlay=20:H-h-160[vout]`);
    videoLabel = "[vout]";
  } else {
    filterParts.push(`[${recIdx}:v]null[vout]`);
    videoLabel = "[vout]";
  }

  // Burn captions on top of whatever the video chain produced so far.
  if (hasNarration) {
    // ffmpeg subtitles filter path escaping: escape :, ', \
    const esc = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const style = "FontName=DejaVu Sans,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=220,Bold=1";
    filterParts.push(`${videoLabel}subtitles='${esc}':force_style='${style}'[vsub]`);
    videoLabel = "[vsub]";
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

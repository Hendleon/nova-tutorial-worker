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

const WORKER_VERSION = "2026-07-03-mascot-url-robust-v5";

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

const isSafeOptionalClick = (selector) => {
  const sel = String(selector ?? "");
  return sel.includes("profile-alex") || /has-text\(["']Alex["']\)/.test(sel);
};

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
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

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
        await page.waitForTimeout(800);
        break;
      }
    }
    if (!clicked) clicked = await clickByText(page, /^(Continue|Get Started|Get started|Next|Done|Start)$/i);
    if (clicked) await page.waitForTimeout(800);
    if (!clicked) break;
  }

  if (await detectLanguageGate(page)) {
    console.log("[warmup] language gate still visible; forcing startup flags and retrying");
    await applyStartupStateToPage(page, nova, loginPayload).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await clickByText(page, /^English$/i);
    await page.waitForTimeout(400);
    await clickByText(page, /^(Continue|Get Started|Get started|Next|Done|Start)$/i);
    await page.waitForTimeout(1000);
  }

  // Give the app time to finish auto-login and strip the token from the URL.
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    recordVideo: { dir: workDir, size: { width: 390, height: 844 } },
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
const preloadNarration = async (script) => {
  const out = [];
  for (let i = 0; i < script.length; i += 1) {
    const s = script[i];
    if (s.action !== "narrate" || !s.text?.trim()) continue;
    console.log(`[narrate] generating audio for step ${i + 1}: "${s.text.slice(0, 60)}..."`);
    const audio = await fetchNarrationAudio(s.text);
    out.push({ stepIndex: i, durationMs: audio.durationMs, buffer: audio.buffer, text: s.text });
  }
  return out;
};

// Strip performance cues like [warm], [excited] from narration copy for on-screen captions.
const cleanCaptionText = (t) => String(t ?? "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();

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
    if (!text) { cursor += n.durationMs; continue; }
    const start = cursor;
    const end = cursor + n.durationMs;
    srtLines.push(String(idx));
    srtLines.push(`${msToSrtTs(start)} --> ${msToSrtTs(end)}`);
    srtLines.push(text);
    srtLines.push("");
    vttLines.push(`${msToVttTs(start)} --> ${msToVttTs(end)}`);
    vttLines.push(text);
    vttLines.push("");
    cursor += n.durationMs;
    idx += 1;
  }
  return { srt: srtLines.join("\n"), vtt: vttLines.join("\n") };
};

// PUT a sidecar file (srt/vtt) to storage via the same signed upload flow and return the view URL.
const uploadSidecar = async (flowId, ext, contentType, body) => {
  const { uploadUrl, viewUrl } = await api({ action: "getUploadUrl", id: flowId, ext });
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body });
  if (!res.ok) throw new Error(`sidecar ${ext} upload ${res.status}: ${await res.text()}`);
  return viewUrl;
};


const runScript = async (page, script, nova, narrationMap) => {
  // Skip any autologin goto steps at the head of the script.
  const steps = script
    .map((step, originalIndex) => ({ step, originalIndex }))
    .filter(({ step }) => !(step.action === "goto" && String(step.url ?? "").includes("autologin=")));
  if (!steps.length || (steps[0].step.action !== "goto" && steps[0].step.action !== "narrate")) {
    steps.unshift({ step: { action: "goto", url: "/" }, originalIndex: -1 });
  }

  // Pair each narrate step with the following non-narrate steps; after those
  // run, pad so the group lasts at least as long as the narration audio.
  // This is the "screen waits for mascot" strategy.
  let currentNarration = null; // { durationMs, startedAt }

  for (const [index, item] of steps.entries()) {
    const { step, originalIndex } = item;
    try {
      if (step.action === "narrate") {
        // Close out any previous narration group first (pad if steps ran short).
        if (currentNarration) {
          const elapsed = Date.now() - currentNarration.startedAt;
          const remaining = currentNarration.durationMs - elapsed;
          if (remaining > 0) await page.waitForTimeout(remaining);
        }
        const narr = (narrationMap || []).find((n) => n.stepIndex === originalIndex || n.stepIndex === index);
        currentNarration = narr
          ? { durationMs: narr.durationMs, startedAt: Date.now() }
          : null;
        console.log(`[recording] narrate: "${(step.text ?? "").slice(0, 60)}..." (${narr?.durationMs ?? 0}ms)`);
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
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        console.log("[recording] opened", page.url());
      } else if (step.action === "click") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        await ensureRouteForClick(page, selector, nova);
        await clickSelector(page, selector, { optional: isSafeOptionalClick(selector), timeout: 7000 });
      } else if (step.action === "type") {
        await fillSelector(page, requireSelector(step, originalIndex >= 0 ? originalIndex : index), interpolate(step.text, nova));
      } else if (step.action === "wait") {
        await page.waitForTimeout(step.ms ?? 500);
      } else if (step.action === "waitForChatReply") {
        // Wait for a new assistant chat bubble to appear so Nova's response
        // is on camera before the next step runs.
        const timeout = step.timeoutMs ?? 20000;
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
        await page.waitForTimeout(holdMs);
      } else if (step.action === "zoomTo") {
        const selector = requireSelector(step, originalIndex >= 0 ? originalIndex : index);
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "attached", timeout: 15000 });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      } else if (step.action === "waitForEvent") {
        const event = step.event;
        const timeout = step.ms ?? 15000;
        if (!event) throw new Error("waitForEvent requires an event name");
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
      } else {
        throw new Error(`unknown action: ${step.action}`);
      }
    } catch (e) {
      const labelIndex = originalIndex >= 0 ? originalIndex : index;
      throw new Error(`${stepLabel(labelIndex, step)} failed: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }

  // Pad the tail of the final narration group so the last line finishes speaking.
  if (currentNarration) {
    const elapsed = Date.now() - currentNarration.startedAt;
    const remaining = currentNarration.durationMs - elapsed;
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
};

const processFlow = async ({ flow, nova }) => {
  if (!flow.mascot_url) {
    throw new Error("no mascot_url provided; Nova must appear on screen in every tutorial");
  }
  const workDir = await mkdtemp(join(tmpdir(), `flow-${flow.id}-`));
  const recordingMp4 = join(workDir, "recording.mp4");
  const compositedPath = join(workDir, "composited.mp4");
  const mascotIsImage = !!flow.mascot_is_image || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(flow.mascot_url || "");
  const mascotExt = mascotIsImage ? (flow.mascot_url.match(/\.(png|jpe?g|webp|gif)/i)?.[0] || ".png") : ".mp4";
  const mascotPath = join(workDir, `mascot${mascotExt}`);
  const narrationMp3 = join(workDir, "narration.mp3");

  // 0. Pre-generate all narration audio BEFORE opening the browser, so pacing
  // during recording doesn't depend on any network round-trip.
  const narrationMap = await preloadNarration(flow.script || []);
  console.log(`[narrate] preloaded ${narrationMap.length} segments`);

  // Concat all narration MP3s in order → single narration track that will play
  // over the final composite. Since the recorder paces each group to match the
  // audio length (screen waits for mascot), concatenating with no gaps stays
  // in sync with the recorded visuals.
  let hasNarration = false;
  let captionsSrtUrl = null;
  let captionsVttUrl = null;
  const srtPath = join(workDir, "captions.srt");
  if (narrationMap.length > 0) {
    const segmentPaths = [];
    for (let i = 0; i < narrationMap.length; i += 1) {
      const p = join(workDir, `narr-${i}.mp3`);
      await writeFile(p, narrationMap[i].buffer);
      segmentPaths.push(p);
    }
    const listPath = join(workDir, "narration.txt");
    await writeFile(listPath, segmentPaths.map((p) => `file '${p}'`).join("\n"));
    await sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", narrationMp3]);
    hasNarration = true;

    // Build + persist SRT/VTT sidecars aligned to the concatenated narration timeline.
    const { srt, vtt } = buildCaptions(narrationMap);
    await writeFile(srtPath, srt);
    const vttPath = join(workDir, "captions.vtt");
    await writeFile(vttPath, vtt);
    try {
      captionsSrtUrl = await uploadSidecar(flow.id, "srt", "application/x-subrip", srt);
      captionsVttUrl = await uploadSidecar(flow.id, "vtt", "text/vtt", vtt);
      console.log(`[captions] uploaded srt+vtt sidecars`);
    } catch (e) {
      console.error("[captions] sidecar upload failed, continuing with burn only", e);
    }
  }

  const browser = await chromium.launch();

  // 1. Reuse the initialized demo account state between renders.
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

  // 2. Open a fresh RECORDED context using that warmed-up state.
  const { context, page } = await prepareRecordedPage({ browser, workDir, storageState, nova, loginPayload });

  try {
    await runScript(page, flow.script, nova, narrationMap);
    if (await detectLanguageGate(page)) {
      cachedNovaStorageState = null;
      cachedNovaStorageStateAt = 0;
      cachedNovaLoginPayload = null;
      cachedNovaLoginPayloadAt = 0;
      throw new Error("recording started on the language picker instead of an initialized Nova session");
    }
  } finally {
    await page.waitForTimeout(500);
    await context.close();
    await browser.close();
  }

  const { readdir } = await import("node:fs/promises");
  const webm = (await readdir(workDir)).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no recording captured");
  await sh("ffmpeg", ["-y", "-i", join(workDir, webm), "-c:v", "libx264", "-pix_fmt", "yuv420p", recordingMp4]);

  // 3. Single-pass composite: screen recording (base) + mascot overlay (bottom-right,
  // TikTok safe zone) + narration audio track. One final MP4, everything synced.
  const inputs = ["-y", "-i", recordingMp4];
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
    mascotInputIdx = inputs.length / 2; // after -y placeholder trick, count -i entries
    inputs.push("-i", mascotPath);
  }
  if (hasNarration) inputs.push("-i", narrationMp3);

  // Rebuild input index tracking properly.
  const inputFiles = [recordingMp4];
  if (flow.mascot_url) inputFiles.push(mascotPath);
  if (hasNarration) inputFiles.push(narrationMp3);
  const recIdx = 0;
  const mascotIdx = flow.mascot_url ? 1 : -1;
  const audioIdx = hasNarration ? (flow.mascot_url ? 2 : 1) : -1;

  const ffArgs = ["-y"];
  for (let i = 0; i < inputFiles.length; i += 1) {
    const f = inputFiles[i];
    // Loop still-image mascot so it lasts as long as the recording.
    if (i === mascotIdx && mascotIsImage) ffArgs.push("-loop", "1", "-framerate", "30");
    ffArgs.push("-i", f);
  }

  if (mascotIdx >= 0) {
    filterParts.push(`[${mascotIdx}:v]scale=iw*0.4:-1[m]`);
    // For a looped image, don't use shortest=1 on overlay (recording drives length via -shortest at end).
    const overlaySuffix = mascotIsImage ? "" : ":shortest=1";
    filterParts.push(`[${recIdx}:v][m]overlay=W-w-20:H-h-160${overlaySuffix}[vout]`);
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
    ffArgs.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "192k", "-shortest");
  } else {
    ffArgs.push("-an");
    if (mascotIsImage) ffArgs.push("-shortest");
  }
  ffArgs.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", compositedPath);
  await sh("ffmpeg", ffArgs);

  // 4. Upload the final composite.
  const { uploadUrl, viewUrl } = await api({ action: "getUploadUrl", id: flow.id, ext: "mp4" });
  const buf = await readFile(compositedPath);
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: buf,
  });
  if (!upRes.ok) throw new Error(`storage upload ${upRes.status}: ${await upRes.text()}`);

  await rm(workDir, { recursive: true, force: true });
  return { composited_url: viewUrl, recording_url: null, captions_srt_url: captionsSrtUrl, captions_vtt_url: captionsVttUrl };
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
        const { composited_url, recording_url, captions_srt_url, captions_vtt_url } = await processFlow({ flow, nova });
        await api({ action: "complete", id: flow.id, composited_url, recording_url, captions_srt_url, captions_vtt_url });
        console.log(`[done]  ${flow.id}`);
      } catch (e) {
        console.error(`[fail]  ${flow.id}`, e);
        await api({ action: "fail", id: flow.id, error: e.message });
      }
    } catch (e) {
      console.error("[loop]", e);
      await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
    }
  }
};

loop();

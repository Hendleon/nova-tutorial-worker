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

if (!WORKER_API_URL || !TUTORIAL_WORKER_TOKEN) {
  console.error("Missing required env vars. See .env.example");
  process.exit(1);
}

const api = async (body) => {
  const res = await fetch(WORKER_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TUTORIAL_WORKER_TOKEN}` },
    body: JSON.stringify(body),
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

const requireSelector = (step, index) => {
  if (!step.selector) throw new Error(`${stepLabel(index, step)} failed: selector is required`);
  return step.selector;
};

const clickSelector = async (page, selector) => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout: 15000 });
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);

  try {
    await locator.click({ timeout: 5000 });
    return;
  } catch (firstError) {
    const message = String(firstError?.message ?? firstError);
    if (!message.includes("not stable") && !message.includes("detached") && !message.includes("Timeout")) {
      throw firstError;
    }
  }

  await page.waitForTimeout(500);
  await page.waitForSelector(selector, { state: "attached", timeout: 10000 });
  const clicked = await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    if (element instanceof HTMLElement) {
      element.click();
      return true;
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, selector);
  if (!clicked) throw new Error(`selector not found after retry: ${selector}`);
};

const fillSelector = async (page, selector, text) => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout: 15000 });
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await locator.fill(text ?? "", { timeout: 10000 });
};

const runScript = async (page, script, nova) => {
  for (const [index, step] of script.entries()) {
    try {
      if (step.action === "goto") {
        const rawUrl = interpolate(step.url, nova);
        if (!rawUrl) throw new Error("url is required");
        const url = rawUrl.startsWith("http") ? rawUrl : `${nova.app_url}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      } else if (step.action === "click") {
        await clickSelector(page, requireSelector(step, index));
      } else if (step.action === "type") {
        await fillSelector(page, requireSelector(step, index), interpolate(step.text, nova));
      } else if (step.action === "wait") {
        await page.waitForTimeout(step.ms ?? 500);
      } else if (step.action === "zoomTo") {
        const selector = requireSelector(step, index);
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: "attached", timeout: 15000 });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      } else {
        throw new Error(`unknown action: ${step.action}`);
      }
    } catch (e) {
      throw new Error(`${stepLabel(index, step)} failed: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
};

const processFlow = async ({ flow, nova }) => {
  const workDir = await mkdtemp(join(tmpdir(), `flow-${flow.id}-`));
  const recordingMp4 = join(workDir, "recording.mp4");
  const compositedPath = join(workDir, "composited.mp4");
  const mascotPath = join(workDir, "mascot.mp4");

  // 1. Log into the demo account
  const novaHeaders = {
    "x-seed-token": nova.seed_token,
    ...(nova.anon_key ? { apikey: nova.anon_key, authorization: `Bearer ${nova.anon_key}` } : {}),
  };

  const loginRes = await fetch(nova.demo_login_url, { method: "POST", headers: novaHeaders });
  if (!loginRes.ok) throw new Error(`demo-login ${loginRes.status}: ${(await loginRes.text()).slice(0, 500)}`);
  const loginPayload = await loginRes.json();
  const session = loginPayload.session ?? loginPayload;
  const accessToken = session?.access_token ?? loginPayload.access_token;

  // 2. Launch Playwright, restore session, record
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // 9:16 mobile
    deviceScaleFactor: 2,
    recordVideo: { dir: workDir, size: { width: 390, height: 844 } },
  });
  const page = await context.newPage();
  await page.goto(nova.app_url);
  await page.evaluate(({ token, sessionJson, storageKey }) => {
    if (token) localStorage.setItem("nova.access_token", token);
    if (storageKey && sessionJson) localStorage.setItem(storageKey, sessionJson);
  }, {
    token: accessToken,
    sessionJson: session ? JSON.stringify(session) : null,
    storageKey: nova.auth_storage_key ?? null,
  });

  try {
    await runScript(page, flow.script, nova);
  } finally {
    await page.waitForTimeout(500);
    await context.close();
    await browser.close();
  }

  // Playwright names the video with a hash; grab the first .webm in workDir
  const { readdir } = await import("node:fs/promises");
  const webm = (await readdir(workDir)).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no recording captured");
  await sh("ffmpeg", ["-y", "-i", join(workDir, webm), "-c:v", "libx264", "-pix_fmt", "yuv420p", recordingMp4]);

  // 3. Composite with mascot (bottom-right, 25% width, TikTok safe zone)
  if (flow.mascot_url) {
    const mascotBuf = await (await fetch(flow.mascot_url)).arrayBuffer();
    await writeFile(mascotPath, Buffer.from(mascotBuf));
    await sh("ffmpeg", [
      "-y",
      "-i", recordingMp4,
      "-i", mascotPath,
      "-filter_complex",
      "[1:v]scale=iw*0.4:-1[m];[0:v][m]overlay=W-w-20:H-h-160:shortest=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      compositedPath,
    ]);
  } else {
    await sh("ffmpeg", ["-y", "-i", recordingMp4, "-c", "copy", compositedPath]);
  }

  // 4. Get a signed upload URL from the edge function, then upload the video
  const { uploadUrl, viewUrl } = await api({ action: "getUploadUrl", id: flow.id, ext: "mp4" });
  const buf = await readFile(compositedPath);
  const upRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: buf,
  });
  if (!upRes.ok) throw new Error(`storage upload ${upRes.status}: ${await upRes.text()}`);

  await rm(workDir, { recursive: true, force: true });
  return { composited_url: viewUrl, recording_url: null };
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
        const { composited_url, recording_url } = await processFlow({ flow, nova });
        await api({ action: "complete", id: flow.id, composited_url, recording_url });
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

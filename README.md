# Nova Tutorial Worker — Step-by-step setup

You're deploying a tiny Node service that watches the Promo Hub for queued tutorial flows, records the Nova app with Playwright, composites the mascot MP4 with ffmpeg, and uploads the finished 9:16 MP4 back.

## What you'll need (5 minutes)
1. A **GitHub account** (free) — https://github.com/join
2. A **Railway account** (free trial credit) — https://railway.app — sign in with GitHub
3. Three values from your Lovable Cloud project (I'll tell you where to click below)

---

## Step 1 — Push this folder to GitHub
1. On github.com click **New repository** → name it `nova-tutorial-worker` → Private is fine → **Create**.
2. On your computer (or using the GitHub web UI's "upload files" button), upload **everything inside the `worker/` folder** (not the folder itself — the files: `index.js`, `package.json`, `Dockerfile`, `.env.example`, `README.md`).

If you'd rather not use git commands, GitHub's "Add file → Upload files" button in the browser works fine.

---

## Step 2 — Grab your three secrets from Lovable Cloud
Open your Lovable project → click **View Backend** in the chat → **Edge Functions → Secrets**. Copy these values into a scratch note:

| Env var name | Where it comes from |
|---|---|---|
| `TUTORIAL_WORKER_TOKEN` | Already generated. Copy from Secrets. |
| `SUPABASE_URL` | Already in Secrets. Looks like `https://xxxx.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Already in Secrets. Long string starting with `eyJ...`. |

You'll also need one URL that's already fixed:
- `WORKER_API_URL` = `https://mypgejxhuvkkpaxzneev.functions.supabase.co/tutorial-worker`

---

## Step 3 — Deploy on Railway
1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo** → pick `nova-tutorial-worker`.
2. Railway will detect the `Dockerfile` and start building. Let the first build fail — it's expected because there are no env vars yet.
3. In the service, click **Variables** and add each row from Step 2 (name on the left, value on the right). Add one more:
   - `POLL_INTERVAL_MS` = `10000`
4. Click **Deploy** again. Watch the **Logs** tab — after a minute you should see lines like:

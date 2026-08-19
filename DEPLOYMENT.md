# VPS Deployment Guide

Step-by-step for deploying `server/` + `yolo-service/` to a plain Ubuntu VPS (Hostinger,
DigitalOcean, AWS Lightsail, Contabo, etc.) — no GPU needed for this. This VPS only *serves*
requests; real model training happens elsewhere (a GPU machine/cloud instance — see
`docs/ARCHITECTURE.md` Section 8 and `training/README.md`) and the resulting checkpoint gets
uploaded here afterward.

## Current live setup (reference)

This is what's actually running today, as a concrete example of Steps 1-10 below:

| What | Where |
|---|---|
| VPS | `200.234.37.130`, Ubuntu, user `deploy` (see the warning in Step 8 about staying on this one user) |
| Backend | `https://api.ibimaassist.online` → nginx → `server/` (port 8000) → `yolo-service/` (port 8001) |
| Frontend | `https://ibimaassist.online` (+ `www.`) → nginx serving `car-damage-insurance-web-app`'s built `dist/` as static files |
| SSL | Let's Encrypt via `certbot --nginx`, auto-renews (`certbot.timer`) |
| Repos on VPS | `/home/deploy/ai-damage-assessment-service`, `/home/deploy/car-damage-insurance-web-app` |

The frontend is **also** deployed separately on Vercel — both point at the same
`https://api.ibimaassist.online` backend. `server/.env`'s `CORS_ORIGINS` is now a real allowlist
(both `ibimaassist.online` domains, the stable Vercel alias, a couple of older per-deploy Vercel
preview URLs kept for safety, and localhost for dev) instead of the `*` wildcard used while things
were still settling — see Step 10. If a *new* Vercel preview URL ever gets CORS-blocked, add it
here and `pm2 restart ai-damage-server --update-env`.

**Redeploying the frontend after a `git push`** (mirrors the Node/Python steps under "Redeploying
after `git push`" below):
```bash
ssh deploy@200.234.37.130
cd /home/deploy/car-damage-insurance-web-app
git pull
npm install                # only if package.json changed
npm run build               # writes dist/ -- nginx serves this directly, no restart needed
```
`.env` there is `VITE_AI_SERVICE_URL=https://api.ibimaassist.online` (baked in at build time —
change it and you must `npm run build` again, a running `npm run dev` won't pick it up either).

**One-time gotcha hit setting this up:** nginx (`www-data`) couldn't read
`/home/deploy/car-damage-insurance-web-app/dist/` — `/home/deploy` itself is `750` (owner+group
only), which blocks `www-data` from traversing into it even though `dist/` itself was world- or
group-readable. Fixed with `usermod -aG deploy www-data` + `systemctl restart nginx` (a `reload`
isn't enough — supplementary group membership is only read at worker process start). If a static
site 500s with "Permission denied" in `/var/log/nginx/error.log` on a path that looks readable,
check this first.

## Step 1 — Pick a VPS plan

| Resource | Minimum | Recommended |
|---|---|---|
| RAM | 2GB | 4GB+ (a smaller box hits the same CPU memory-exhaustion issue documented in `training/README.md`'s CPU troubleshooting note, just sooner) |
| CPU | 2 vCPU | 2-4 vCPU |
| Storage | 20GB | 40GB+ (`ultralytics` + `torch` install is a few GB; leave room for uploads/, model checkpoints, training runs) |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

## Step 2 — Initial VPS access

```bash
ssh root@YOUR_VPS_IP
apt update && apt upgrade -y

# Don't stay on root for day-to-day work
adduser deploy
usermod -aG sudo deploy
su - deploy
```

## Step 3 — Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # must be >= 22.5 (server/ needs the built-in node:sqlite module)
```

## Step 4 — Install Python (for `yolo-service/`, and `training/` if you ever run training here)

```bash
sudo apt install -y python3.12 python3.12-venv python3-pip
python3 --version
```

## Step 5 — Get the code onto the server

```bash
sudo apt install -y git
cd ~
git clone git@github.com:vermakhushbu723/ai-damage-assessment-service.git
cd ai-damage-assessment-service
```
(Set up an SSH key on the VPS for GitHub access, or clone over HTTPS with a token.)

## Step 6 — Install dependencies

**Node service:**
```bash
cd server
npm install
cp .env.example .env
nano .env   # set CORS_ORIGINS to your real frontend domain, review OLLAMA_MODEL etc.
```

**Python yolo-service:**
```bash
cd ../yolo-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Step 7 — Firewall: which ports to open

**Do not expose `server/` (8000) or `yolo-service/` (8001) directly to the internet.** Only 443
(HTTPS, via the nginx reverse proxy in Step 9) should be public. `yolo-service` in particular
should never be reachable from outside — it's only ever called server-to-server from `server/`.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp      # HTTP, only for the redirect to HTTPS
sudo ufw allow 443/tcp     # HTTPS, real public traffic
sudo ufw enable
```

## Step 8 — Keep both services running with `pm2`

So they survive terminal disconnects, crashes, and reboots.

> **⚠ Run every `pm2` command as the SAME user, always.** Each Linux user has their own
> completely separate PM2 daemon and process list (`~/.pm2`). If you sometimes run `pm2 start`
> as `root` and sometimes as `deploy` for the *same* app, you end up with two independent PM2s
> both trying to bind the same port — one succeeds, the other crash-loops forever with
> `EADDRINUSE` against the first one, `pm2 list` only shows whichever user you're currently
> logged in as (so the "healthy" one can be invisible to you), and killing what looks like an
> "orphaned" process just gets instantly replaced by the other user's PM2 auto-restarting it.
> This actually happened during this project's setup and took a while to diagnose. **Pick one
> user for everything (this guide uses `deploy`) and never run `pm2 start`/`restart` as `root`
> for these apps.**

```bash
# Make sure you're logged in as `deploy`, not root, for all of this:
su - deploy
sudo npm install -g pm2   # (needs sudo once, to install the pm2 CLI globally)

# Node service
cd ~/ai-damage-assessment-service/server
pm2 start src/server.js --name ai-damage-server

# Python yolo-service -- `--interpreter none` is required here. Without it,
# PM2 defaults to running the script through *Node.js*, and since
# `.venv/bin/uvicorn` is a Python script, that fails immediately with
# `SyntaxError: Invalid or unexpected token` on its Python shebang line.
cd ~/ai-damage-assessment-service/yolo-service
pm2 start .venv/bin/uvicorn --name yolo-service --interpreter none \
  --cwd ~/ai-damage-assessment-service/yolo-service -- app:app --host 127.0.0.1 --port 8001

pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u deploy --hp /home/deploy
# ^ run the exact command it prints if different from this -- it installs a
# systemd unit that runs `pm2 resurrect` on boot, restoring this process list
```

Verify both actually bound (not just "online" in `pm2 list` -- see the warning above about why
that can lie):
```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8001/health
```

## Step 9 — Get the backend onto HTTPS

**This step is not optional if any frontend of yours is deployed over HTTPS** (a Vercel site,
for example). Browsers block a `https://` page from calling a plain `http://` API ("mixed
content") — the request fails client-side with a generic `Failed to fetch`, no server-side error
at all, which makes it look like a CORS or connectivity problem when it's actually just the
`http://` scheme. Pick one:

### Option A — You have a domain: nginx + Let's Encrypt (permanent, recommended for production)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/ai-damage-service`:
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 25M;   # photo uploads
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/ai-damage-service /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo certbot --nginx -d api.yourdomain.com   # free HTTPS cert, auto-renews
```
Your backend URL is now `https://api.yourdomain.com`, stable forever.

### Option B — No domain: Cloudflare Tunnel (free, works with just the VPS IP)

Gives you a real HTTPS URL without buying anything. Run as the **same `deploy` user** as
everything else (see the warning in Step 8):

```bash
su - deploy
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb

cd ~/ai-damage-assessment-service
pm2 start cloudflared --name cf-tunnel --interpreter none --cwd ~/ai-damage-assessment-service \
  -- tunnel --url http://localhost:8000
pm2 save

# Get the URL it was assigned:
cat ~/.pm2/logs/cf-tunnel-out.log ~/.pm2/logs/cf-tunnel-error.log | grep trycloudflare
```
You'll get something like `https://random-words-here.trycloudflare.com` — that's your backend's
public HTTPS URL.

> **⚠ Real limitation, not a bug: this URL changes every time the `cf-tunnel` process restarts**
> (crash, `pm2 restart`, VPS reboot, `pm2 kill`) — "quick tunnels" are anonymous and don't keep a
> fixed address. Every time that happens you must re-check the log for the new URL and update
> `VITE_AI_SERVICE_URL` (both local `.env` and the Vercel dashboard env var, then redeploy on
> Vercel — see Step 10). If you outgrow this, a **named tunnel** (needs a free Cloudflare account
> + a domain added to Cloudflare, still no separate hosting cost) gets you a permanent
> `https://api.yourdomain.com`-style URL instead — see
> https://developers.cloudflare.com/cloudflare-one/connections/connect-apps. Buying a domain and
> doing Option A is simpler if you'll need this long-term.

## Step 10 — Point the frontend at this backend

**Local dev** — `car-damage-insurance-web-app/.env` (create it from `.env.example`, gitignored):
```
VITE_AI_SERVICE_URL=https://api.yourdomain.com          # Option A
# or
VITE_AI_SERVICE_URL=https://random-words.trycloudflare.com   # Option B -- update when it changes
```
Restart `npm run dev` after changing this — Vite only reads `.env` at startup.

**Deployed frontend (Vercel)** — a local `.env` file has no effect on what Vercel builds; you
must set the same variable in Vercel's own project settings:
1. Vercel dashboard → your project → **Settings → Environment Variables**
2. Add `VITE_AI_SERVICE_URL` = your backend's HTTPS URL (Production + Preview + Development, or
   just Production)
3. **Redeploy** — Vite bakes env vars in at build time, so an existing deployment won't pick up
   a new env var until you trigger a fresh build (Deployments tab → "..." → Redeploy)

**Either way**, make sure `server/.env` on the VPS has your frontend's real origin in
`CORS_ORIGINS` (not just `localhost`), then `pm2 restart ai-damage-server`:
```
CORS_ORIGINS=http://localhost:5173,https://localhost:5173,https://your-app.vercel.app
```

## Step 11 — Verify

```bash
curl https://your-backend-url/health
# {"status":"ok"}

# From the browser: confirm CORS is actually open for your frontend's origin
curl -sI -H "Origin: https://your-app.vercel.app" https://your-backend-url/health | grep -i access-control
# should show: Access-Control-Allow-Origin: https://your-app.vercel.app
```
Then run a real request from the deployed frontend (the AI ILA page) to confirm the full chain
(browser → nginx-or-tunnel → server/ → yolo-service/) works.

## Step 12 (optional) — Ollama on the VPS, for real Llama report narration

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b
# --interpreter none is required (same reason as yolo-service in Step 8 --
# ollama is a native binary, not JS, and PM2 defaults to running everything
# through node)
pm2 start ollama --name ollama --interpreter none -- serve
```
On a small VPS (2-4GB RAM), running Ollama + `yolo-service` at the same time can be tight —
watch memory usage (`free -h`). Without Ollama, `/report` still works and returns a clearly-labeled
templated narrative instead of failing (see `README.md`'s "what's real vs placeholder").

## Redeploying after `git push` (routine updates)

Once the VPS is set up (Steps 1-9 above, done once), shipping a new change from local dev to the
live VPS is just:

```bash
ssh deploy@200.234.37.130
cd /home/deploy/ai-damage-assessment-service
git pull

# Only if server/package.json changed (new dependency):
cd server && npm install && cd ..

# Only if yolo-service/requirements.txt changed:
cd yolo-service && source .venv/bin/activate && pip install -r requirements.txt && deactivate && cd ..

# Restart whichever service(s) actually changed -- restarting both is always safe too
pm2 restart ai-damage-server
pm2 restart yolo-service

# Verify
curl http://127.0.0.1:8000/
curl http://127.0.0.1:8000/health
pm2 logs --lines 30 --nostream
```

**Path reference for this VPS:**

| What | Path |
|---|---|
| Repo root | `/home/deploy/ai-damage-assessment-service` |
| Node service | `/home/deploy/ai-damage-assessment-service/server` |
| Python yolo-service | `/home/deploy/ai-damage-assessment-service/yolo-service` |
| pm2 process names | `ai-damage-server` (Node), `yolo-service` (Python), `ollama` (if installed) |
| Node service `.env` | `/home/deploy/ai-damage-assessment-service/server/.env` |
| yolo-service `.env` | `/home/deploy/ai-damage-assessment-service/yolo-service/.env` |
| pm2 process names | `ai-damage-server`, `yolo-service`, `cf-tunnel` (if using Option B), `ollama` (if installed) |

**⚠ Don't run `npm start` or `node src/server.js` directly on the VPS** (not even with `&` to
background it) — if you forget to stop it, it keeps holding the port after you log out, and the
*next* `pm2 restart` then fails with `EADDRINUSE` while the orphaned process keeps serving stale
code. Always go through `pm2 start`/`pm2 restart`.

## Troubleshooting

### `EADDRINUSE` in `pm2 logs`, but `pm2 list` claims the app is "online"

Two different root causes produce this exact symptom, both hit while setting this project up:

1. **You ran `pm2 start`/`restart` as a different Linux user than usual (e.g. once as `root`,
   once as `deploy`).** Each user has a fully separate PM2 daemon and process list — `pm2 list`
   only ever shows *your current user's* view, so a perfectly healthy process started earlier
   under the other user is invisible to you, silently holding the port, while your current
   user's PM2 keeps trying and failing to bind it. Fix: `sudo lsof -i :8000` to find the real PID
   and its owning user, then check that specific user's `pm2 list` (`sudo -iu <user> pm2 list`)
   to find where it's actually managed, and consolidate everything onto one user (see the
   warning in Step 8) — don't just `kill -9` it and re-`pm2 start` as the *other* user, or you've
   only swapped which side wins the race.
2. **A truly orphaned process** (started once via a bare `npm start &`/`node src/server.js &`
   that never got cleaned up) is holding the port outside of PM2 entirely. Fix: `sudo lsof -i
   :8000`, cross-check the PID against `pm2 show ai-damage-server`'s `pid` field, `kill -9`
   whichever one *isn't* PM2's, then `pm2 restart ai-damage-server`.

### `yolo-service` (or `ollama`, or `cf-tunnel`) crashes instantly with `SyntaxError: Invalid or unexpected token` pointing at a shebang line (`# -*- coding: utf-8 -*-` or similar)

PM2 defaults to running every script through **Node.js**. `.venv/bin/uvicorn` is a Python script
and `cloudflared`/`ollama` are native binaries — none of them are JS, so Node's module loader
chokes on the first line. Fix: add `--interpreter none` to the `pm2 start` command (already
correct in Step 8/9/12 above) so PM2 just executes the file directly.

### Frontend shows "Failed to fetch" / "Could not reach the AI service", nothing in server logs at all

The request never reached the server — check, in order:
1. **Mixed content**: is the frontend on `https://` and the backend URL on plain `http://`?
   Browsers silently block this (see Step 9). Fix: put the backend behind HTTPS (nginx+domain or
   Cloudflare Tunnel).
2. **Stale `VITE_AI_SERVICE_URL`**: for a *deployed* frontend (Vercel etc.), a local `.env` change
   does nothing — the env var must be set in the hosting platform's dashboard and the site
   **redeployed** (Vite bakes it in at build time). See Step 10.
3. **CORS**: `curl -sI -H "Origin: https://your-frontend" https://your-backend/health | grep
   access-control` — if `Access-Control-Allow-Origin` is missing, add your frontend's origin to
   `server/.env`'s `CORS_ORIGINS` on the VPS and `pm2 restart ai-damage-server`.
4. **Firewall**: if using nginx (Option A), only 80/443 need to be open — `server/`'s port 8000
   should stay closed to the internet. If testing directly against port 8000 (no reverse proxy at
   all), `sudo ufw allow 8000/tcp`.

## Ongoing maintenance

- `pm2 logs` — check errors
- `pm2 list` — see status/uptime/restart-count of every managed process (remember: as the right
  user, see the Troubleshooting section above)
- Watch disk space (`df -h`) — `uploads/`, `training/runs/`, and any raw_pool photos accumulate over time
- **Training doesn't happen on this VPS** — fine-tune elsewhere (GPU machine/cloud, see
  `docs/ARCHITECTURE.md` Section 8), then `scp`/upload the resulting `best.pt` here and point
  `yolo-service/.env`'s `YOLO_CAR_WEIGHTS` (etc.) at it, then `pm2 restart yolo-service`.

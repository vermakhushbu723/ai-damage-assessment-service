# VPS Deployment Guide

Step-by-step for deploying `server/` + `yolo-service/` to a plain Ubuntu VPS (Hostinger,
DigitalOcean, AWS Lightsail, Contabo, etc.) — no GPU needed for this. This VPS only *serves*
requests; real model training happens elsewhere (a GPU machine/cloud instance — see
`docs/ARCHITECTURE.md` Section 8 and `training/README.md`) and the resulting checkpoint gets
uploaded here afterward.

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

So they survive terminal disconnects, crashes, and reboots:

```bash
sudo npm install -g pm2

# Node service
cd ~/ai-damage-assessment-service/server
pm2 start src/server.js --name ai-damage-server

# Python yolo-service
cd ~/ai-damage-assessment-service/yolo-service
pm2 start ".venv/bin/uvicorn" --name yolo-service -- app:app --host 127.0.0.1 --port 8001

pm2 save
pm2 startup   # run the command it prints, so both restart automatically on reboot
```

## Step 9 — Nginx reverse proxy + HTTPS

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

## Step 10 — Point the frontend at this backend

`car-damage-insurance-web-app`'s `.env`:
```
VITE_AI_SERVICE_URL=https://api.yourdomain.com
```
And in `server/.env` on the VPS, make sure `CORS_ORIGINS` includes wherever the frontend is
actually deployed (e.g. its Vercel URL) — not just localhost.

## Step 11 — Verify

```bash
curl https://api.yourdomain.com/health
# {"status":"ok"}
```
Then run a real request from the deployed frontend (the AI ILA page) to confirm the full chain
(browser → nginx → server/ → yolo-service/) works.

## Step 12 (optional) — Ollama on the VPS, for real Llama report narration

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b
pm2 start "ollama" --name ollama -- serve
```
On a small VPS (2-4GB RAM), running Ollama + `yolo-service` at the same time can be tight —
watch memory usage (`free -h`). Without Ollama, `/report` still works and returns a clearly-labeled
templated narrative instead of failing (see `README.md`'s "what's real vs placeholder").

## Ongoing maintenance

- `pm2 logs` — check errors
- `pm2 restart all` — after deploying new code
- Deploy an update: `git pull` → `npm install` (if `server/package.json` changed) → `pm2 restart ai-damage-server`
- Watch disk space (`df -h`) — `uploads/`, `training/runs/`, and any raw_pool photos accumulate over time
- **Training doesn't happen on this VPS** — fine-tune elsewhere (GPU machine/cloud, see
  `docs/ARCHITECTURE.md` Section 8), then `scp`/upload the resulting `best.pt` here and point
  `yolo-service/.env`'s `YOLO_CAR_WEIGHTS` (etc.) at it, then `pm2 restart yolo-service`.

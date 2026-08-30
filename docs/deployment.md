# Deploying Infinity Workspace

A step-by-step guide for a fresh **Ubuntu 24.04 LTS** VPS running **aaPanel**, using
**pm2** to keep the application running.

This assumes no prior deployment experience. Every command is meant to be copied and run
as-is. Where you must substitute something of your own, it is written in `CAPITALS`.

**Roughly 60–90 minutes** the first time.

---

## What you are building

Three websites and one database on a single server:

| Address | What it serves |
|---|---|
| `app-api.iinfinityai.com` | The API. The desktop app talks to this. |
| `app.iinfinityai.com` | Share links, account activation, password reset. |
| `updates.iinfinityai.com` | The installers and the update feed. |

Employees run the **desktop application**, not a website. The public site exists only for
people who cannot install it — clients opening a share link, and new joiners activating
an account before they have the app.

---

## Before you start

You need:

- A VPS running Ubuntu 24.04 with aaPanel installed, and its login
- Your domain's DNS managed somewhere you can add records
- The Cloudflare R2 bucket details (account ID, bucket name, access key, secret)
- The mailbox password for `noreply@iinfinityai.com`

---

## Step 1 — Point the domains at the server

In your DNS provider, add three **A records**, all pointing to your VPS IP address:

```
app-api.iinfinityai.com    A    YOUR_SERVER_IP
app.iinfinityai.com        A    YOUR_SERVER_IP
updates.iinfinityai.com    A    YOUR_SERVER_IP
```

> **If you use Cloudflare**, set these three to **DNS only** (grey cloud), not proxied.
> Cloudflare's proxy interferes with the realtime connection the app depends on, and you
> would see the app constantly reconnecting for no visible reason.

Wait a few minutes, then check from your own machine:

```bash
dig +short app-api.iinfinityai.com
```

It should print your server's IP. Do not continue until it does.

---

## Step 2 — Install what the server needs

Log into your server over SSH:

```bash
ssh root@YOUR_SERVER_IP
```

Install Node.js 20:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

Check it worked — you want v20 or higher:

```bash
node -v
```

Install pm2, the tool that keeps the application running and restarts it if it crashes:

```bash
npm install -g pm2
```

---

## Step 3 — Create the database

Either **MySQL 8.0+ or MariaDB 10.4+** works. aaPanel installs MariaDB by default, which
is fine — nothing here needs MySQL-only syntax.

In **aaPanel → Databases → Add database**:

- Database name: `ecosystem`
- Username: `ecosystem`
- Password: click **Generate**, then **copy it somewhere safe** — you need it shortly
- Access: **Local server** only

> Leaving the database open to the internet is the single most common way a small
> deployment gets compromised. Local-only means it can only be reached by software running
> on this same machine.

If you already run MariaDB for other sites, use it — a second database engine is not
needed. Check the version if you want to be sure:

```bash
mysql -V
```

---

## Step 4 — Get the code onto the server

```bash
mkdir -p /www/wwwroot/infinity
cd /www/wwwroot/infinity
git clone https://github.com/Infinity-AI-DevHub/Infinity-AI-Ecosystem.git .
```

If the repository is private, aaPanel's **Terminal** will prompt for a GitHub username and
a personal access token (not your password).

---

## Step 5 — Configure the application

```bash
cd /www/wwwroot/infinity/apps/api
cp .env.example .env
```

Generate an encryption key and keep the output:

```bash
openssl rand -hex 32
```

Now edit the file — in aaPanel, **Files → /www/wwwroot/infinity/apps/api → .env → Edit**:

```ini
NODE_ENV=production

PUBLIC_URL=https://app.iinfinityai.com
API_URL=https://app-api.iinfinityai.com

DATABASE_URL=mysql://ecosystem:YOUR_DB_PASSWORD@127.0.0.1:3306/ecosystem

# The 64-character string from openssl above.
DATA_ENCRYPTION_KEY=PASTE_THE_KEY_HERE

# Object storage — Cloudflare R2.
STORAGE_DRIVER=s3
S3_ENDPOINT=https://YOUR_R2_ACCOUNT_ID.r2.cloudflarestorage.com
S3_BUCKET=infinity-files
S3_REGION=auto
S3_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY
S3_SECRET_ACCESS_KEY=YOUR_R2_SECRET

# Mail.
NOTIFY_DRIVER=smtp
NOTIFY_FROM_ADDRESS=noreply@iinfinityai.com
NOTIFY_DEFAULT_DOMAIN=iinfinityai.com
SMTP_HOST=mail.iinfinityai.com
SMTP_PORT=587
SMTP_USER=noreply@iinfinityai.com
SMTP_PASSWORD=YOUR_MAILBOX_PASSWORD
```

> **The application refuses to start** if `DATA_ENCRYPTION_KEY` is missing or shorter than
> 32 characters, if the URLs are not `https` in production, or if `NOTIFY_DRIVER` is left
> as `log`. These are deliberate: each one would otherwise fail silently and be discovered
> weeks later — the mail one by a new joiner who never received their invitation.

---

## Step 6 — Build and start the API

```bash
cd /www/wwwroot/infinity/apps/api
npm ci
npm run build
npm run migrate
```

`migrate` creates every table. It is safe to run again; it skips what is already applied.

Create the first administrator:

```bash
SEED_ADMIN_EMAIL=you@iinfinityai.com npm run seed
```

This prints a **single-use activation link**. Copy it — you will use it at the end.

Now start both processes:

```bash
cd /www/wwwroot/infinity
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`pm2 startup` prints one more command. **Copy and run it** — that is what makes the
application come back automatically after a reboot.

Check both are running:

```bash
pm2 status
```

You want `infinity-api` and `infinity-worker` both showing **online**. If either shows
`errored`, read why:

```bash
pm2 logs infinity-api --lines 50
```

---

## Step 7 — Build the public website

```bash
cd /www/wwwroot/infinity/apps/web
npm ci
VITE_API_URL=https://app-api.iinfinityai.com npm run build:public
```

This produces `dist-public`, which the public site will serve.

> The API address is baked in at build time. If you ever change it, rebuild — editing a
> file on the server will not change it.

---

## Step 8 — Create the three sites in aaPanel

For **each** of the three, go to **Website → Add site**:

| Domain | Document root |
|---|---|
| `app-api.iinfinityai.com` | anything — it is proxied, the folder is unused |
| `app.iinfinityai.com` | `/www/wwwroot/infinity/apps/web/dist-public` |
| `updates.iinfinityai.com` | `/www/wwwroot/infinity/updates` |

Leave PHP set to **Pure static** for all three. Then create the updates folder:

```bash
mkdir -p /www/wwwroot/infinity/updates
```

### Turn on HTTPS

For each site: **Settings → SSL → Let's Encrypt → Apply**, then switch on **Force HTTPS**.

> Do this before the next step. The application refuses to run in production over plain
> `http`, so the certificates need to exist first.

### Apply the configuration

For each site: **Settings → Configuration File**, and paste the contents of the matching
file from `/www/wwwroot/infinity/deploy/`:

| Site | File to paste from |
|---|---|
| `app-api.iinfinityai.com` | `deploy/nginx-app-api.conf` |
| `app.iinfinityai.com` | `deploy/nginx-app.conf` |
| `updates.iinfinityai.com` | `deploy/nginx-updates.conf` |

Paste the contents **inside** the existing `server { ... }` block, replacing any
`location /` block aaPanel created. Save, then **reload nginx**.

### Check it worked

```bash
curl https://app-api.iinfinityai.com/health
```

You should see `{"status":"ok",...}`. And:

```bash
curl https://app-api.iinfinityai.com/ready
```

`{"status":"ready","checks":{"database":"ok"}}` means the API can reach the database.

---

## Step 9 — Publish the desktop apps

On **your own computer**, not the server:

```bash
cd apps/desktop
npm ci
npm run package
npm run feed > release/latest.json
```

This produces, in `apps/desktop/release/`:

- `Infinity Workspace-1.0.0-arm64.dmg` — Apple Silicon Macs
- `Infinity Workspace-1.0.0.dmg` — Intel Macs
- `Infinity Workspace Setup 1.0.0.exe` — Windows
- `latest.json` — how installed apps learn about new versions

Upload all four to `/www/wwwroot/infinity/updates/` using aaPanel's **Files** page.

Check the feed is readable:

```bash
curl https://updates.iinfinityai.com/latest.json
```

---

## Step 10 — Install and sign in

Download the installer for your machine from `https://updates.iinfinityai.com/`.

### On macOS

The app is **not signed**, so macOS will refuse it the first time. This is expected.

1. Open the `.dmg` and drag the app to Applications
2. Try to open it — macOS says it cannot be verified
3. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**
4. Open it again and confirm

You do this **once per version**.

### On Windows

Windows SmartScreen will warn that the publisher is unrecognised. Click **More info**,
then **Run anyway**. Also once per version.

### Sign in

Open the activation link from Step 6 in a browser. It takes you to
`app.iinfinityai.com`, where you set your password. Then sign in through the desktop app.

---

## Day-to-day

**See what is running**

```bash
pm2 status
pm2 logs infinity-api --lines 100
```

**Deploy a change**

```bash
cd /www/wwwroot/infinity
git pull
cd apps/api && npm ci && npm run build && npm run migrate
cd /www/wwwroot/infinity && pm2 restart ecosystem.config.cjs
```

If the change touched the public website:

```bash
cd /www/wwwroot/infinity/apps/web
VITE_API_URL=https://app-api.iinfinityai.com npm run build:public
```

**Release a new desktop version**

Raise `version` in `apps/desktop/package.json`, then on your own machine:

```bash
cd apps/desktop && npm run package && npm run feed > release/latest.json
```

Upload the new installers **and** `latest.json`. Windows apps update themselves. Mac apps
show a notice and open the download page, because an unsigned macOS build cannot replace
itself — that is a limitation of signing, not of the app.

---

## When something is wrong

**The app says it cannot connect**

```bash
curl https://app-api.iinfinityai.com/health
pm2 status
```

If `/health` fails but pm2 says online, the problem is nginx. If pm2 shows `errored`, read
`pm2 logs infinity-api`.

**Nobody is receiving email**

```bash
pm2 logs infinity-worker --lines 50
```

The worker sends mail. Check `SMTP_PASSWORD` in `.env` is right, and that your VPS
provider has not blocked outbound port 587 — many block it by default and will open it on
request.

**Uploads fail**

Check the R2 values in `.env`, and that the bucket exists. The API logs the reason:

```bash
pm2 logs infinity-api --lines 50
```

**The app keeps reconnecting**

Almost always Cloudflare proxying. Set `app-api` to **DNS only** (grey cloud).

**Everything looks broken after a deploy**

```bash
cd /www/wwwroot/infinity
git log --oneline -5
git checkout PREVIOUS_COMMIT_HASH
cd apps/api && npm ci && npm run build
pm2 restart ecosystem.config.cjs
```

Migrations are not undone by this. Restore the database from backup if a migration is the
problem, which is why the next section matters.

---

## Back up the database

**Do this before anyone relies on the system.** This platform holds your only copy of HR
records, approvals, documents and expenses.

In **aaPanel → Databases → ecosystem → Backup**, then set a schedule:

**Cron → Add task**
- Type: **Backup database**
- Database: `ecosystem`
- Execution cycle: **Daily**, 3:00
- Keep: **14** copies
- Backup to: your remote storage if configured, otherwise the server

> A backup you have never restored is a hope, not a backup. Restore one into a spare
> database once and confirm it works. Finding out during an incident is too late.

---

## If you are locked out

If every administrator loses their password, there is a recovery path that needs SSH
access to the server:

```bash
cd /www/wwwroot/infinity/apps/api
npm run recover -- --email you@iinfinityai.com --reason "locked out"
```

It prints a new password once, revokes every existing session for that account, and
records itself in the audit trail. Sign in and change the password immediately.

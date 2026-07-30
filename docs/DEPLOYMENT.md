# Deploying CollabCode

A step-by-step guide to putting this app online safely. Written to be followed top to bottom by
someone who has never deployed anything before — every command is explained before you run it.

> **Naming note:** this file is `DEPLOYMENT.md` to match `TESTING.md` in the same folder.

**Time needed:** about an hour for the recommended setup, most of it waiting for downloads.

---

## Contents

1. [Read this first](#1-read-this-first)
2. [Choose your setup](#2-choose-your-setup)
3. [Option A — one server, everything works](#3-option-a--one-server-everything-works)
4. [Option B — managed hosting, no code execution](#4-option-b--managed-hosting-no-code-execution)
5. [Keeping it running](#5-keeping-it-running)
6. [Updating to a new version](#6-updating-to-a-new-version)
7. [Backups](#7-backups)
8. [Safety checklist](#8-safety-checklist)
9. [Things that will bite you](#9-things-that-will-bite-you)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Read this first

### What you are deploying

Three separate programs that talk to each other:

| Program | What it does | Port |
| :-- | :-- | :-- |
| **Frontend** (`web/`) | The website people visit | 3000 |
| **Sync server** (`server/`) | Keeps everyone's typing in sync | 8080 |
| **Piston** (Docker) | Runs the code people write, safely | 2000 |

Plus a **PostgreSQL database**, which stores one thing only: a copy of a room's files after the
room closes, for signed-in users.

### The one hard constraint

**Piston needs a *privileged* Docker container.** That means a container allowed to use low-level
Linux features — it needs them to build the isolation that keeps a stranger's code away from your
machine.

Almost no managed platform allows that. Not Vercel, not Railway, not Render, not Fly's free tier.

So there are only two honest choices, and this guide covers both:

- **Run everything on one server you control** (a VPS). Everything works, including Run.
- **Use managed hosting** and accept that the **Run button will not work**. Editing and
  collaboration still work perfectly.

### The safety rule that shapes everything below

**Piston must never be reachable from the internet.** Not "protected by a password" — *not
reachable at all.*

Here is why that matters so much. Piston runs with full system privileges, and the app sends it
code **without any password or key**. If someone can reach Piston directly, they can run whatever
they want on your server, and your app's rate limits do not apply because they never went through
your app.

This is not hypothetical — an earlier version of this project exposed Piston through a public
tunnel, and it was shut down for exactly this reason.

**The fix is simple and it is free:** keep Piston listening only on `127.0.0.1` (the server talking
to itself) and put the frontend on the *same machine*. Then there is no door to lock, because there
is no door. `docker-compose.yml` already does this — you just have to not undo it.

> This is also why Option A is recommended. In Option B the frontend lives on someone else's
> servers, so it *cannot* reach a loopback-only Piston, and making Piston reachable would require
> both a code change and a lot of care. Option B therefore ships without code execution.

---

## 2. Choose your setup

| | **Option A: one VPS** | **Option B: managed hosting** |
| :-- | :-- | :-- |
| Editing and collaboration | Works | Works |
| Accounts and saved rooms | Works | Works |
| **The Run button** | **Works** | **Does not work** |
| Cost | ~$12–24/month | ~$0–5/month |
| Difficulty | Moderate — this guide | Easy |
| You manage the server | Yes | No |

**Recommended: Option A.** It is the only way to get the complete app, and it is the *safer* of the
two, because Piston stays invisible to the internet.

Pick Option B if you only want to show the collaborative editor and are happy for Run to report
*"Could not reach the code execution service."*

---

## 3. Option A — one server, everything works

### 3.1 What to buy

Any provider that gives you a plain Ubuntu server with root access works: Hetzner, DigitalOcean,
Vultr, Linode, OVH.

| | Minimum | Recommended |
| :-- | :-- | :-- |
| CPU | 2 vCPU | 2–4 vCPU |
| RAM | 2 GB | **4 GB** |
| Disk | 30 GB | 40 GB+ |
| OS | **Ubuntu 24.04 LTS** | Ubuntu 24.04 LTS |
| Architecture | **x86 / amd64** | x86 / amd64 |

**Rough cost:** $12–24 per month. Hetzner is usually cheapest.

Three things worth knowing before you pay:

- **It must be x86 (amd64), not ARM.** The Piston image is only published for amd64, so cheap ARM
  servers cannot run it at all.
- **RAM is about compiling, not traffic.** A single Java or C++ compile is allowed up to 512 MB, and
  the frontend needs its own. 2 GB works; 4 GB stops you thinking about it.
- **Disk is about language packs.** Piston downloads a runtime per language, which is a couple of
  gigabytes.

You also need a **domain name** (about $10/year). Real HTTPS needs one, and without HTTPS browsers
block the WebSocket connection that makes the whole app work.

---

### 3.2 Secure the server before anything else

Do this first. A fresh server is scanned by bots within minutes, and it is far easier to lock the
door before you move in.

**On your own computer**, make an SSH key if you do not have one:

```bash
ssh-keygen -t ed25519
```

Press Enter through the prompts. Most providers let you paste the public key
(`~/.ssh/id_ed25519.pub`) into a box when creating the server — do that, and skip password login
entirely.

Now connect to the server:

```bash
ssh root@YOUR_SERVER_IP
```

**Create a normal user**, because doing everyday work as `root` means one mistyped command can
destroy the machine. Replace `collab` with any name you like:

```bash
adduser collab                    # it will ask you to set a password
usermod -aG sudo collab           # lets this user run admin commands with `sudo`
rsync --archive --chown=collab:collab ~/.ssh /home/collab
```

That last line copies your SSH key to the new user so you can log in as them.

**Turn off password and root login.** Open the SSH config:

```bash
nano /etc/ssh/sshd_config
```

Find these lines and set them exactly like this (remove any `#` in front):

```
PermitRootLogin no
PasswordAuthentication no
```

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`. Apply it:

```bash
systemctl restart ssh
```

> **Before you close this window**, open a *second* terminal and check `ssh collab@YOUR_SERVER_IP`
> works. If you get locked out with no session open, you would have to use your provider's rescue
> console to get back in.

**Set up the firewall.** This is the single most important step in this guide — it is what keeps
Piston, the sync server, and the database ports invisible to the internet:

```bash
sudo ufw default deny incoming     # block everything...
sudo ufw default allow outgoing    # ...except what the server starts itself
sudo ufw allow OpenSSH             # so you can still log in
sudo ufw allow 80/tcp              # web (redirects to HTTPS)
sudo ufw allow 443/tcp             # web over HTTPS
sudo ufw enable                    # type "y" when asked
sudo ufw status                    # check: only 22, 80, 443 should be listed
```

Notice what is **not** open: 2000, 3000, and 8080. Those are internal. The reverse proxy you set up
later is what lets the outside world reach the app, and it only reaches the parts it should.

**Turn on automatic security updates**, so known vulnerabilities get patched without you
remembering to:

```bash
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades   # choose "Yes"
```

From here on, log in as your new user:

```bash
exit
ssh collab@YOUR_SERVER_IP
```

---

### 3.3 Install what you need

**Node.js 22** (the JavaScript runtime the app is written in):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version        # should print v22.x.x
```

**Docker** (runs the Piston sandbox):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

That last line lets you use Docker without `sudo`. **Log out and back in for it to take effect:**

```bash
exit
ssh collab@YOUR_SERVER_IP
docker --version      # should print a version, with no permission error
```

**Git and Caddy.** Caddy is the reverse proxy — the program that receives web traffic and passes it
to the right internal port. It is used here instead of Nginx because it gets HTTPS certificates
automatically, with no extra commands:

```bash
sudo apt install -y git debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

---

### 3.4 Point your domain at the server

In your domain registrar's DNS settings, add one record:

| Type | Name | Value |
| :-- | :-- | :-- |
| `A` | `@` (or a subdomain like `collab`) | `YOUR_SERVER_IP` |

Wait a few minutes, then check from your own computer:

```bash
ping YOUR_DOMAIN
```

It should show your server's IP. **Do not continue until it does** — Caddy cannot get an HTTPS
certificate for a domain that does not point at it yet.

From here on, replace `YOUR_DOMAIN` in every command with your actual domain.

---

### 3.5 Get the code

```bash
cd ~
git clone YOUR_REPO_URL collabcode
cd collabcode
```

---

### 3.6 Set up the database

You need a PostgreSQL database. **Managed is easier and free to start** — [Neon](https://neon.tech)
is what this project was developed against. Create a project there and copy the two connection
strings it gives you.

You need both, and they are **not interchangeable**:

- **Pooled** (its hostname contains `-pooler`) — used by the running app.
- **Direct** (no `-pooler`) — used only when applying the database schema. The pooled one cannot do
  this and will hang.

**Change `sslmode=require` to `sslmode=verify-full` in both strings.** `require` encrypts the
connection but is scheduled to stop checking *who it is talking to* in a future driver version —
`verify-full` keeps the strong behaviour permanently.

> **Prefer Postgres on the same server?** Run `sudo apt install -y postgresql`, create a database,
> and use the same local connection string for both values. Then you also own the backups —
> see [§7](#7-backups).

---

### 3.7 Set up accounts (Clerk)

Sign-in is optional for the app, but if you want it, do this before building — the publishable key
is compiled into the website.

1. Create an application at [clerk.com](https://clerk.com).
2. Create a **production instance** and add your domain to it. Clerk will give you DNS records to
   add at your registrar; add them and wait for Clerk to confirm.
3. Copy the two production keys (`pk_live_...` and `sk_live_...`).

**Both programs must use the same Clerk instance.** A mismatch has no visible symptom at all: rooms
work perfectly, and saved rooms silently never appear.

---

### 3.8 Start Piston

From the repo root — **not** from inside `web/`:

```bash
cd ~/collabcode
docker compose up -d
```

This downloads the sandbox image and starts it. Check it is alive:

```bash
curl -s localhost:2000/api/v2/runtimes | head -c 200
```

You should see JSON listing languages. Then confirm it is **not** reachable from outside, from your
own computer:

```bash
curl --max-time 5 http://YOUR_SERVER_IP:2000/api/v2/runtimes
```

This **must fail** (timeout or connection refused). If it succeeds, stop and fix your firewall
before going further.

> **Always start Piston with `docker compose up -d`, never a bare `docker run`.** The safety
> ceilings — time, memory, output size — live only in `docker-compose.yml`. Started any other way,
> Piston silently falls back to its own defaults, and every run fails.

---

### 3.9 Configure and start the sync server

```bash
cd ~/collabcode/server
npm ci
cp .env.example .env
nano .env
```

Set these values:

```dotenv
PORT=8080

# Your database — the POOLED string
DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=verify-full

# Same Clerk instance as the frontend
CLERK_SECRET_KEY=sk_live_xxxxx

# One reverse proxy (Caddy) sits in front of this app
TRUSTED_PROXY_HOPS=1

# Your site's address, so session tokens from anywhere else are rejected
CLERK_AUTHORIZED_PARTIES=https://YOUR_DOMAIN
```

Leave the rest at their defaults. Test it:

```bash
npm start
```

In another terminal: `curl localhost:8080/health` should print `{"ok":true}`. Press `Ctrl+C` to
stop — [§5](#5-keeping-it-running) makes it permanent.

> `DATABASE_URL` and `CLERK_SECRET_KEY` are **optional**. Leave them out and everything still works
> except saved rooms — which is a perfectly reasonable way to deploy.

---

### 3.10 Configure and build the frontend

```bash
cd ~/collabcode/web
npm ci
cp .env.example .env.local
nano .env.local
```

```dotenv
# NOTE THE wss:// — secure WebSocket, and your real domain
NEXT_PUBLIC_WS_URL=wss://YOUR_DOMAIN/sync

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_xxxxx
CLERK_SECRET_KEY=sk_live_xxxxx

DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=verify-full
DIRECT_URL=postgresql://.../neondb?sslmode=verify-full

TRUSTED_PROXY_HOPS=1
```

> [!IMPORTANT]
> **`NEXT_PUBLIC_WS_URL` is frozen into the website when you build it.** It is not read again when
> the app starts. It also decides which addresses the browser's security policy permits the page to
> connect to. **Get it right *before* building** — if you change it later, you must rebuild, or the
> app will keep trying to reach the old address and sync will never connect.
>
> It must start with `wss://` (not `ws://`) on an HTTPS site. Browsers refuse insecure connections
> from a secure page, and this is by far the most common reason a deployment looks fine but nobody
> can type together.

Apply the database schema, then build:

```bash
npm run db:deploy     # creates the tables — uses DIRECT_URL
npm run build         # takes a few minutes
```

> Use `db:deploy`, **not** `db:migrate`. The second is a development command that can prompt you to
> reset the database — it is not safe to run against real data.
>
> If migrations complain about a missing database URL, check the file is named `.env.local` exactly.
> The Prisma configuration loads that specific filename.

Test it:

```bash
npm start
```

`curl -o /dev/null -w '%{http_code}\n' localhost:3000` should print `200`. Press `Ctrl+C`.

---

### 3.11 Put it on the internet with HTTPS

One config file connects the outside world to the two internal programs:

```bash
sudo nano /etc/caddy/Caddyfile
```

Delete everything in it and paste this, replacing `YOUR_DOMAIN`:

```caddyfile
YOUR_DOMAIN {
	# The live-collaboration connection. This must come first, because Caddy
	# matches rules in order and the catch-all below would otherwise swallow it.
	handle /sync/* {
		uri strip_prefix /sync
		reverse_proxy localhost:8080
	}

	# Everything else is the website.
	handle {
		reverse_proxy localhost:3000
	}
}
```

What this does:

- Gets and renews an HTTPS certificate automatically, for free.
- Sends anything starting with `/sync/` to the sync server, and strips that prefix so the sync
  server sees the paths it expects.
- Sends everything else to the frontend.
- Never mentions port 2000, so **Piston is not reachable from the internet at all** — which is the
  whole point.

> **Why a `/sync` path rather than a second subdomain?** One domain, one DNS record, one
> certificate. It works because the app builds every sync address by adding to
> `NEXT_PUBLIC_WS_URL`, so a path in that value is carried through to both the WebSocket and the
> room lookups.
>
> If you prefer a subdomain, it works just as well: add a second `A` record for
> `sync.YOUR_DOMAIN`, give it its own block (`sync.YOUR_DOMAIN { reverse_proxy localhost:8080 }`)
> with **no** `strip_prefix`, drop the `handle /sync/*` block, and set
> `NEXT_PUBLIC_WS_URL=wss://sync.YOUR_DOMAIN`.

Apply it:

```bash
sudo systemctl reload caddy
```

Visit `https://YOUR_DOMAIN`. You should see the app, with a padlock in the address bar.

---

### 3.12 Check it actually works

Do all five. The first three can pass while the app is still broken for real users.

1. **The site loads** over HTTPS with a padlock.
2. **A room opens.** Create a room; the editor appears with starter code.
3. **Two people can type.** Open the same room URL in a second browser tab. Type in one — the text
   must appear in the other within a second, with a coloured cursor. *If this fails,
   `NEXT_PUBLIC_WS_URL` is wrong — see [§9](#9-things-that-will-bite-you).*
4. **Code runs.** Click Run. Output appears in **both** tabs.
5. **Piston is still private.** From your own computer, `curl --max-time 5
   http://YOUR_SERVER_IP:2000/api/v2/runtimes` must fail.

---

## 4. Option B — managed hosting, no code execution

Use this if you want a public link without managing a server, and you accept that **Run will not
work**. Everything else does: rooms, live editing, cursors, presence, files, saving, accounts, and
saved rooms.

This is the project's current, deliberate state — the README explains why.

**Deploy the frontend to Vercel:**

1. Import the repository at [vercel.com](https://vercel.com).
2. **Set the Root Directory to `web`.** This is not optional and is easy to miss: the repository has
   no root `package.json`, so with this unset Vercel finds no framework, publishes an empty site,
   and every page 404s while the dashboard still says "Ready".
3. Add environment variables: `NEXT_PUBLIC_WS_URL` (your Railway `wss://` URL),
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `DATABASE_URL`, `DIRECT_URL`, and
   `TRUSTED_PROXY_HOPS=1`.
4. Deploy.

**Deploy the sync server to Railway:**

1. New project from the same repository, with the root directory set to `server`.
   `server/railway.json` already configures the start command and health check.
2. Add `DATABASE_URL`, `CLERK_SECRET_KEY`, `TRUSTED_PROXY_HOPS=1`, and
   `CLERK_AUTHORIZED_PARTIES=https://your-vercel-domain`.
3. Copy the public URL Railway gives you, convert `https://` to `wss://`, and put it in Vercel's
   `NEXT_PUBLIC_WS_URL`. **Redeploy Vercel afterwards** — that value is baked in at build time, so
   changing it alone does nothing.

**Apply the database schema once**, from your own computer with `DIRECT_URL` set in
`web/.env.local`:

```bash
cd web && npm run db:deploy
```

**Do not** set `PISTON_API_URL` to anything public. Leaving it unset means Run reports *"Could not
reach the code execution service"*, which is the correct, safe outcome. Pointing it at a tunnel to
your own machine is what this project removed on purpose — it exposes a privileged container with
no password to the entire internet.

If you later want Run to work, move to [Option A](#3-option-a--one-server-everything-works).

---

## 5. Keeping it running

Right now both programs stop when you close your terminal. `systemd` fixes that: it starts them at
boot and restarts them if they crash.

**Sync server:**

```bash
sudo nano /etc/systemd/system/collab-sync.service
```

```ini
[Unit]
Description=CollabCode sync server
After=network.target

[Service]
Type=simple
User=collab
WorkingDirectory=/home/collab/collabcode/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
# Give it time to save open rooms' files before it exits. See §6.
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

> This runs `node` directly rather than `npm start`. It is the same command, but the shutdown
> signal reaches the app immediately instead of passing through `npm` — and that signal is what
> triggers saving every open room's files before the process exits.

**Frontend:**

```bash
sudo nano /etc/systemd/system/collab-web.service
```

```ini
[Unit]
Description=CollabCode frontend
After=network.target

[Service]
Type=simple
User=collab
WorkingDirectory=/home/collab/collabcode/web
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Turn both on:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now collab-sync collab-web
sudo systemctl status collab-sync collab-web     # both should say "active (running)"
```

Piston needs nothing — `docker-compose.yml` already sets `restart: unless-stopped`.

**Reading logs:**

```bash
sudo journalctl -u collab-sync -f     # live sync server logs
sudo journalctl -u collab-web -f      # live frontend logs
docker logs -f piston_api             # sandbox logs
```

---

## 6. Updating to a new version

```bash
cd ~/collabcode
git pull

cd server && npm ci
sudo systemctl restart collab-sync

cd ../web && npm ci
npm run db:deploy          # only needed if the schema changed; harmless otherwise
npm run build              # must finish BEFORE the restart
sudo systemctl restart collab-web
```

> [!WARNING]
> **Restarting the sync server closes every room that is open at that moment.** Rooms live in
> memory, so everyone in one is disconnected and sent back to the home page. There is no way around
> this and it is not a bug.
>
> The design handles it as gracefully as it can: on a clean restart the server saves the final files
> of every qualifying room before exiting, so signed-in users still find their work on `/profile`.
> That save is given up to 20 seconds, so **let the restart finish** — do not force-kill it.
>
> **Deploy when nobody is using it.**

Always run `npm run build` **before** restarting the frontend. Restarting first serves the old build
until the new one finishes, which is confusing rather than harmful — but a *failed* build leaves you
serving something you did not intend.

---

## 7. Backups

There is remarkably little to back up, by design.

| What | Back it up? | Why |
| :-- | :-- | :-- |
| Live rooms | **Impossible** | They exist only in memory and are meant to be temporary. |
| The database | **Yes** | The only place real user data lives. |
| Piston's language packs | No | Re-downloaded by `docker compose up -d`. |
| The code | No | It is in Git. |
| Your `.env` files | **Yes — privately** | They contain secrets. Store them in a password manager, never in Git. |

**Managed Postgres** (Neon and similar) backs up automatically — check your provider's retention
settings and you are done.

**Self-hosted Postgres** needs you to do it. A daily dump:

```bash
sudo -u postgres pg_dump collabcode > ~/backup-$(date +%F).sql
```

Automate it with `crontab -e`:

```
0 3 * * * sudo -u postgres pg_dump collabcode > ~/backups/db-$(date +\%F).sql
```

A backup you have never restored is a guess, so test one at least once.

---

## 8. Safety checklist

Run through this after deploying, and again after any change to the server.

**Server**

- [ ] SSH uses a key; password login is off (`PasswordAuthentication no`).
- [ ] Root cannot log in over SSH (`PermitRootLogin no`).
- [ ] `sudo ufw status` shows **only** 22, 80, and 443.
- [ ] Automatic security updates are on.

**The sandbox — the important part**

- [ ] `curl --max-time 5 http://YOUR_SERVER_IP:2000/api/v2/runtimes` from another machine **fails**.
- [ ] `docker-compose.yml` still binds `127.0.0.1:2000:2000`, not `2000:2000`.
- [ ] Piston was started with `docker compose up -d`, so its limits are in force.
- [ ] Your reverse proxy config contains **no** rule pointing at port 2000.
- [ ] `PISTON_API_URL` is not set to any public address anywhere.

**The app**

- [ ] The site is HTTPS and `NEXT_PUBLIC_WS_URL` starts with `wss://`.
- [ ] Ports 3000 and 8080 are not open in the firewall.
- [ ] Database connection strings say `sslmode=verify-full`.
- [ ] `TRUSTED_PROXY_HOPS=1` in both `server/.env` and `web/.env.local`.
- [ ] `CLERK_AUTHORIZED_PARTIES` is set to your real domain.
- [ ] No `.env` file was ever committed — check with `git status`.

**Understand the trade-offs you are accepting**

- [ ] Anyone with a room link can join it. Room links are the only access control, and there are no
      room passwords yet.
- [ ] Anyone who can open your site can run code in your sandbox. The limits bound what a single run
      costs; they do not stop someone determined from being a nuisance.
- [ ] A server restart ends every live room.

---

## 9. Things that will bite you

Ordered by how often they catch people out.

**1. `NEXT_PUBLIC_WS_URL` was wrong or set too late.**
This is the number one deployment failure. The value is compiled into the website during
`npm run build`, so editing it afterwards changes nothing until you rebuild. It also controls which
addresses the browser is permitted to connect to. Symptom: the site looks perfect, but two tabs
never see each other's typing.
**Fix:** correct it in `web/.env.local`, run `npm run build` again, restart.

**2. `ws://` instead of `wss://` on an HTTPS site.**
Browsers refuse insecure connections from a secure page. Same symptom as above — everything looks
fine, nothing syncs. Your browser's developer console (F12) will show a mixed-content or blocked
connection error.

**3. Piston started without Compose.**
The time, memory, and output limits live only in `docker-compose.yml`. Started with a bare
`docker run`, Piston uses its own tighter defaults and **every run fails** with a message about
exceeding a configured limit. Always `docker compose up -d`.

**4. Using the pooled database URL for migrations.**
`npm run db:deploy` needs `DIRECT_URL`, the non-pooled one. The pooled connection cannot hold the
lock a migration takes, so it hangs or half-applies. Also check the file is named `.env.local`
exactly — that specific filename is what the Prisma configuration loads.

**5. Clerk keys from two different instances.**
Sign-in works, rooms work, and saved rooms silently never appear — with no error message anywhere.
Both `web/.env.local` and `server/.env` must hold keys from the *same* Clerk application.

**6. A wrong `CLERK_AUTHORIZED_PARTIES`.**
Same invisible symptom as above. If unsure, leave it empty — that means "do not check", which is
safe here because the token is verified either way.

**7. Vercel's Root Directory not set to `web`.**
Only affects Option B. Every page 404s while the dashboard reports a successful deployment.

**8. Expecting rooms to survive a restart.**
They do not, ever. Live rooms are in memory only. Signed-in users' *finished* rooms are saved; open
ones are not.

**9. An ARM server.**
The Piston image is amd64-only. On an ARM VPS it will not start at all. Check before you buy.

---

## 10. Troubleshooting

**The site does not load.**

```bash
sudo systemctl status collab-web        # is it running?
sudo journalctl -u collab-web -n 50     # what did it say?
sudo systemctl status caddy             # is the proxy running?
curl -o /dev/null -w '%{http_code}\n' localhost:3000    # is the app itself alive?
```

If `localhost:3000` answers 200 but the domain does not, the problem is Caddy or DNS, not the app.

**"Couldn't reach the sync server."**

```bash
sudo systemctl status collab-sync
curl localhost:8080/health              # expect {"ok":true}
```

If that works but the browser still complains, the `/sync/*` rule in your Caddyfile is wrong or
`NEXT_PUBLIC_WS_URL` does not match it.

**Two tabs do not see each other's typing.**
Almost always `NEXT_PUBLIC_WS_URL` — see [§9](#9-things-that-will-bite-you), items 1 and 2. Open the
browser console (F12) and look for a failed WebSocket connection; the address it tried to reach
tells you exactly what was baked into the build.

**"Could not reach the code execution service."**

```bash
docker ps                                        # is piston_api running?
curl -s localhost:2000/api/v2/runtimes | head -c 120
docker logs piston_api --tail 50
```

If Piston is fine and the app still cannot reach it, check `PISTON_API_URL` is either unset or
`http://localhost:2000`, and that both are on the same machine.

**Every run fails with "cannot exceed the configured limit."**
Piston was not started through Compose. Fix it:

```bash
cd ~/collabcode && docker compose down && docker compose up -d
```

**A program printing a lot of output looks like it crashed.**
Same cause. Piston's default output cap is 1 KB and it kills the sandbox rather than truncating.
`docker-compose.yml` raises it to 64 KB.

**Saved rooms never appear on `/profile`.**
Work through it in this order — the first two have no error message at all:

1. Are the Clerk keys in `server/.env` and `web/.env.local` from the same instance?
2. Is `CLERK_AUTHORIZED_PARTIES` correct, or empty?
3. Is `DATABASE_URL` set in **`server/.env`**? The sync server writes the snapshot, not the website.
4. Did the user stay at least 60 seconds **and** actually type? Both are required.
5. Was anyone in the room signed in? An all-guest room saves nothing, by design.

```bash
sudo journalctl -u collab-sync -n 100 | grep -i snapshot
```

**The server is out of disk.**

```bash
df -h                    # how full?
docker system prune -a   # removes unused images — will re-download on demand
```

---

## Related documents

- **[`../README.md`](../README.md)** — what the project is, and how to run it on your own computer.
- **[`../CLAUDE.md`](../CLAUDE.md)** — the engineering notebook: why each decision was made.
- **[`TESTING.md`](TESTING.md)** — the test suite and audit report, including known limitations.

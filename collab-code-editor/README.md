This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.



What Docker actually is

Normally, if you want to run someone else's software (like the Piston code-execution engine), you'd have to install its exact dependencies, correct OS libraries, correct language runtimes, etc., directly on your machine. That's fragile — it works on their machine, maybe not yours.

Docker fixes this by shipping a container: a lightweight, self-contained box that includes the app and everything it needs to run (its own mini filesystem, libraries, processes) but shares your computer's kernel, so it's fast to start (~seconds, not like a full VM). You just say "run this image" and Docker guarantees it behaves identically everywhere.

Two words that matter:
- Image — the frozen recipe/template (e.g. ghcr.io/engineer-man/piston). Read-only, downloaded once.
- Container — a running instance of that image. You can start, stop, delete it; the image stays untouched.

Why this app needs Docker

Your editor lets users type arbitrary code and click "Run." Somewhere, that code has to actually execute — and running untrusted code directly on your server would be dangerous (it could read your files, crash your machine, etc.).

Piston is the sandbox engine that solves this: it runs the submitted code in an isolated, resource-limited environment and hands back stdout/stderr. Originally your app called the public Piston API (emkc.org) over the internet — easy, but rate-limited and outside your control. You asked to self-host it instead, so now Piston runs as a Docker container on your own machine/server.

Docker is the natural fit here because Piston needs a very specific, isolated Linux environment (cgroups, multiple language runtimes, privileged sandboxing) — exactly what a container is built to package up. Without Docker, you'd have to manually install Node, Python, Java, and GCC compilers system-wide just to run this one service.

What's in docker-compose.yml

docker-compose.yml is just a config file that describes "what containers do I want running." Yours:

services:
  piston:
    image: ghcr.io/engineer-man/piston   # the recipe to download/run
    container_name: piston_api           # friendly name for the running container
    restart: unless-stopped              # auto-restart if it crashes or machine reboots
    privileged: true                     # Piston needs deeper OS access to sandbox code
    ports:
      - "2000:2000"                      # expose container's port 2000 to your machine's port 2000
    volumes:
      - piston_data:/piston              # persist installed language packages on disk
    tmpfs:
      - /piston/jobs:exec                # scratch space for each code run, wiped each time

- docker compose up -d reads this file and starts the container in the background (-d = detached).
- ports: "2000:2000" is the key line — it's a bridge: anything you send to localhost:2000 on your real machine gets forwarded into the container, which is listening on its own internal port 2000.

The actual request flow when you click "Run"

1. Browser (CodeEditor.tsx) sends your code to your Next.js server: POST /api/execute.
2. Your route handler (app/api/execute/route.ts) receives it, and forwards it to Piston at http://localhost:2000/api/v2/execute — this is the Docker container.
3. Inside the container, Piston spins up an isolated sandbox, runs your code with the right language runtime (Node/Python/Java/GCC — these were pre-installed as "packages" into that piston_data volume), and captures stdout/stderr/exit code.
4. Piston sends the result back to your Next.js route, which reformats it and sends it back to the browser to display in the output panel.

So really: your Next.js app never runs user code itself — it just relays the request to the Docker container, which does the dangerous part in isolation, and relays the result back.

Useful commands to know

docker compose up -d       # start Piston in the background
docker compose down        # stop and remove the container
docker compose ps          # see if it's running
docker logs piston_api     # see what Piston is doing/any errors
docker compose restart     # restart it

Right now it's already running (I started it earlier) — you can confirm with docker compose ps.
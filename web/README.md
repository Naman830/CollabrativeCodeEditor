# web — CollabCode frontend

Next.js 16 (App Router) + Monaco + Yjs. Renders the room, proxies code execution to Piston, and
reads dead-room snapshots back out of Postgres for `/profile`.

See the [repo README](../README.md) for the architecture and the full three-process quick start.

## Run

```bash
npm install
cp .env.example .env.local   # then fill in the Clerk and Neon values
npm run dev                  # → http://localhost:3000
```

Use `localhost`, not `127.0.0.1` — Clerk's dev instance only allows the former, and on the wrong
host it silently never loads.

The room needs the sync server on `:8080` (`cd ../server && npm run dev`), and **Run** needs the
Piston container (`docker compose up -d` from the repo root).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | `prisma generate` then `next build` — generate must come first |
| `npm run lint` | ESLint |
| `npm run db:migrate` | `prisma migrate dev` (uses `DIRECT_URL`, the unpooled endpoint) |
| `npm run db:studio` | Prisma Studio |

## Layout

```
src/
├── app/          routes ONLY — page/layout/route/error files
├── components/   editor · profile · layout · ui
├── hooks/        useCollabRoom holds the entire client Yjs stack
├── lib/          collab · editor · sandbox · data, plus 4 root utilities
├── styles/       globals.css — the whole design system
└── proxy.ts      Clerk's request hook (Next 16's rename of middleware.ts)
```

Two rules this layout depends on:

- **`src/app/` contains routes and nothing importable.** A shared module goes in `components/`,
  `hooks/`, `lib/` or `styles/`.
- **Cross-folder imports use `@/`** (`@/lib/collab/user`, mapped to `src/`); same-folder imports
  stay relative (`./FileTabMenu`). The one exception is `lib/data/db.ts`, which reaches the
  Prisma client in `generated/` — that sits outside `src/`, so it stays relative.

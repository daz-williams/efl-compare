# EFL Compare — Web Server

A small, **self-contained** web front-end for the EFL Electricity Plan
Comparator. It lives entirely inside this `web/` folder and can be started
independently. It does **not** modify the parent project — it only *reads* the
JSON that `efl_compare.py` already produces (`plans_latest.json`) and serves it
as an interactive web page plus a small JSON API.

- **Zero third-party dependencies** — Python standard library only.
- Nothing in the parent project imports this folder; deleting `web/` leaves the
  original tool completely intact.
- The upstream author can merge this as a new, isolated folder.

---

## How it fits together

```
efl_compare.py  ──(--json)──►  plans_latest.json  ──(read)──►  web/serve.py  ──►  browser
   (heavy CLI: fetch,            (data contract,                (lightweight,
    parse EFLs, LLM,             already emitted by             stdlib HTTP,
    ~150s, needs GPU)            the parent tool)               no LLM/GPU)
```

The web server is deliberately **decoupled from the heavy pipeline**. You run
the parent CLI whenever you want fresh data; the server just serves the latest
JSON on disk. The data file is re-read on every request, so re-running the CLI
refreshes the site with no server restart.

---

## Quick start

### 1. Generate data (parent project, from the repo root)

```
python3 efl_compare.py --zip YOUR_ZIP --json plans_latest.json
```

This writes `plans_latest.json` in the repo root (already git-ignored as a
generated output).

### 2. Start the server

```
python3 web/serve.py
```

Then open <http://127.0.0.1:8090/>.

> Port **8090** is the default because `4000`, `8080` and `8000` are already in
> use by other containers on this host. Override with `--port`.

By default the server looks for `../plans_latest.json` relative to this folder
(i.e. the repo root). If it isn't there yet, the page shows setup instructions
instead of failing.

## Options

| Flag | Default | Description |
|---|---|---|
| `--host HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to expose on your LAN. |
| `--port N` | `8090` | Port to listen on. |
| `--json-path PATH` | `../plans_latest.json` | Explicit data file. Overrides `EFL_JSON` and the default. |

You can also point the server at any JSON file via the `EFL_JSON` environment
variable:

```
EFL_JSON=/path/to/plans_latest.json python3 web/serve.py
```

Data resolution order (first hit wins): `--json-path` → `EFL_JSON` →
`../plans_latest.json`. If none exist, the pages show setup instructions
rather than failing.

---

## Docker + Cloudflare Tunnel (public access)

`docker-compose.yml` runs the whole thing in containers and exposes it publicly
through a Cloudflare Tunnel — no inbound ports opened on the host.

### 1. Configure the token

```
cp .env.example .env
# edit .env and set CLOUDFLARE_TOKEN=<your tunnel connector token>
```

`.env` is git-ignored, so the token never reaches the upstream PR.

### 2. Start

```
docker compose up -d
docker compose logs -f          # watch for "Registered tunnel connection"
```

Two services come up:

| Service | What it does |
|---|---|
| `web` (`efl-web`) | Runs `serve.py` on `0.0.0.0:8090`, published to the host as `127.0.0.1:8090` (local only) and reachable as `http://web:8090` inside the compose network. Mounts the repo read-only so it finds `../plans_latest.json`. |
| `cloudflared` (`efl-cloudflared`) | Cloudflare Tunnel connector. Reads `CLOUDFLARE_TOKEN` from `.env`. |

### 3. Point the tunnel at the web service (one-time, in Cloudflare)

The tunnel connects outbound, but Cloudflare needs to know **which local service
to route public traffic to**. For a token (remote-managed) tunnel this lives in
the dashboard, not in this repo:

> **Zero Trust → Networks → Tunnels →** your tunnel **→ Public Hostname → Add**
> - Pick your hostname (e.g. `efl.example.com`)
> - **Service:** `HTTP`  →  `web:8090`

Because `cloudflared` and `web` share the compose network, the service address
is the container name: **`http://web:8090`**. Once saved, your hostname serves
the comparison page over HTTPS.

### Stop

```
docker compose down
```

---

## HTTP API

| Route | Returns |
|---|---|
| `GET /` | The interactive comparison table. |
| `GET /wizard` | The plain-language guided view (see below). |
| `GET /full` | The parent CLI's own `plans_latest.html`, if it has been generated. Also at `/table`. |
| `GET /api/plans` | The full plan JSON (parent schema) plus a `_source` block describing where the data came from. |
| `GET /api/health` | `{ status, data_available, source }` — handy for scripts/monitors. |

`GET /api/plans` returns exactly the parent tool's `--json` payload
(`generated`, `zip`, `tdu`, `usage_tiers`, `compare_tier`, `plans[]`) with an
added `_source` object. On error (no data file, bad JSON, …) it returns
`200` with `_source.ok = false` and a human-readable `message`, plus an empty
`plans` array — so the front-end can render a helpful state rather than a stack
trace.

---

## The wizard (`/wizard`)

A plain-language, mobile-friendly view for people who don't want to read a rate
table. It asks how much electricity you use — either your real kWh from your
bill, or a home-size estimate — and shows the three cheapest plans as plain
dollars per month.

It renders entirely in the browser from `/api/plans`. **The parent CLI needs no
knowledge of it:** the pricing mirrors the CLI's `effective_cents_per_kwh()`
using the raw rate components the CLI already exports (`energy_charge_cents`,
`base_charge_dollars`, `tdu_bundled`, `energy_threshold_kwh`,
`tier_boundary_kwh`, `ec_cents_above_tier`, `bill_credits`). At the standard
tiers its numbers reproduce the CLI's own `rates_cents_per_kwh` exactly; between
them it prices from the same formula.

**Break-even on switching.** If you enter your current bill, it compares it to
the cheapest plans. Tell it your exit fee and how many months are left on your
contract and it weighs the one-time early-termination fee against the recurring
saving, then says plainly whether to switch now or wait it out. Leave those
blank and it reports how many months the fee takes to earn back instead.

---

## What the main page does

- Groups plans by contract term (longest first), collapsible.
- Compare-tier selector (from the data's `usage_tiers`) drives the shown
  ¢/kWh and estimated $/mo.
- Sort by rate, estimated monthly cost, term, renewable %, or name.
- Filter by provider/plan text, hide bill-credit plans, favorites-only.
- Per-row favorite (❤), cheapest-in-group star (★), and your current plan
  (📍 / outlined row) mirror the parent tool's conventions.
- Source badges — `EFL` / `LLM` / `API` — plus `¢` (bill credit), `M`
  (manual), `⚠` (setup fee), `CURRENT`.
- Dark/light theme toggle (defaults to dark), remembered across visits.

Favorites, collapsed groups, and theme are stored in the browser's
`localStorage` — no server-side state, no database.

---

## Files

```
web/
├── serve.py                     stdlib HTTP server (the only thing you run)
├── README.md                    this file
├── requirements.txt             documents the zero-dependency stance
├── docker-compose.yml           web server + cloudflare tunnel
├── .env.example                 template for CLOUDFLARE_TOKEN
├── .gitignore                   keeps .env (the token) out of git
├── static/
│   ├── index.html               page shell
│   ├── styles.css               theme-aware styling
│   ├── app.js                   fetches /api/plans, renders the table
│   ├── wizard.html              guided plain-language view (shell + styling)
│   └── wizard.js                prices plans client-side from /api/plans
```

---

## License

Part of the EFL Electricity Plan Comparator project. GPLv3 — see the
repository root `LICENSE`.

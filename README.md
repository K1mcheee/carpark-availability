# ParkWhere SG

Small JavaScript site for searching Singapore carparks by readable name and showing live availability.

## Storage

- The server stores successful and failed sync attempts in `data/parkwhere.sqlite`.
- It serves the latest successful snapshot from SQLite immediately.
- It only fetches upstream data when the cached snapshot is stale.
- It allows only one upstream refresh at a time, even if many users hit the site together.
- If an upstream API goes down, users still see the most recently stored snapshot.

## Data sources

- Live availability: `https://api.data.gov.sg/v1/transport/carpark-availability`
- HDB code-to-address mapping: `https://data.gov.sg/datasets/d_23f946fa557947f93a8043bbef41dd09/view`
- Optional mall and non-HDB live availability: LTA DataMall `CarParkAvailabilityv2`

## Notes

- HDB carparks are joined server-side with the HDB carpark information dataset so addresses are displayed directly.
- LTA DataMall support is built in behind the `LTA_ACCOUNT_KEY` environment variable. When present, the app will also load live mall and other non-HDB carparks from `CarParkAvailabilityv2`.
- If the same carpark appears in both HDB and LTA feeds, the app keeps the HDB result and drops the LTA duplicate.
- Vehicle-type breakdown is shown when available, including cars, motorcycles, and heavy vehicles.
- Requests are served from the database snapshot instead of calling upstream APIs directly.
- No timer-based polling runs on the backend when nobody is visiting the site.

## Run locally

```bash
node server.js
```

Then open `http://localhost:4173`.

Optional environment variables:

```powershell
$env:CACHE_STALE_MS="60000"
$env:REFRESH_COOLDOWN_MS="60000"
```

## Enable LTA DataMall

PowerShell:

```powershell
$env:LTA_ACCOUNT_KEY="your-lta-account-key"
node server.js
```

## Render deploy

- This repo includes [render.yaml](C:/Users/kimbe/Documents/Codex/2026-04-26/i-want-to-build-a-website/render.yaml) for a Node web service plus a persistent disk for SQLite.
- Set `LTA_ACCOUNT_KEY` in Render if you want mall and other LTA carparks.
- `DATABASE_PATH` is pointed at the persistent disk so cached snapshots survive restarts and deploys.
- Push the repo to GitHub, then create the Render service from the repo or blueprint.

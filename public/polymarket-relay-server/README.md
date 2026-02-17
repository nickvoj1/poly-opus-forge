# Polymarket CLOB Relay Server

Lightweight HTTP relay that forwards signed orders to Polymarket's CLOB API from a US IP, bypassing geo-restrictions.

## Deploy on Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub (or "Empty Project" + upload)
2. Upload/push this folder as a repo
3. Railway auto-detects Node.js and runs `npm start`
4. Set environment variable `RELAY_SECRET` to a random string (optional but recommended)
5. **IMPORTANT**: Set the region to **US** in Settings → Region
6. Copy the generated URL (e.g., `https://polymarket-relay-production.up.railway.app`)

## Deploy on Fly.io

```bash
cd polymarket-relay-server
fly launch --name polymarket-relay --region iad
fly secrets set RELAY_SECRET=your-secret-here
fly deploy
```

## Deploy on Render

1. Go to [render.com](https://render.com) → New Web Service
2. Point to your repo or upload this folder
3. Set Build Command: `npm install`, Start Command: `node index.js`
4. Set region to US, add `RELAY_SECRET` env var
5. Copy the URL

## Usage

### POST /order (shortcut for Polymarket CLOB)
```json
{
  "order": { /* signed order object */ },
  "headers": { /* POLY_* auth headers */ }
}
```

### POST /proxy (generic proxy)
```json
{
  "url": "https://clob.polymarket.com/order",
  "method": "POST",
  "headers": { "POLY_ADDRESS": "...", ... },
  "body": { /* request body */ }
}
```

### GET /health
Returns `{ "status": "ok", "region": "...", "ts": 1234567890 }`

## After Deployment

Give the relay URL to Lovable and it will update the edge function to route orders through it.

# David-Pair

The pairing site for [David-MD](https://github.com/dave-programmer01/david-md).

A visitor enters their WhatsApp number, gets an 8-character pairing code, links
it on their phone, and receives their `SESSION_ID` plus a full deploy tutorial
**as a WhatsApp message to themselves**.

---

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Docker:

```bash
docker build -t david-pair . && docker run -p 3000:3000 david-pair
```

### Hosting

This holds a live WhatsApp WebSocket open for up to five minutes per visitor, so
**it cannot run on serverless** — Vercel, Netlify and Cloudflare Workers all kill
the function long before pairing completes. It needs a persistent container:

| Host | How |
|---|---|
| **Render** | New → Web Service → point at this repo. `render.yaml` is included. |
| **Railway** | New Project → Deploy from GitHub. Detects the Dockerfile. |
| **Fly.io** | `fly launch` then `fly deploy`. |
| **Your VPS** | `docker run -d -p 3000:3000 --restart always david-pair` behind nginx. |

Free tiers that sleep on idle are fine — the site wakes on the first request and
pairing finishes well inside one request window.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Injected automatically by most hosts |
| `BOT_REPO` | `dave-programmer01/david-md` | Repo link in the tutorial message |
| `SITE_URL` | derived from the request | Only used in the tutorial's troubleshooting line |

---

## How it works

```
POST /api/pair       { phone }   → { id, state, code }
GET  /api/status/:id             → { state, code, error, sentTo }
```

`state` moves through `starting → waiting → linked → sent`, or lands on `failed`.

1. A per-request temp directory is created and a Baileys socket opened against it
2. `requestPairingCode()` returns the code, which the browser polls for
3. On `connection: open`, the site waits for `creds.json` to be written, base64s
   it into `David~…`, and sends two messages to the user's own JID — the bare
   session ID (one long-press to copy) and the deploy tutorial
4. The socket is closed with `ws.close()`, **not** `logout()` — logging out would
   invalidate the credentials that were just issued
5. The temp directory is deleted in a `finally` that also runs on failure and on
   timeout

### On credentials

This server sees every visitor's WhatsApp credentials in the seconds between
generating and sending them. That is the nature of a pairing service, and the
code is written around containing it:

- credentials never leave the per-request temp directory
- nothing about a session is logged or written to a database
- the directory is removed on success, failure, and timeout alike
- jobs expire from memory after five minutes
- pairing is rate-limited to 3 attempts per IP per minute

If you fork this, keep those properties. Adding a "just log it for debugging"
line here would hand you a file full of live WhatsApp logins.

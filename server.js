const path = require("path");
const express = require("express");
const { startPairing, getJob } = require("./src/pair");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// One pairing attempt per IP per minute. Each attempt holds an open WhatsApp
// socket for up to five minutes, so this is a resource guard as much as an
// abuse one.
const attempts = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX = 3;

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [ip, times] of attempts) {
    const recent = times.filter((t) => t > cutoff);
    if (recent.length) attempts.set(ip, recent);
    else attempts.delete(ip);
  }
}, 60_000).unref();

function rateLimited(ip) {
  const cutoff = Date.now() - RATE_WINDOW;
  const recent = (attempts.get(ip) || []).filter((t) => t > cutoff);
  if (recent.length >= RATE_MAX) return true;
  recent.push(Date.now());
  attempts.set(ip, recent);
  return false;
}

const siteUrl = (req) =>
  process.env.SITE_URL || `${req.protocol}://${req.get("host")}`;

app.post("/api/pair", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  const phone = String(req.body?.phone || "").replace(/[^0-9]/g, "");

  // Validate before counting against the rate limit. A mistyped number costs
  // nothing — only attempts that actually open a WhatsApp socket are counted,
  // since those are what the limit exists to protect.
  if (phone.length < 8 || phone.length > 16) {
    return res.status(400).json({
      error: "That doesn't look right. Enter your full number with country code, digits only.",
    });
  }
  if (phone.startsWith("0")) {
    return res.status(400).json({
      error: "Drop the leading 0 and start with your country code — e.g. 234 803 456 7890, not 0803…",
    });
  }

  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
  }

  try {
    const job = await startPairing(phone, { site: siteUrl(req) });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "That pairing session expired. Start again." });
  res.json(job);
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n🔗 Pairing site on http://localhost:${PORT}\n`);
});

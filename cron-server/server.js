import express from "express";
import cron from "node-cron";
import fetch from "node-fetch";

const app = express();

const PORT = process.env.PORT || 8080;
const SITE_URL = process.env.SITE_URL || "";
const SETTLE_SHARED_SECRET = process.env.SETTLE_SHARED_SECRET || "";

if (!SITE_URL) {
  console.warn(
    "[cron-server] Warning: SITE_URL is not set; scheduled job will no-op."
  );
}
if (!SETTLE_SHARED_SECRET) {
  console.warn(
    "[cron-server] Warning: SETTLE_SHARED_SECRET is not set; scheduled job will no-op."
  );
}

async function postSettle(gameId) {
  if (!SITE_URL || !SETTLE_SHARED_SECRET) {
    return { ok: false, error: "Missing SITE_URL or SETTLE_SHARED_SECRET" };
  }
  const url = `${SITE_URL.replace(/\/+$/, "")}/api/settle-game`;
  const body = gameId ? { gameId: String(gameId) } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-settle-secret": SETTLE_SHARED_SECRET,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Manual trigger: /trigger?gameId=123
app.get("/trigger", async (req, res) => {
  try {
    const gameId = req.query.gameId ? String(req.query.gameId) : undefined;
    const result = await postSettle(gameId);
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res
      .status(500)
      .json({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
  }
});

// Schedule: every 3 minutes
cron.schedule("*/3 * * * *", async () => {
  try {
    const ts = new Date().toISOString();
    const jitter = Math.floor(Math.random() * 15000);
    await new Promise((r) => setTimeout(r, jitter));
    const result = await postSettle();
    console.log(`[${ts}] cron run -> status=${result.status} ok=${result.ok}`);
  } catch (err) {
    console.error("[cron] error", err);
  }
});

app.listen(PORT, () => {
  console.log(`[cron-server] listening on :${PORT}`);
});


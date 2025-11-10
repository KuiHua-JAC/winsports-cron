import express from "express";
import cron from "node-cron";
import fetch from "node-fetch";
import axios from "axios";
import admin from "firebase-admin";

const app = express();

const PORT = process.env.PORT || 8080;
const SITE_URL = process.env.SITE_URL || "";
const SETTLE_SHARED_SECRET = process.env.SETTLE_SHARED_SECRET || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_FETCH_SECRET = process.env.ODDS_FETCH_SECRET || "";

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!raw) {
    console.warn(
      "[cron-server] FIREBASE_SERVICE_ACCOUNT_BASE64 not set; Firebase features disabled"
    );
  } else {
    try {
      let jsonText = "";
      try {
        const decoded = Buffer.from(raw, "base64").toString("utf-8");
        if (decoded.trim().startsWith("{")) {
          jsonText = decoded;
        }
      } catch {
        // ignore, will try raw JSON below
      }

      if (!jsonText && raw.trim().startsWith("{")) {
        jsonText = raw;
      }

      if (!jsonText) {
        console.warn(
          "[cron-server] FIREBASE_SERVICE_ACCOUNT_BASE64 present but not valid base64/JSON"
        );
      } else {
        const serviceAccount = JSON.parse(jsonText);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
        console.log("[cron-server] Firebase Admin initialized successfully");
      }
    } catch (err) {
      console.warn("[cron-server] Failed to initialize Firebase Admin", err);
    }
  }
}

const db = admin.apps.length ? admin.firestore() : undefined;

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

if (!ODDS_API_KEY) {
  console.warn(
    "[cron-server] Warning: ODDS_API_KEY is not set; odds fetching disabled."
  );
}

/**
 * Fetch all NHL events and their odds from The Odds API and cache them in Firestore.
 * This function is called daily to keep odds fresh.
 */
async function fetchAndCacheOdds() {
  if (!ODDS_API_KEY) {
    console.error("[odds-fetch] ODDS_API_KEY not set, skipping");
    return { ok: false, error: "Missing ODDS_API_KEY" };
  }
  if (!db) {
    console.error("[odds-fetch] Firestore not initialized, skipping");
    return { ok: false, error: "Firestore not initialized" };
  }

  const startTime = Date.now();
  console.log("[odds-fetch] Starting odds fetch and cache operation...");

  try {
    // Step 1: Fetch all NHL events
    console.log("[odds-fetch] Fetching NHL events from The Odds API...");
    const eventsUrl = "https://api.the-odds-api.com/v4/sports/icehockey_nhl/events";
    const eventsResponse = await axios.get(eventsUrl, {
      params: { apiKey: ODDS_API_KEY },
      timeout: 30000,
    });

    const events = Array.isArray(eventsResponse.data) ? eventsResponse.data : [];
    console.log(`[odds-fetch] Found ${events.length} NHL events`);

    if (events.length === 0) {
      console.log("[odds-fetch] No events to process");
      return { ok: true, count: 0, message: "No events found" };
    }

    // Step 2: Fetch odds for each event
    const markets = [
      "h2h",
      "totals",
      "player_shots_on_goal",
      "player_goals",
      "player_assists",
      "player_points",
      "player_goal_scorer_anytime",
      "player_goal_scorer_first",
    ].join(",");

    const results = [];
    const errors = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const eventId = String(event.id || "");
      
      if (!eventId) {
        console.warn(`[odds-fetch] Skipping event ${i} with no ID`);
        continue;
      }

      try {
        console.log(
          `[odds-fetch] Fetching odds for event ${i + 1}/${events.length}: ${eventId} (${
            event.home_team || "?"
          } vs ${event.away_team || "?"})`
        );

        const oddsUrl = `https://api.the-odds-api.com/v4/sports/icehockey_nhl/events/${encodeURIComponent(
          eventId
        )}/odds`;
        
        const oddsResponse = await axios.get(oddsUrl, {
          params: {
            apiKey: ODDS_API_KEY,
            regions: "us,eu",
            oddsFormat: "decimal",
            markets,
          },
          timeout: 30000,
        });

        const oddsData = oddsResponse.data || {};
        const bookmakers = Array.isArray(oddsData.bookmakers)
          ? oddsData.bookmakers
          : [];

        // Organize odds by market
        const marketData = {
          h2h: [],
          totals: [],
          player_shots_on_goal: [],
          player_goals: [],
          player_assists: [],
          player_points: [],
          player_goal_scorer_anytime: [],
          player_goal_scorer_first: [],
        };

        for (const bookmaker of bookmakers) {
          const bookmakerKey = String(bookmaker.key || bookmaker.title || "unknown");
          const marketsArray = Array.isArray(bookmaker.markets)
            ? bookmaker.markets
            : [];

          for (const market of marketsArray) {
            const marketKey = String(market.key || "");
            const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];

            for (const outcome of outcomes) {
              const entry = {
                bookmaker: bookmakerKey,
                selection: String(outcome.name || ""),
                description: String(outcome.description || ""),
                odds: Number(outcome.price || 0),
                point: typeof outcome.point === "number" ? outcome.point : null,
                lastUpdated: String(market.last_update || ""),
              };

              if (marketData[marketKey]) {
                marketData[marketKey].push(entry);
              }
            }
          }
        }

        // Store in Firestore
        const docRef = db.collection("odds_cache").doc(`nhl_${eventId}`);
        const cacheDoc = {
          eventId,
          gameId: String(event.sport_key || "icehockey_nhl"),
          homeTeam: String(event.home_team || ""),
          awayTeam: String(event.away_team || ""),
          commenceTime: String(event.commence_time || ""),
          lastFetched: Date.now(),
          markets: marketData,
        };

        await docRef.set(cacheDoc, { merge: true });
        results.push({ eventId, success: true });

        console.log(`[odds-fetch] ✓ Cached odds for event ${eventId}`);

        // Rate limiting: small delay between requests
        if (i < events.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (err) {
        const errorMsg = err.message || String(err);
        console.error(`[odds-fetch] ✗ Failed to fetch odds for event ${eventId}:`, errorMsg);
        errors.push({ eventId, error: errorMsg });
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[odds-fetch] Complete in ${duration}s. Success: ${results.length}, Errors: ${errors.length}`
    );

    return {
      ok: true,
      count: results.length,
      errors: errors.length,
      duration,
      results,
      errorDetails: errors,
    };
  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`[odds-fetch] Fatal error after ${duration}s:`, err);
    return {
      ok: false,
      error: err.message || String(err),
      duration,
    };
  }
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

// Manual trigger for odds fetch: /trigger-odds-fetch
app.get("/trigger-odds-fetch", async (req, res) => {
  try {
    // Optional secret check
    if (ODDS_FETCH_SECRET) {
      const provided = req.query.secret || req.headers["x-odds-fetch-secret"];
      if (provided !== ODDS_FETCH_SECRET) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    console.log("[trigger-odds-fetch] Manual trigger initiated");
    const result = await fetchAndCacheOdds();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});

// Schedule: every 3 minutes (settlement)
cron.schedule("*/3 * * * *", async () => {
  try {
    const ts = new Date().toISOString();
    const jitter = Math.floor(Math.random() * 15000);
    await new Promise((r) => setTimeout(r, jitter));
    const result = await postSettle();
    console.log(`[${ts}] settlement cron -> status=${result.status} ok=${result.ok}`);
  } catch (err) {
    console.error("[cron][settlement] error", err);
  }
});

// Schedule: daily at 00:00 UTC (odds fetch)
cron.schedule("0 0 * * *", async () => {
  try {
    const ts = new Date().toISOString();
    console.log(`[${ts}] Starting daily odds fetch cron job`);
    const result = await fetchAndCacheOdds();
    console.log(
      `[${ts}] Daily odds fetch complete -> ok=${result.ok} count=${
        result.count || 0
      } errors=${result.errors || 0}`
    );
  } catch (err) {
    console.error("[cron][odds-fetch] error", err);
  }
});

app.listen(PORT, () => {
  console.log(`[cron-server] listening on :${PORT}`);
  console.log("[cron-server] Settlement cron: every 3 minutes");
  console.log("[cron-server] Odds fetch cron: daily at 00:00 UTC");
});


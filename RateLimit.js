/**
 * ADVANCED RATE LIMIT & ANTI-ABUSE SYSTEM
 * High-performance / Game Backend Ready
 */

const crypto = require("crypto");
const fs = require("fs");

/* ===============================
   STORES (memory)
   large production -> Redis
================================ */
const requestStore = new Map();
const banStore = new Map();
const replayStore = new Map();

/* ===============================
   EXTREME (HIGH) CONFIGURATION
================================ */
const CONFIG = {
  // GLOBAL
  WINDOW_MS: 10_000,
  MAX_REQUESTS: 400,        // 400 req / 10s (40 req/s)

  // BURST (quick spam)
  BURST_WINDOW_MS: 1_000,
  BURST_LIMIT: 80,          // 80 req / 1s

  // ADAPTIVE (good customers earn more)
  TRUST_START: 1.0,
  TRUST_BONUS_MAX: 2.5,     // up to 2.5x limit
  TRUST_INCREASE: 0.05,
  TRUST_DECAY: 0.1,
  TRUST_DECAY_MS: 60_000,

  // BAN
  BASE_BAN_MS: 180_000,     // 3 min
  MAX_STRIKES: 7,
  HARD_BAN_MULTIPLIER: 4,

  // SECURITY
  TIMESTAMP_TOLERANCE: 20_000,
  SILENT_MODE: true,

  CLEANUP_INTERVAL: 30_000
};

/* ===============================
   ROUTE LIMITS (HIGH)
================================ */
const ROUTE_LIMITS = {
  "/login":     { window: 10_000, max: 8 },
  "/match":     { window: 10_000, max: 500 },
  "/event":     { window: 10_000, max: 600 },
  "/sync":      { window: 5_000,  max: 300 },
  "/heartbeat": { window: 5_000,  max: 400 }
};

/* ===============================
   WHITELIST (bypass total)
================================ */
const WHITELIST_KEYS = new Set([
  "staff-secret-token",
  "internal-bot-token"
]);

/* ===============================
   ABUSE LOG
================================ */
function logAbuse(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync("ratelimit.log", line);
}

/* ===============================
   CUSTOMER IDENTITY
================================ */
function generateClientKey(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown-ip";

  const deviceId =
    req.headers["device-id"] ||
    req.headers["x-device-id"] ||
    "unknown-device";

  const token =
    req.headers["authorization"] ||
    req.headers["x-token"] ||
    "no-token";

  return crypto
    .createHash("sha256")
    .update(ip + deviceId + token)
    .digest("hex");
}

/* ===============================
   ANTI-REPLAY
================================ */
function checkReplay(req, clientKey) {
  const ts = Number(req.headers["x-timestamp"]);
  if (!ts) return true;

  const now = Date.now();
  if (Math.abs(now - ts) > CONFIG.TIMESTAMP_TOLERANCE) return false;

  const key = `${clientKey}:${ts}`;
  if (replayStore.has(key)) return false;

  replayStore.set(key, now);
  return true;
}

/* ===============================
   ADAPTIVE TRUST
================================ */
function updateTrust(data, now) {
  if (data.timestamps.length < data.limit * 0.3) {
    data.trust = Math.min(
      CONFIG.TRUST_BONUS_MAX,
      data.trust + CONFIG.TRUST_INCREASE
    );
  }

  if (now - data.lastSeen > CONFIG.TRUST_DECAY_MS) {
    data.trust = Math.max(
      CONFIG.TRUST_START,
      data.trust - CONFIG.TRUST_DECAY
    );
  }

  data.lastSeen = now;
}



function RateLimit(req, res, next) {
  const now = Date.now();
  const clientKey = generateClientKey(req);

  const token = req.headers["authorization"];
  if (WHITELIST_KEYS.has(token)) return next();

 
  if (!checkReplay(req, clientKey)) {
    logAbuse(`Replay detectado: ${clientKey}`);
    return res.status(401).json({ error: "Invalid request" });
  }

  
  if (banStore.has(clientKey)) {
    const ban = banStore.get(clientKey);
    if (ban.expires > now) {
      return res.status(429).json(
        CONFIG.SILENT_MODE
          ? { error: "Blocked" }
          : {
              error: "Temporarily blocked",
              retryAfter: Math.ceil((ban.expires - now) / 1000),
              strikes: ban.strikes
            }
      );
    }
    banStore.delete(clientKey);
  }


  const routeConfig = ROUTE_LIMITS[req.path] || {
    window: CONFIG.WINDOW_MS,
    max: CONFIG.MAX_REQUESTS
  };

  
  if (!requestStore.has(clientKey)) {
    requestStore.set(clientKey, {
      timestamps: [],
      burst: [],
      strikes: 0,
      trust: CONFIG.TRUST_START,
      lastSeen: now,
      limit: routeConfig.max
    });
  }

  const data = requestStore.get(clientKey);

  data.limit = Math.floor(routeConfig.max * data.trust);


  data.timestamps = data.timestamps.filter(
    t => now - t < routeConfig.window
  );
  data.timestamps.push(now);

 
  data.burst = data.burst.filter(
    t => now - t < CONFIG.BURST_WINDOW_MS
  );
  data.burst.push(now);


  if (data.burst.length > CONFIG.BURST_LIMIT) {
    data.strikes++;
    logAbuse(`Burst abuse: ${clientKey}`);
  }


  if (data.timestamps.length > data.limit) {
    data.strikes++;
  }

  
  if (data.strikes > 0) {
    let banTime = CONFIG.BASE_BAN_MS * data.strikes;

    if (data.strikes >= CONFIG.MAX_STRIKES) {
      banTime *= CONFIG.HARD_BAN_MULTIPLIER;
    }

    banStore.set(clientKey, {
      expires: now + banTime,
      strikes: data.strikes
    });

    requestStore.delete(clientKey);
    logAbuse(`BAN ${data.strikes}x: ${clientKey}`);

    return res.status(429).json(
      CONFIG.SILENT_MODE
        ? { error: "Blocked" }
        : {
            error: "Rate limit exceeded",
            banSeconds: Math.ceil(banTime / 1000),
            strikes: data.strikes
          }
    );
  }

  /* ---- trust ---- */
  updateTrust(data, now);

  requestStore.set(clientKey, data);
  next();
}


setInterval(() => {
  const now = Date.now();

  for (const [k, v] of requestStore.entries()) {
    v.timestamps = v.timestamps.filter(
      t => now - t < CONFIG.WINDOW_MS
    );
    v.burst = v.burst.filter(
      t => now - t < CONFIG.BURST_WINDOW_MS
    );
    if (v.timestamps.length === 0) requestStore.delete(k);
  }

  for (const [k, v] of banStore.entries()) {
    if (v.expires < now) banStore.delete(k);
  }

  for (const [k, t] of replayStore.entries()) {
    if (now - t > CONFIG.TIMESTAMP_TOLERANCE) replayStore.delete(k);
  }
}, CONFIG.CLEANUP_INTERVAL);

module.exports = RateLimit;

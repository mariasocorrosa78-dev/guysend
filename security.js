// security.js
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-slow-down");
const mongoSanitize = require("express-mongo-sanitize");
const xss = require("xss-clean");

module.exports = function security(app) {

  // 🔒 Trust proxy (DISCloud / Render / Cloudflare)
  app.set("trust proxy", true);

  // 📦 Body limit (protege de payload gigante)
  app.use(express.json({ limit: "1mb" }));

  // 🛡️ Headers de segurança
  app.use(helmet({
    crossOriginResourcePolicy: false
  }));

  // 🧼 Anti NoSQL Injection
  app.use(mongoSanitize());

  // 🧽 Anti XSS
  app.use(xss());

  // 🐢 Slow Down (advanced rate limit)
  app.use(rateLimit({
    windowMs: 60 * 1000, // 1 minute
    delayAfter: 80,      // after 80 requests
    delayMs: () => 400,  // +400ms per extra request
    maxDelayMs: 5000    // locks in 5s
  }));

};

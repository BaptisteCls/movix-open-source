/**
 * CORS middleware configuration.
 * Extracted from server.js -- restricted origin policy.
 */

const cors = require("cors");

const corsMiddleware = cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      "movix.blog",
      "movix.rodeo",
      "movix.club",
      "movix.site",
      "movix11.pages.dev",
      "nakios.site",
      "cinezo.site",
      "filmib.cc"
    ];

    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow all localhost requests (http and https)
    if (origin.match(/^https?:\/\/localhost(:[0-9]+)?$/)) {
      return callback(null, true);
    }

    // Check if origin matches allowed domains (allows http, https, and subdomains)
    const isAllowed = allowedDomains.some((domain) => {
      // Allow exact match (http/s) or subdomain
      return (
        origin === `https://${domain}` ||
        origin === `http://${domain}` ||
        origin.endsWith(`.${domain}`)
      );
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE", "PATCH", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-No-Compression",
    "Access-Control-Request-Headers",
    "baggage",
    "sentry-trace",
    "x-profile-id",
    "x-access-key",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
});

module.exports = corsMiddleware;

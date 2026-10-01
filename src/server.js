require("dotenv/config");
const express = require("express");
const cors = require("cors");
const { connectDB } = require("./db");

const authRoutes = require("./routes/auth");
const churchRoutes = require("./routes/churches");
const memberRoutes = require("./routes/members");
const childRoutes = require("./routes/children");
const serviceRoutes = require("./routes/services");
const attendanceRoutes = require("./routes/attendance");
const venueRoutes = require("./routes/venue");
const analyticsRoutes = require("./routes/analytics");
const platformRoutes = require("./routes/platform");
const titheRoutes = require("./routes/tithes");
const assetRoutes = require("./routes/assets");
const levyRoutes = require("./routes/levies");
const visitorRoutes = require("./routes/visitors");

const app = express();

// Comma-separated list of allowed frontend origins, e.g.
// FRONTEND_URL=https://your-church.netlify.app,http://localhost:3000
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow no-origin requests (curl, server-to-server, health checks).
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);
// Default (100kb) is too small for a bulk member-import batch (a few
// hundred rows of profile fields easily exceeds it) — 2mb comfortably fits
// the largest batch the frontend sends per request while still bounding
// how much any single request can make the server parse.
app.use(express.json({ limit: "2mb" }));

// `features` is a small, deliberately manual checklist — not auto-derived
// from anything — of behavior changes that are otherwise invisible from
// outside the server (a client can't tell "old venue-verify contract" from
// "new one" except by trying it and seeing which fields it wants). Visiting
// this in a browser or `curl`ing it after a deploy is the fast way to
// confirm Render is actually running the code you just pushed, without
// needing to exercise the full check-in flow to find out.
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    features: [
      "multi-tenant",
      "venue-phone-checkin",
      "service-analytics",
      "service-demographics",
      "admin-only-qr-checkin",
      "admin-checkin-no-gps-required",
      "service-present-absent-roster",
      "service-roster-named-lists",
      "platform-admin-dashboard",
      "password-reset",
      "church-contact-phone",
      "email-verification-before-signin",
      "member-tithes",
      "church-asset-inventory",
      "named-levies-with-progress",
      "visitor-directory-and-conversion",
    ],
  })
);

app.use("/api/auth", authRoutes);
app.use("/api", churchRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/children", childRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api", attendanceRoutes);
app.use("/api", venueRoutes);
// Exclusive prefix — analyticsRoutes owns "/api/analytics" and nothing else,
// so its router.use(requireAuth) can never accidentally gate a route from
// another router the way it would on a shared prefix like "/api".
app.use("/api/analytics", analyticsRoutes);
// Exclusive prefix, same reasoning as analyticsRoutes above — platformRoutes
// owns "/api/platform" and nothing else, so its own router.use(requireAuth,
// requirePlatformAdmin) can never accidentally gate an unrelated route.
app.use("/api/platform", platformRoutes);
app.use("/api/tithes", titheRoutes);
app.use("/api/assets", assetRoutes);
app.use("/api/levies", levyRoutes);
app.use("/api/visitors", visitorRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Centralized error handler — catches anything thrown/rejected in a route
// (Express 5 forwards rejected async handlers here automatically).
app.use((err, req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Not allowed by CORS." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Linkpii Church Management API listening on :${PORT}`));
});

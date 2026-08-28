const express = require("express");
const QRCode = require("qrcode");
const Church = require("../models/Church");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// NOTE: requireAuth is applied directly on the route below, not via
// `router.use(requireAuth)` — this router is mounted at the broad, shared
// "/api" prefix, and a router-wide `use()` would risk swallowing any other
// public "/api/*" route registered after it with a 401 (see the identical
// issue that had to be fixed in churches.js).

// GET /api/venue-qrcode — the single, permanent poster QR code this
// church's members scan on-site to self-check-in via /venue/<slug> on the
// frontend. Admin-only to fetch (so it isn't trivially re-discoverable by
// the public), even though the check-in page it links to is itself public.
// The slug in the URL is what scopes the whole self-check-in flow to this
// one church — printing another church's poster would point at their slug
// instead, and their member search/verify would never see this church's
// members.
router.get("/venue-qrcode", requireAuth, async (req, res) => {
  const church = await Church.findById(req.user.churchId).catch(() => null);
  if (!church) return res.status(404).json({ error: "Church not found." });

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  const checkInUrl = `${frontendUrl}/venue/${church.slug}`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { margin: 1, width: 400, color: { dark: "#1b1b2b" } });

  res.json({ dataUrl, checkInUrl });
});

module.exports = router;

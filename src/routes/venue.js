const express = require("express");
const QRCode = require("qrcode");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /api/venue-qrcode — the single, permanent poster QR code members scan
// on-site to self-check-in via /venue on the frontend. Admin-only to fetch
// (so it isn't trivially re-discoverable by the public), even though the
// check-in page it links to is itself public.
router.get("/venue-qrcode", async (req, res) => {
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  const checkInUrl = `${frontendUrl}/venue`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { margin: 1, width: 400, color: { dark: "#1b1b2b" } });

  res.json({ dataUrl, checkInUrl });
});

module.exports = router;

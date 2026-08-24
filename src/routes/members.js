const express = require("express");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const Member = require("../models/Member");
const Attendance = require("../models/Attendance");
const { requireAuth } = require("../middleware/auth");
const { newQrToken } = require("../lib/utils");

const router = express.Router();

const lookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { members: [] },
});

// GET /api/members/lookup?q=...  — PUBLIC, no auth.
// Powers the venue self-check-in page: lets a member find their own name
// after scanning the posted QR code. Deliberately returns ONLY id + name —
// never phone — because the phone number is the identity-confirmation
// secret on the next step, so it must never be visible in a public
// response (that would defeat the whole point of asking for it).
router.get("/lookup", lookupLimiter, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ members: [] });

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const members = await Member.find({ active: true, name: re }).limit(8).select("name");

  res.json({ members: members.map((m) => ({ id: m.id, name: m.name })) });
});

router.use(requireAuth);

function serialize(m) {
  return {
    id: m.id,
    name: m.name,
    phone: m.phone,
    email: m.email,
    qrToken: m.qrToken,
    active: m.active,
    createdAt: m.createdAt,
  };
}

// GET /api/members?active=true|false
router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.active === "true") filter.active = true;
  if (req.query.active === "false") filter.active = false;
  const members = await Member.find(filter).sort({ name: 1 });
  res.json({ members: members.map(serialize) });
});

// GET /api/members/search?q=...
// (Registered before /:id so "search" isn't swallowed by the :id param.)
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ members: [] });

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const members = await Member.find({
    active: true,
    $or: [{ name: re }, { phone: re }],
  }).limit(10);

  res.json({ members: members.map(serialize) });
});

router.get("/:id", async (req, res) => {
  const member = await Member.findById(req.params.id).catch(() => null);
  if (!member) return res.status(404).json({ error: "Member not found." });
  res.json({ member: serialize(member) });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim();

  if (!name) return res.status(400).json({ error: "Name is required." });

  const member = await Member.create({
    name,
    phone: phone || null,
    email: email || null,
    qrToken: newQrToken(),
  });

  res.status(201).json({ member: serialize(member) });
});

router.patch("/:id", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });

  const member = await Member.findByIdAndUpdate(
    req.params.id,
    { name, phone: phone || null, email: email || null },
    { new: true }
  ).catch(() => null);
  if (!member) return res.status(404).json({ error: "Member not found." });

  res.json({ member: serialize(member) });
});

router.post("/:id/deactivate", async (req, res) => {
  const member = await Member.findByIdAndUpdate(req.params.id, { active: false }, { new: true }).catch(() => null);
  if (!member) return res.status(404).json({ error: "Member not found." });
  res.json({ member: serialize(member) });
});

router.post("/:id/reactivate", async (req, res) => {
  const member = await Member.findByIdAndUpdate(req.params.id, { active: true }, { new: true }).catch(() => null);
  if (!member) return res.status(404).json({ error: "Member not found." });
  res.json({ member: serialize(member) });
});

router.post("/:id/regenerate-qr", async (req, res) => {
  const member = await Member.findByIdAndUpdate(
    req.params.id,
    { qrToken: newQrToken() },
    { new: true }
  ).catch(() => null);
  if (!member) return res.status(404).json({ error: "Member not found." });
  res.json({ member: serialize(member) });
});

// GET /api/members/:id/qrcode — a ready-to-display/download PNG data URL
// encoding this member's check-in link (the frontend's /c/[token] page).
router.get("/:id/qrcode", async (req, res) => {
  const member = await Member.findById(req.params.id).catch(() => null);
  if (!member) return res.status(404).json({ error: "Member not found." });

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  const checkInUrl = `${frontendUrl}/c/${member.qrToken}`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { margin: 1, width: 320, color: { dark: "#1b1b2b" } });

  res.json({ dataUrl, checkInUrl });
});

// GET /api/members/:id/attendance — this member's check-in history.
router.get("/:id/attendance", async (req, res) => {
  const rows = await Attendance.find({ memberId: req.params.id })
    .sort({ checkedInAt: -1 })
    .limit(20)
    .populate("serviceId", "name date");

  res.json({
    history: rows.map((a) => ({
      id: a.id,
      checkedInAt: a.checkedInAt,
      method: a.method,
      serviceName: a.serviceId && typeof a.serviceId === "object" ? a.serviceId.name : "Unknown service",
      serviceDate: a.serviceId && typeof a.serviceId === "object" ? a.serviceId.date : null,
    })),
  });
});

module.exports = router;

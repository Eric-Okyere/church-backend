const express = require("express");
const QRCode = require("qrcode");
const Child = require("../models/Child");
const Attendance = require("../models/Attendance");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function serialize(c) {
  return { id: c.id, name: c.name, parentMemberId: c.parentMemberId, active: c.active, createdAt: c.createdAt };
}

// GET /api/children/search?q=...
// Admin-only — powers the "check someone in manually" search on the
// dashboard/kiosk so an usher can find a child the same way they find a
// member, without the child needing their own login or phone number.
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ children: [] });

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const children = await Child.find({ active: true, name: re }).limit(10).populate("parentMemberId", "name");

  res.json({
    children: children.map((c) => ({
      id: c.id,
      name: c.name,
      parentName:
        c.parentMemberId && typeof c.parentMemberId === "object" ? c.parentMemberId.name : null,
    })),
  });
});

router.patch("/:id", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });

  const child = await Child.findByIdAndUpdate(req.params.id, { name }, { new: true }).catch(() => null);
  if (!child) return res.status(404).json({ error: "Child not found." });
  res.json({ child: serialize(child) });
});

router.post("/:id/deactivate", async (req, res) => {
  const child = await Child.findByIdAndUpdate(req.params.id, { active: false }, { new: true }).catch(() => null);
  if (!child) return res.status(404).json({ error: "Child not found." });
  res.json({ child: serialize(child) });
});

router.post("/:id/reactivate", async (req, res) => {
  const child = await Child.findByIdAndUpdate(req.params.id, { active: true }, { new: true }).catch(() => null);
  if (!child) return res.status(404).json({ error: "Child not found." });
  res.json({ child: serialize(child) });
});

// GET /api/children/:id/qrcode — same idea as a member's, but for a child.
router.get("/:id/qrcode", async (req, res) => {
  const child = await Child.findById(req.params.id).catch(() => null);
  if (!child) return res.status(404).json({ error: "Child not found." });

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  const checkInUrl = `${frontendUrl}/c/${child.qrToken}`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { margin: 1, width: 320, color: { dark: "#1b1b2b" } });

  res.json({ dataUrl, checkInUrl });
});

// GET /api/children/:id/attendance — this child's check-in history.
router.get("/:id/attendance", async (req, res) => {
  const rows = await Attendance.find({ childId: req.params.id })
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

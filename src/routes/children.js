const express = require("express");
const QRCode = require("qrcode");
const Child = require("../models/Child");
const Attendance = require("../models/Attendance");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// Same enums/validator members.js uses for a Member's own gender/department.
const GENDERS = ["Male", "Female"];
const DEPARTMENTS = ["Youth", "Children", "Men", "Leader", "Women"];

function pickEnum(value, allowed, label, errors) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of: ${allowed.join(", ")}.`);
    return null;
  }
  return value;
}

function serialize(c) {
  return {
    id: c.id,
    name: c.name,
    parentMemberId: c.parentMemberId,
    parentName: c.parentName,
    parentPhone: c.parentPhone,
    gender: c.gender,
    department: c.department,
    active: c.active,
    createdAt: c.createdAt,
  };
}

// Fetches a child by id, but ONLY if it belongs to the caller's church —
// same "not found and not-yours look identical" pattern as members.js, so
// no route here can be used to probe another church's data.
async function findOwnChild(id, churchId) {
  const child = await Child.findById(id).catch(() => null);
  if (!child || String(child.churchId) !== String(churchId)) return null;
  return child;
}

// GET /api/children?active=true|false
// Every child registered at this church, across every parent — powers the
// Members page surfacing children alongside members (clearly marked, not
// merged into the member list server-side). Populates the parent as a
// fallback for a child that pre-dates the parentName/parentPhone snapshot,
// same pattern as /search below.
router.get("/", async (req, res) => {
  const filter = { churchId: req.user.churchId };
  if (req.query.active === "true") filter.active = true;
  if (req.query.active === "false") filter.active = false;

  const children = await Child.find(filter).sort({ name: 1 }).populate("parentMemberId", "name phone");

  res.json({
    children: children.map((c) => {
      const parent = c.parentMemberId && typeof c.parentMemberId === "object" ? c.parentMemberId : null;
      return {
        id: c.id,
        name: c.name,
        parentMemberId: parent ? parent.id : c.parentMemberId,
        parentName: c.parentName || parent?.name || null,
        parentPhone: c.parentPhone || parent?.phone || null,
        gender: c.gender,
        department: c.department,
        active: c.active,
        createdAt: c.createdAt,
      };
    }),
  });
});

// GET /api/children/search?q=...
// Admin-only — powers the "check someone in manually" search on the
// dashboard/kiosk so an usher can find a child the same way they find a
// member, without the child needing their own login or phone number.
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ children: [] });

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const children = await Child.find({ churchId: req.user.churchId, active: true, name: re })
    .limit(10)
    .populate("parentMemberId", "name");

  res.json({
    children: children.map((c) => ({
      id: c.id,
      name: c.name,
      // Prefer the name snapshotted on the child at creation time; fall
      // back to the populated parent for children created before that
      // field existed.
      parentName:
        c.parentName ||
        (c.parentMemberId && typeof c.parentMemberId === "object" ? c.parentMemberId.name : null),
    })),
  });
});

router.patch("/:id", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });

  const owned = await findOwnChild(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Child not found." });

  // gender/department only change if the caller actually sent them — an
  // omitted field leaves the existing value alone rather than clearing it,
  // unlike an explicit empty string, which does clear it (same convention
  // readOptionalFields uses for a Member in members.js).
  const errors = [];
  const update = { name };
  if (req.body?.gender !== undefined) update.gender = pickEnum(req.body.gender, GENDERS, "Gender", errors);
  if (req.body?.department !== undefined) update.department = pickEnum(req.body.department, DEPARTMENTS, "Department", errors);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const child = await Child.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({ child: serialize(child) });
});

router.post("/:id/deactivate", async (req, res) => {
  const owned = await findOwnChild(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Child not found." });
  const child = await Child.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  res.json({ child: serialize(child) });
});

router.post("/:id/reactivate", async (req, res) => {
  const owned = await findOwnChild(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Child not found." });
  const child = await Child.findByIdAndUpdate(req.params.id, { active: true }, { new: true });
  res.json({ child: serialize(child) });
});

// GET /api/children/:id/qrcode — same idea as a member's, but for a child.
router.get("/:id/qrcode", async (req, res) => {
  const child = await findOwnChild(req.params.id, req.user.churchId);
  if (!child) return res.status(404).json({ error: "Child not found." });

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  const checkInUrl = `${frontendUrl}/c/${child.qrToken}`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { margin: 1, width: 320, color: { dark: "#1b1b2b" } });

  res.json({ dataUrl, checkInUrl });
});

// GET /api/children/:id/attendance — this child's check-in history.
router.get("/:id/attendance", async (req, res) => {
  const owned = await findOwnChild(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Child not found." });

  const rows = await Attendance.find({ childId: req.params.id, churchId: req.user.churchId })
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

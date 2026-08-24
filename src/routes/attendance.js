const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const Member = require("../models/Member");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const { requireAuth } = require("../middleware/auth");
const {
  checkInByToken,
  checkInPersonManually,
  checkInVisitor,
  verifyVenueMember,
  checkInSelfAtVenue,
  checkInChildAtVenue,
} = require("../lib/attendance");

const router = express.Router();

// --- Public: the page a member's (or child's) QR code opens (no auth) ----
// POST /api/attendance/checkin  { token }
router.post("/attendance/checkin", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const result = await checkInByToken(token);
  res.json(result);
});

// --- Public: the venue self-check-in flow a posted QR code opens ---------
// A tighter limit than most public endpoints here — venue-verify is the one
// that takes a phone number and checks it against a specific member record,
// so it's the one worth throttling against someone trying to guess a phone
// number to falsely check another member in.
const venueLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, reason: "rate_limited" },
});

// POST /api/attendance/venue-verify  { memberId, phone, lat, lng }
// Verifies location + phone-number identity, and on success returns a
// short-lived venue token plus the member's own registered children. This
// is the ONLY step that checks a phone number — everything after it is
// scoped to the member this token was issued for.
router.post("/attendance/venue-verify", venueLimiter, async (req, res) => {
  const memberId = String(req.body?.memberId || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);

  if (!memberId || !phone) return res.status(400).json({ ok: false, reason: "invalid_request" });
  if (!mongoose.isValidObjectId(memberId)) return res.json({ ok: false, reason: "invalid_member" });

  const result = await verifyVenueMember(memberId, phone, lat, lng);
  res.json(result);
});

// POST /api/attendance/venue-checkin-self  { venueToken, lat, lng }
// Checks in ONLY the member the venueToken was issued to — there is no
// memberId in this request body, deliberately, so there's nothing for a
// tampered request to even point at someone else.
router.post("/attendance/venue-checkin-self", venueLimiter, async (req, res) => {
  const venueToken = String(req.body?.venueToken || "").trim();
  if (!venueToken) return res.status(400).json({ ok: false, reason: "invalid_request" });
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const result = await checkInSelfAtVenue(venueToken, lat, lng);
  res.json(result);
});

// POST /api/attendance/venue-checkin-child  { venueToken, childId, lat, lng }
// Checks in a child ONLY if that child's parentMemberId matches the member
// the venueToken was issued to — enforced in checkInChildAtVenue, not here.
router.post("/attendance/venue-checkin-child", venueLimiter, async (req, res) => {
  const venueToken = String(req.body?.venueToken || "").trim();
  const childId = String(req.body?.childId || "").trim();
  if (!venueToken || !childId) return res.status(400).json({ ok: false, reason: "invalid_request" });
  if (!mongoose.isValidObjectId(childId)) return res.json({ ok: false, reason: "invalid_member" });

  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const result = await checkInChildAtVenue(venueToken, childId, lat, lng);
  res.json(result);
});

// --- Everything below requires an usher/admin session --------------------
// Only an authenticated admin/usher can check in someone other than
// themselves — the manual/scan paths below have no restriction on whose
// attendance they record, which is exactly what "only admin can check in
// more than one member" means in practice: it's gated by requireAuth, not
// by any per-person check.
router.use(requireAuth);

// POST /api/attendance/scan  { token }  — used by the kiosk camera scanner.
// Accepts either a bare token or the full https://.../c/<token> URL a QR
// code actually encodes. Works for both member and child QR codes.
router.post("/attendance/scan", async (req, res) => {
  const raw = String(req.body?.token || "").trim();
  if (!raw) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const token = raw.includes("/c/") ? raw.split("/c/").pop().split(/[?#]/)[0] : raw;
  const result = await checkInByToken(token);
  res.json(result);
});

// POST /api/attendance/manual  { memberId | childId, serviceId }
router.post("/attendance/manual", async (req, res) => {
  const { memberId, childId, serviceId } = req.body || {};
  if ((!memberId && !childId) || !serviceId) {
    return res.status(400).json({ ok: false, reason: "invalid_token" });
  }
  const result = await checkInPersonManually({ memberId, childId, serviceId });
  res.json(result);
});

// POST /api/attendance/visitor  { serviceId, name, phone }
router.post("/attendance/visitor", async (req, res) => {
  const { serviceId, phone } = req.body || {};
  const name = String(req.body?.name || "").trim();
  if (!serviceId || !name) {
    return res.status(400).json({ error: "Visitor name is required." });
  }
  await checkInVisitor(serviceId, name, phone || "");
  res.status(201).json({ success: true });
});

async function loadAttendanceRows(serviceId) {
  return Attendance.find({ serviceId })
    .sort({ checkedInAt: -1 })
    .populate("memberId", "name phone")
    .populate("childId", "name");
}

function rowToRecord(a) {
  const member = a.memberId && typeof a.memberId === "object" ? a.memberId : null;
  const child = a.childId && typeof a.childId === "object" ? a.childId : null;
  return {
    id: a.id,
    name: member?.name ?? child?.name ?? a.visitorName ?? "Unknown",
    phone: member?.phone ?? null,
    isChild: !!child,
    method: a.method,
    checkedInAt: a.checkedInAt,
  };
}

// GET /api/services/:id/attendance
router.get("/services/:id/attendance", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ error: "Service not found." });
  }
  const service = await Service.findById(req.params.id);
  const rows = await loadAttendanceRows(req.params.id);
  res.json({
    service: service ? { id: service.id, name: service.name, date: service.date, status: service.status } : null,
    count: rows.length,
    attendance: rows.map(rowToRecord),
  });
});

// GET /api/services/:id/attendance/csv
router.get("/services/:id/attendance/csv", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ error: "Service not found." });
  }
  const service = await Service.findById(req.params.id);
  const rows = await loadAttendanceRows(req.params.id);

  const header = "Name,Phone,Child,Method,Checked In At\n";
  const body = rows
    .map((a) => {
      const r = rowToRecord(a);
      return [r.name, r.phone ?? "", r.isChild ? "yes" : "no", r.method, new Date(r.checkedInAt).toISOString()]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",");
    })
    .join("\n");

  const filename = `${(service?.name ?? "service").replace(/[^a-z0-9]+/gi, "_")}_attendance.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(header + body);
});

// GET /api/dashboard — everything the admin dashboard page needs in one call.
router.get("/dashboard", async (req, res) => {
  const activeService = await Service.findOne({ status: "active" });
  const activeCount = activeService ? await Attendance.countDocuments({ serviceId: activeService.id }) : 0;
  const memberCount = await Member.countDocuments({ active: true });
  const recentServices = await Service.find().sort({ createdAt: -1 }).limit(6);

  const counts = await Attendance.aggregate([
    { $group: { _id: "$serviceId", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  res.json({
    activeService: activeService
      ? { id: activeService.id, name: activeService.name, date: activeService.date, status: activeService.status }
      : null,
    activeCount,
    memberCount,
    recentServices: recentServices.map((s) => ({
      id: s.id,
      name: s.name,
      date: s.date,
      status: s.status,
      count: countMap.get(String(s.id)) ?? 0,
    })),
  });
});

module.exports = router;

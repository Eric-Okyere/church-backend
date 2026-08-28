const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const Member = require("../models/Member");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const Church = require("../models/Church");
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
// No churchId to scope by here — the token itself is the credential, and
// checkInByToken derives which church it belongs to from whatever record
// it resolves to.
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

// POST /api/attendance/venue-verify  { slug, phone, lat, lng }
// Verifies location + looks the member up directly by phone number within
// that one church — no separate "search your name" step. This is the ONLY
// step that touches a phone number — everything after it is scoped to the
// member this token was issued for. `slug` (from the /venue/<slug> link,
// never a churchId asserted directly by the client) is how the church is
// resolved — verifyVenueMember never trusts a client-supplied churchId.
router.post("/attendance/venue-verify", venueLimiter, async (req, res) => {
  const slug = String(req.body?.slug || "")
    .trim()
    .toLowerCase();
  const phone = String(req.body?.phone || "").trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);

  if (!slug || !phone) return res.status(400).json({ ok: false, reason: "invalid_request" });

  const church = await Church.findOne({ slug, active: true }).catch(() => null);
  if (!church) return res.json({ ok: false, reason: "unknown_church" });

  const result = await verifyVenueMember(church.id, phone, lat, lng);
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
// by any per-person check. Every route below is additionally scoped to
// req.user.churchId, so an admin/usher can only ever act on their own
// church's members, children, and services.
router.use(requireAuth);

// POST /api/attendance/scan  { token }  — used by the kiosk camera scanner.
// Accepts either a bare token or the full https://.../c/<token> URL a QR
// code actually encodes. Works for both member and child QR codes.
// Restricted to the scanning admin/usher's own church — scanning a QR code
// that happens to belong to a different church's member/child resolves as
// invalid_token, not a cross-tenant check-in.
router.post("/attendance/scan", async (req, res) => {
  const raw = String(req.body?.token || "").trim();
  if (!raw) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const token = raw.includes("/c/") ? raw.split("/c/").pop().split(/[?#]/)[0] : raw;
  const result = await checkInByToken(token, req.user.churchId);
  res.json(result);
});

// POST /api/attendance/manual  { memberId | childId, serviceId }
router.post("/attendance/manual", async (req, res) => {
  const { memberId, childId, serviceId } = req.body || {};
  if ((!memberId && !childId) || !serviceId) {
    return res.status(400).json({ ok: false, reason: "invalid_token" });
  }
  const result = await checkInPersonManually({ memberId, childId, serviceId }, req.user.churchId);
  res.json(result);
});

// POST /api/attendance/visitor  { serviceId, name, phone }
router.post("/attendance/visitor", async (req, res) => {
  const { serviceId, phone } = req.body || {};
  const name = String(req.body?.name || "").trim();
  if (!serviceId || !name) {
    return res.status(400).json({ error: "Visitor name is required." });
  }
  try {
    await checkInVisitor(serviceId, name, phone || "", req.user.churchId);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: "Service not found." });
    throw err;
  }
  res.status(201).json({ success: true });
});

async function loadAttendanceRows(serviceId, churchId) {
  return Attendance.find({ serviceId, churchId })
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

// Fetches a service by id, but ONLY if it belongs to the caller's church.
async function findOwnService(id, churchId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const service = await Service.findById(id).catch(() => null);
  if (!service || String(service.churchId) !== String(churchId)) return null;
  return service;
}

// GET /api/services/:id/attendance
router.get("/services/:id/attendance", async (req, res) => {
  const service = await findOwnService(req.params.id, req.user.churchId);
  if (!service) return res.status(404).json({ error: "Service not found." });
  const rows = await loadAttendanceRows(req.params.id, req.user.churchId);
  res.json({
    service: { id: service.id, name: service.name, date: service.date, status: service.status },
    count: rows.length,
    attendance: rows.map(rowToRecord),
  });
});

// GET /api/services/:id/attendance/csv
router.get("/services/:id/attendance/csv", async (req, res) => {
  const service = await findOwnService(req.params.id, req.user.churchId);
  if (!service) return res.status(404).json({ error: "Service not found." });
  const rows = await loadAttendanceRows(req.params.id, req.user.churchId);

  const header = "Name,Phone,Child,Method,Checked In At\n";
  const body = rows
    .map((a) => {
      const r = rowToRecord(a);
      return [r.name, r.phone ?? "", r.isChild ? "yes" : "no", r.method, new Date(r.checkedInAt).toISOString()]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",");
    })
    .join("\n");

  const filename = `${service.name.replace(/[^a-z0-9]+/gi, "_")}_attendance.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(header + body);
});

// GET /api/dashboard — everything the admin dashboard page needs in one
// call, all scoped to req.user.churchId — one church's dashboard never
// includes another church's services, members, or counts.
router.get("/dashboard", async (req, res) => {
  const churchId = req.user.churchId;
  const activeService = await Service.findOne({ status: "active", churchId });
  const activeCount = activeService ? await Attendance.countDocuments({ serviceId: activeService.id, churchId }) : 0;
  const memberCount = await Member.countDocuments({ active: true, churchId });
  const recentServices = await Service.find({ churchId }).sort({ createdAt: -1 }).limit(6);

  const counts = await Attendance.aggregate([
    { $match: { churchId } },
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

const express = require("express");
const mongoose = require("mongoose");
const Member = require("../models/Member");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const { requireAuth } = require("../middleware/auth");
const { checkInByToken, checkInMemberManually, checkInVisitor } = require("../lib/attendance");

const router = express.Router();

// --- Public: the page a member's QR code opens (no auth) -----------------
// POST /api/attendance/checkin  { token }
router.post("/attendance/checkin", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const result = await checkInByToken(token);
  res.json(result);
});

// --- Everything below requires an usher/admin session --------------------
router.use(requireAuth);

// POST /api/attendance/scan  { token }  — used by the kiosk camera scanner.
// Accepts either a bare token or the full https://.../c/<token> URL a QR
// code actually encodes.
router.post("/attendance/scan", async (req, res) => {
  const raw = String(req.body?.token || "").trim();
  if (!raw) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const token = raw.includes("/c/") ? raw.split("/c/").pop().split(/[?#]/)[0] : raw;
  const result = await checkInByToken(token);
  res.json(result);
});

// POST /api/attendance/manual  { memberId, serviceId }
router.post("/attendance/manual", async (req, res) => {
  const { memberId, serviceId } = req.body || {};
  if (!memberId || !serviceId) {
    return res.status(400).json({ ok: false, reason: "invalid_token" });
  }
  const result = await checkInMemberManually(memberId, serviceId);
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
    .populate("memberId", "name phone");
}

function rowToRecord(a) {
  const member = a.memberId && typeof a.memberId === "object" ? a.memberId : null;
  return {
    id: a.id,
    name: member?.name ?? a.visitorName ?? "Unknown",
    phone: member?.phone ?? a.visitorPhone ?? null,
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

  const header = "Name,Phone,Method,Checked In At\n";
  const body = rows
    .map((a) => {
      const r = rowToRecord(a);
      return [r.name, r.phone ?? "", r.method, new Date(r.checkedInAt).toISOString()]
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

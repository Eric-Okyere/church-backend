const express = require("express");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const Member = require("../models/Member");
const { requireAuth } = require("../middleware/auth");

// Mounted at its own exclusive prefix in server.js (app.use("/api/analytics",
// analyticsRoutes)) — see the router-mounting note there for why an
// exclusive prefix matters before adding router.use(requireAuth) to a
// router that only ever owns that one prefix.
const router = express.Router();

router.use(requireAuth);

// GET /api/analytics/services — everything the admin-facing Service
// Analytics page needs in one call. Every query below is scoped to
// req.user.churchId, the same way /api/dashboard is — one church's
// analytics never includes another church's services or attendance.
router.get("/services", async (req, res) => {
  const churchId = req.user.churchId;

  // Most recent 12 services (oldest -> newest) so a per-service chart reads
  // left-to-right as a timeline, same convention as the dashboard's
  // recentServices list.
  const recent = await Service.find({ churchId }).sort({ createdAt: -1 }).limit(12);
  const services = [...recent].reverse();

  const counts = await Attendance.aggregate([
    { $match: { churchId } },
    { $group: { _id: "$serviceId", count: { $sum: 1 } } },
  ]);
  const countByService = new Map(counts.map((c) => [String(c._id), c.count]));

  const perService = services.map((s) => ({
    id: s.id,
    name: s.name,
    date: s.date,
    status: s.status,
    count: countByService.get(String(s.id)) ?? 0,
  }));

  const methodCounts = await Attendance.aggregate([
    { $match: { churchId } },
    { $group: { _id: "$method", count: { $sum: 1 } } },
  ]);
  const countByMethod = new Map(methodCounts.map((m) => [m._id, m.count]));
  // Fixed order (never re-sorted by count) so a series' color/position
  // never shifts as the underlying numbers change week to week.
  const methodBreakdown = [
    { method: "qr", label: "QR scan", count: countByMethod.get("qr") ?? 0 },
    { method: "manual", label: "Manual", count: countByMethod.get("manual") ?? 0 },
    { method: "venue", label: "Self check-in", count: countByMethod.get("venue") ?? 0 },
    { method: "visitor", label: "Visitor", count: countByMethod.get("visitor") ?? 0 },
  ];

  const totalCheckIns = methodBreakdown.reduce((sum, m) => sum + m.count, 0);
  const servicesCount = await Service.countDocuments({ churchId });
  const activeMembers = await Member.countDocuments({ churchId, active: true });
  // Average is over services that have actually happened (skip
  // still-"scheduled" ones with no attendance yet, so they don't drag the
  // average down to zero before they've even run).
  const startedServices = perService.filter((s) => s.status !== "scheduled");
  const avgAttendance = startedServices.length
    ? Math.round(startedServices.reduce((sum, s) => sum + s.count, 0) / startedServices.length)
    : 0;

  res.json({
    totals: { servicesCount, totalCheckIns, avgAttendance, activeMembers },
    perService,
    methodBreakdown,
  });
});

module.exports = router;

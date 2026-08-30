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
  checkInVisitorAtVenue,
  verifyVenueMember,
  checkInSelfAtVenue,
  checkInChildAtVenue,
  verifyAdminAtChurch,
} = require("../lib/attendance");

const router = express.Router();

// --- Admin/usher on-premises guard ---------------------------------------
// Shared by every admin/usher action below that records someone's
// attendance — requires the signed-in admin/usher's OWN device GPS
// (`lat`/`lng` in the request body) to be within their church's configured
// premises radius, the same coordinates a church already sets on its
// Settings page for venue self-check-in. See `verifyAdminAtChurch` in
// `lib/attendance.js` for exactly what "configured" vs. "unenforced" means.
// Writes the response and returns false on failure; callers just `return`.
async function ensureAdminOnPremises(req, res) {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const check = await verifyAdminAtChurch(req.user.churchId, lat, lng);
  if (!check.ok) {
    res.status(403).json({ ok: false, reason: check.reason });
    return false;
  }
  return true;
}

// --- Admin/usher only: the page a member's (or child's) personal QR code
// opens ---------------------------------------------------------------
// POST /api/attendance/checkin  { token, lat, lng }
// A member's/child's printed or displayed QR code encodes a plain link to
// this page — which means anyone's phone camera app (not just the in-app
// kiosk scanner) can open it. requireAuth here is what stops that: only a
// signed-in admin/usher session can actually check someone in this way.
// Everyone else gets a 401, which the frontend shows as "see an usher"
// rather than silently checking the person in. Scoped to the caller's own
// church, same as the in-app kiosk scanner (`/attendance/scan` below) —
// an admin can never check in another church's member this way either.
// `ensureAdminOnPremises` additionally requires that signed-in admin's own
// device to actually be at the church (once the church has GPS configured).
router.post("/attendance/checkin", requireAuth, async (req, res) => {
  if (!(await ensureAdminOnPremises(req, res))) return;
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const result = await checkInByToken(token, req.user.churchId, { id: req.user.id, name: req.user.name });
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

// POST /api/attendance/venue-checkin-visitor  { slug, name, phone, lat, lng }
// For someone who scans the posted QR code but isn't a registered member yet
// (venue-verify above would have returned not_found for their phone number).
// No venueToken/session here — there's no existing identity to scope one to,
// just the same on-site geofence check as everyone else, then a free-text
// name (required) and phone (optional). Recorded as a visitor attendance row
// so an usher can follow up and, if the person is interested, add them to
// the member list themselves. Same rate limiter as the other venue routes.
router.post("/attendance/venue-checkin-visitor", venueLimiter, async (req, res) => {
  const slug = String(req.body?.slug || "")
    .trim()
    .toLowerCase();
  const name = String(req.body?.name || "").trim();
  const phone = req.body?.phone ? String(req.body.phone).trim() : "";
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);

  if (!slug || !name) return res.status(400).json({ ok: false, reason: "invalid_request" });

  const church = await Church.findOne({ slug, active: true }).catch(() => null);
  if (!church) return res.json({ ok: false, reason: "unknown_church" });

  const result = await checkInVisitorAtVenue(church.id, name, phone, lat, lng);
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

// POST /api/attendance/scan  { token, lat, lng }  — used by the kiosk
// camera scanner. Accepts either a bare token or the full
// https://.../c/<token> URL a QR code actually encodes. Works for both
// member and child QR codes. Restricted to the scanning admin/usher's own
// church — scanning a QR code that happens to belong to a different
// church's member/child resolves as invalid_token, not a cross-tenant
// check-in. `ensureAdminOnPremises` requires the scanning device itself to
// be at the church (once the church has GPS configured).
router.post("/attendance/scan", async (req, res) => {
  if (!(await ensureAdminOnPremises(req, res))) return;
  const raw = String(req.body?.token || "").trim();
  if (!raw) return res.status(400).json({ ok: false, reason: "invalid_token" });
  const token = raw.includes("/c/") ? raw.split("/c/").pop().split(/[?#]/)[0] : raw;
  const result = await checkInByToken(token, req.user.churchId, { id: req.user.id, name: req.user.name });
  res.json(result);
});

// POST /api/attendance/manual  { memberId | childId, serviceId, lat, lng }
router.post("/attendance/manual", async (req, res) => {
  if (!(await ensureAdminOnPremises(req, res))) return;
  const { memberId, childId, serviceId } = req.body || {};
  if ((!memberId && !childId) || !serviceId) {
    return res.status(400).json({ ok: false, reason: "invalid_token" });
  }
  const result = await checkInPersonManually(
    { memberId, childId, serviceId },
    req.user.churchId,
    { id: req.user.id, name: req.user.name }
  );
  res.json(result);
});

// POST /api/attendance/visitor  { serviceId, name, phone, lat, lng }
router.post("/attendance/visitor", async (req, res) => {
  const { serviceId, phone } = req.body || {};
  const name = String(req.body?.name || "").trim();
  if (!serviceId || !name) {
    return res.status(400).json({ error: "Visitor name is required." });
  }
  const premises = await verifyAdminAtChurch(req.user.churchId, Number(req.body?.lat), Number(req.body?.lng));
  if (!premises.ok) {
    return res.status(403).json({
      error:
        premises.reason === "location_required"
          ? "Enable location access to check in a visitor."
          : "You must be at the church to check in a visitor.",
      reason: premises.reason,
    });
  }
  try {
    await checkInVisitor(serviceId, name, phone || "", req.user.churchId, { id: req.user.id, name: req.user.name });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: "Service not found." });
    throw err;
  }
  res.status(201).json({ success: true });
});

async function loadAttendanceRows(serviceId, churchId) {
  return Attendance.find({ serviceId, churchId })
    .sort({ checkedInAt: -1 })
    .populate("memberId", "name phone gender department")
    .populate("childId", "name");
}

const DEMOGRAPHIC_GENDERS = ["Male", "Female"];
const DEMOGRAPHIC_DEPARTMENTS = ["Youth", "Children", "Men", "Leader", "Women"];
// Same fixed order as the analytics page's check-in-method chart — never
// re-sorted by count, so a method keeps its color/position as numbers change.
const DEMOGRAPHIC_METHODS = [
  { method: "qr", label: "QR scan" },
  { method: "manual", label: "Manual" },
  { method: "venue", label: "Self check-in" },
  { method: "visitor", label: "Visitor" },
];

// Breaks a service's attendance rows down by who attended: total plus
// members/children/visitors, gender (members only — children and visitors
// have no gender on file), department (members only, from the same fixed
// list used on the member profile form), and check-in method. Only ever
// called with rows already scoped to one service + churchId by the caller.
function buildDemographics(rows) {
  let members = 0;
  let children = 0;
  let visitors = 0;
  const genderCounts = { Male: 0, Female: 0, "Not specified": 0 };
  const deptCounts = Object.fromEntries(DEMOGRAPHIC_DEPARTMENTS.map((d) => [d, 0]));
  deptCounts["No department"] = 0;
  const methodCounts = Object.fromEntries(DEMOGRAPHIC_METHODS.map((m) => [m.method, 0]));

  for (const a of rows) {
    const member = a.memberId && typeof a.memberId === "object" ? a.memberId : null;
    const child = a.childId && typeof a.childId === "object" ? a.childId : null;
    if (member) {
      members++;
      if (member.gender === "Male" || member.gender === "Female") genderCounts[member.gender]++;
      else genderCounts["Not specified"]++;
      if (DEMOGRAPHIC_DEPARTMENTS.includes(member.department)) deptCounts[member.department]++;
      else deptCounts["No department"]++;
    } else if (child) {
      children++;
    } else {
      visitors++;
    }
    if (methodCounts[a.method] !== undefined) methodCounts[a.method]++;
  }

  const gender = DEMOGRAPHIC_GENDERS.map((label) => ({ label, count: genderCounts[label] }));
  if (genderCounts["Not specified"] > 0) gender.push({ label: "Not specified", count: genderCounts["Not specified"] });

  const department = DEMOGRAPHIC_DEPARTMENTS.map((label) => ({ label, count: deptCounts[label] }));
  if (deptCounts["No department"] > 0) department.push({ label: "No department", count: deptCounts["No department"] });

  return {
    total: rows.length,
    members,
    children,
    visitors,
    gender,
    department,
    method: DEMOGRAPHIC_METHODS.map((m) => ({ label: m.label, count: methodCounts[m.method] })),
  };
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
    // Who actually performed this check-in on the person's behalf (kiosk
    // scan, manual search, adding a walk-in visitor) — null for every
    // self-service path (venue self/child/visitor check-in). See the
    // Attendance model for why this is denormalized rather than populated.
    checkedInByName: a.checkedInByName ?? null,
  };
}

// Fetches a service by id, but ONLY if it belongs to the caller's church.
async function findOwnService(id, churchId) {
  if (!mongoose.isValidObjectId(id)) return null;
  const service = await Service.findById(id).catch(() => null);
  if (!service || String(service.churchId) !== String(churchId)) return null;
  return service;
}

// "Present"/"absent" is scoped to the church's registered, active member
// roster — the group a person can meaningfully be marked absent FROM.
// Children and visitors have no such roster (a visitor was never expected
// to show up, and a child's attendance is tracked through their parent),
// so they show up separately (see `extractVisitors` below), not in this
// list. Named lists (not just counts) are what let an admin actually call
// or WhatsApp a specific absent member to check on them, and a present
// member to say thanks for coming — the counts-only version from the
// previous round didn't support that.
async function buildRoster(rows, churchId) {
  const checkInInfoByMemberId = new Map();
  for (const a of rows) {
    const member = a.memberId && typeof a.memberId === "object" ? a.memberId : null;
    if (member) {
      checkInInfoByMemberId.set(String(member._id), {
        checkedInAt: a.checkedInAt,
        checkedInByName: a.checkedInByName ?? null,
      });
    }
  }

  // Every active member on the church's roster, name-sorted so both lists
  // read predictably rather than shuffling on every poll.
  const allActiveMembers = await Member.find({ churchId, active: true })
    .select("name phone")
    .sort({ name: 1 });

  const presentMembers = [];
  const absentMembers = [];
  for (const m of allActiveMembers) {
    const info = checkInInfoByMemberId.get(String(m._id));
    const entry = { id: m.id, name: m.name, phone: m.phone ?? null };
    if (info) presentMembers.push({ ...entry, checkedInAt: info.checkedInAt, checkedInByName: info.checkedInByName });
    else absentMembers.push(entry);
  }

  return {
    totalActiveMembers: allActiveMembers.length,
    present: presentMembers.length,
    absent: absentMembers.length,
    presentMembers,
    absentMembers,
  };
}

// Visitors are already excluded from the member roster above (they were
// never expected on it) — this pulls them out as their own named list, so
// an admin can call/WhatsApp a visitor to follow up same as a member.
function extractVisitors(rows) {
  return rows
    .filter((a) => !(a.memberId && typeof a.memberId === "object") && !(a.childId && typeof a.childId === "object"))
    .map((a) => ({
      id: a.id,
      name: a.visitorName || "Unknown",
      phone: a.visitorPhone || null,
      checkedInAt: a.checkedInAt,
    }));
}

// GET /api/services/:id/attendance
router.get("/services/:id/attendance", async (req, res) => {
  const service = await findOwnService(req.params.id, req.user.churchId);
  if (!service) return res.status(404).json({ error: "Service not found." });
  const rows = await loadAttendanceRows(req.params.id, req.user.churchId);
  const demographics = buildDemographics(rows);
  const roster = await buildRoster(rows, req.user.churchId);
  const visitors = extractVisitors(rows);
  res.json({
    service: { id: service.id, name: service.name, date: service.date, status: service.status },
    count: rows.length,
    attendance: rows.map(rowToRecord),
    demographics,
    roster,
    visitors,
  });
});

// GET /api/services/:id/attendance/csv
router.get("/services/:id/attendance/csv", async (req, res) => {
  const service = await findOwnService(req.params.id, req.user.churchId);
  if (!service) return res.status(404).json({ error: "Service not found." });
  const rows = await loadAttendanceRows(req.params.id, req.user.churchId);
  const roster = await buildRoster(rows, req.user.churchId);

  const summary = `Present,${roster.present}\nAbsent,${roster.absent}\nActive members,${roster.totalActiveMembers}\n\n`;
  const header = "Name,Phone,Child,Method,Checked In At,Checked In By\n";
  const body = rows
    .map((a) => {
      const r = rowToRecord(a);
      return [
        r.name,
        r.phone ?? "",
        r.isChild ? "yes" : "no",
        r.method,
        new Date(r.checkedInAt).toISOString(),
        r.checkedInByName ?? "",
      ]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",");
    })
    .join("\n");

  const filename = `${service.name.replace(/[^a-z0-9]+/gi, "_")}_attendance.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(summary + header + body);
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

  // NOTE: unlike .find()/.countDocuments() above, .aggregate()'s $match does
  // NOT auto-cast a plain string against the schema's ObjectId type — req.user.churchId
  // is always a string (it comes straight off the JWT), so without this
  // explicit cast the $match below silently matches zero documents and every
  // service in the list shows "0 present" even when check-ins exist.
  const counts = await Attendance.aggregate([
    { $match: { churchId: new mongoose.Types.ObjectId(churchId) } },
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

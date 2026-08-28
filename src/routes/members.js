const express = require("express");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");
const Member = require("../models/Member");
const Child = require("../models/Child");
const Attendance = require("../models/Attendance");
const Church = require("../models/Church");
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

// GET /api/members/lookup?church=<slug>&q=...  — PUBLIC, no auth.
// Powers the venue self-check-in page: lets a member find their own name
// after scanning the posted QR code. Requires a church slug (the poster QR
// encodes /venue/<slug>, and the page passes it through here) so this can
// never search across every church on the platform — without it, a
// congregation of one church could type another church's member's name and
// find them. Deliberately returns ONLY id + name — never phone — because
// the phone number is the identity-confirmation secret on the next step.
router.get("/lookup", lookupLimiter, async (req, res) => {
  const churchSlug = String(req.query.church || "").trim().toLowerCase();
  const q = String(req.query.q || "").trim();
  if (!churchSlug || q.length < 2) return res.json({ members: [] });

  const church = await Church.findOne({ slug: churchSlug, active: true });
  if (!church) return res.json({ members: [] });

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const members = await Member.find({ churchId: church.id, active: true, name: re }).limit(8).select("name");

  res.json({ members: members.map((m) => ({ id: m.id, name: m.name })) });
});

router.use(requireAuth);

const MARITAL_STATUSES = ["single", "married", "divorced", "widowed", "separated"];
const JOB_STATUSES = ["employed", "unemployed", "self_employed", "student"];
const DEPARTMENTS = ["Youth", "Children", "Men", "Leader", "Women"];

// Every one of these fields is optional. If provided, it must be one of the
// allowed values (returns null) so obviously-wrong data doesn't get stored
// silently; if omitted entirely, it's just left null.
function pickEnum(value, allowed, label, errors) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of: ${allowed.join(", ")}.`);
    return null;
  }
  return value;
}

// Reads the optional-profile fields from a request body, validating enums.
// Returns [fields, errors] — caller checks errors.length before proceeding.
function readOptionalFields(body) {
  const errors = [];
  const fields = {
    maritalStatus: pickEnum(body?.maritalStatus, MARITAL_STATUSES, "Marital status", errors),
    jobStatus: pickEnum(body?.jobStatus, JOB_STATUSES, "Job status", errors),
    department: pickEnum(body?.department, DEPARTMENTS, "Department", errors),
    emergencyContactName: String(body?.emergencyContactName || "").trim() || null,
    emergencyContactPhone: String(body?.emergencyContactPhone || "").trim() || null,
    address: String(body?.address || "").trim() || null,
    numberOfChildren:
      body?.numberOfChildren === undefined || body?.numberOfChildren === null || body?.numberOfChildren === ""
        ? null
        : Number(body.numberOfChildren),
  };
  if (fields.numberOfChildren !== null && !Number.isFinite(fields.numberOfChildren)) {
    errors.push("Number of children must be a number.");
    fields.numberOfChildren = null;
  }
  return [fields, errors];
}

function serialize(m) {
  return {
    id: m.id,
    name: m.name,
    phone: m.phone,
    email: m.email,
    qrToken: m.qrToken,
    active: m.active,
    maritalStatus: m.maritalStatus,
    jobStatus: m.jobStatus,
    emergencyContactName: m.emergencyContactName,
    emergencyContactPhone: m.emergencyContactPhone,
    address: m.address,
    numberOfChildren: m.numberOfChildren,
    department: m.department,
    createdAt: m.createdAt,
  };
}

function serializeChild(c) {
  return { id: c.id, name: c.name, active: c.active, createdAt: c.createdAt };
}

// Fetches a member by id, but ONLY if it belongs to the caller's church —
// used everywhere a route takes a member id, so one church's admin can
// never read/edit/deactivate/rotate-QR another church's member just by
// guessing or reusing an id. Returns null for "not found" AND "found but
// someone else's" identically, so a cross-tenant probe can't even tell
// those two cases apart.
async function findOwnMember(id, churchId) {
  const member = await Member.findById(id).catch(() => null);
  if (!member || String(member.churchId) !== String(churchId)) return null;
  return member;
}

// GET /api/members?active=true|false
router.get("/", async (req, res) => {
  const filter = { churchId: req.user.churchId };
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
    churchId: req.user.churchId,
    active: true,
    $or: [{ name: re }, { phone: re }],
  }).limit(10);

  res.json({ members: members.map(serialize) });
});

router.get("/:id", async (req, res) => {
  const member = await findOwnMember(req.params.id, req.user.churchId);
  if (!member) return res.status(404).json({ error: "Member not found." });
  res.json({ member: serialize(member) });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim();

  if (!name) return res.status(400).json({ error: "Name is required." });

  const [optional, errors] = readOptionalFields(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const member = await Member.create({
    name,
    phone: phone || null,
    email: email || null,
    qrToken: newQrToken(),
    churchId: req.user.churchId,
    ...optional,
  });

  res.status(201).json({ member: serialize(member) });
});

router.patch("/:id", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });

  const [optional, errors] = readOptionalFields(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const owned = await findOwnMember(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Member not found." });

  const member = await Member.findByIdAndUpdate(
    req.params.id,
    { name, phone: phone || null, email: email || null, ...optional },
    { new: true }
  );
  res.json({ member: serialize(member) });
});

router.post("/:id/deactivate", async (req, res) => {
  const owned = await findOwnMember(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Member not found." });
  const member = await Member.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  res.json({ member: serialize(member) });
});

router.post("/:id/reactivate", async (req, res) => {
  const owned = await findOwnMember(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Member not found." });
  const member = await Member.findByIdAndUpdate(req.params.id, { active: true }, { new: true });
  res.json({ member: serialize(member) });
});

router.post("/:id/regenerate-qr", async (req, res) => {
  const owned = await findOwnMember(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Member not found." });
  const member = await Member.findByIdAndUpdate(req.params.id, { qrToken: newQrToken() }, { new: true });
  res.json({ member: serialize(member) });
});

// GET /api/members/:id/qrcode — a ready-to-display/download PNG data URL
// encoding this member's check-in link (the frontend's /c/[token] page).
router.get("/:id/qrcode", async (req, res) => {
  const member = await findOwnMember(req.params.id, req.user.churchId);
  if (!member) return res.status(404).json({ error: "Member not found." });

  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
  const checkInUrl = `${frontendUrl}/c/${member.qrToken}`;
  const dataUrl = await QRCode.toDataURL(checkInUrl, { margin: 1, width: 320, color: { dark: "#1b1b2b" } });

  res.json({ dataUrl, checkInUrl });
});

// GET /api/members/:id/attendance — this member's check-in history.
router.get("/:id/attendance", async (req, res) => {
  const owned = await findOwnMember(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Member not found." });

  const rows = await Attendance.find({ memberId: req.params.id, churchId: req.user.churchId })
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

// --- Children (dependents) ------------------------------------------------
// Admin-only CRUD for a member's children — each gets their own personal
// QR code (see routes/children.js) and can be checked in by an admin/usher
// like any member, or by their verified parent via the venue self-check-in.

// GET /api/members/:memberId/children
router.get("/:memberId/children", async (req, res) => {
  const parent = await findOwnMember(req.params.memberId, req.user.churchId);
  if (!parent) return res.status(404).json({ error: "Member not found." });
  const children = await Child.find({ parentMemberId: parent.id, churchId: req.user.churchId }).sort({ name: 1 });
  res.json({ children: children.map(serializeChild) });
});

// POST /api/members/:memberId/children  { name }
router.post("/:memberId/children", async (req, res) => {
  const parent = await findOwnMember(req.params.memberId, req.user.churchId);
  if (!parent) return res.status(404).json({ error: "Member not found." });

  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Child's name is required." });

  const child = await Child.create({
    name,
    parentMemberId: parent.id,
    qrToken: newQrToken(),
    churchId: req.user.churchId,
  });
  res.status(201).json({ child: serializeChild(child) });
});

module.exports = router;

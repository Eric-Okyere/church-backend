const express = require("express");
const Visitor = require("../models/Visitor");
const Member = require("../models/Member");
const Attendance = require("../models/Attendance");
const { requireAuth } = require("../middleware/auth");
const { newQrToken } = require("../lib/utils");
const { phonesMatch } = require("../lib/attendance");

const router = express.Router();

router.use(requireAuth);

function serialize(v) {
  return {
    id: v.id,
    name: v.name,
    phone: v.phone,
    email: v.email,
    notes: v.notes,
    status: v.status,
    convertedMemberId: v.convertedMemberId,
    convertedAt: v.convertedAt,
    createdAt: v.createdAt,
  };
}

// Fetches a visitor by id, but ONLY if it belongs to the caller's church —
// same findOwnX pattern used everywhere else in this codebase (members,
// tithes, assets, levies): "not found" and "found but someone else's
// church" return identically, so a cross-tenant probe can't tell them
// apart.
async function findOwnVisitor(id, churchId) {
  const visitor = await Visitor.findById(id).catch(() => null);
  if (!visitor || String(visitor.churchId) !== String(churchId)) return null;
  return visitor;
}

// GET /api/visitors?status=visiting|converted
router.get("/", async (req, res) => {
  const filter = { churchId: req.user.churchId };
  if (req.query.status === "visiting" || req.query.status === "converted") {
    filter.status = req.query.status;
  }
  const visitors = await Visitor.find(filter).sort({ createdAt: -1 });
  res.json({ visitors: visitors.map(serialize) });
});

router.get("/:id", async (req, res) => {
  const visitor = await findOwnVisitor(req.params.id, req.user.churchId);
  if (!visitor) return res.status(404).json({ error: "Visitor not found." });
  res.json({ visitor: serialize(visitor) });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });

  const phone = String(req.body?.phone || "").trim();
  const email = String(req.body?.email || "").trim();
  const notes = String(req.body?.notes || "").trim();

  const visitor = await Visitor.create({
    name,
    phone: phone || null,
    email: email || null,
    notes: notes || null,
    churchId: req.user.churchId,
  });

  res.status(201).json({ visitor: serialize(visitor) });
});

router.patch("/:id", async (req, res) => {
  const visitor = await findOwnVisitor(req.params.id, req.user.churchId);
  if (!visitor) return res.status(404).json({ error: "Visitor not found." });

  if (req.body?.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required." });
    visitor.name = name;
  }
  if (req.body?.phone !== undefined) visitor.phone = String(req.body.phone || "").trim() || null;
  if (req.body?.email !== undefined) visitor.email = String(req.body.email || "").trim() || null;
  if (req.body?.notes !== undefined) visitor.notes = String(req.body.notes || "").trim() || null;

  await visitor.save();
  res.json({ visitor: serialize(visitor) });
});

router.delete("/:id", async (req, res) => {
  const visitor = await findOwnVisitor(req.params.id, req.user.churchId);
  if (!visitor) return res.status(404).json({ error: "Visitor not found." });
  await Visitor.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// Re-points any existing visitor-type attendance rows (method: "visitor",
// no memberId yet) whose visitorPhone tolerant-matches this visitor's own
// phone onto the newly created member — so a visitor's pre-membership
// check-in history (from the separate public QR self-check-in flow, or an
// admin's manual "add a walk-in visitor" check-in) shows up under their
// new member profile instead of being orphaned under a name/phone pair
// with no account. Deliberately leaves `method` as "visitor" (never
// rewritten to "manual"/"qr") and never touches checkedInByUserId/Name —
// same audit-log philosophy as the rest of this model: history records
// what actually happened, not what's true now. A duplicate-key clash
// (this member somehow already has an attendance row for that exact
// service) is skipped rather than thrown, matching insertAttendance's own
// handling of the same partial-unique-index constraint.
async function relinkVisitorAttendance(churchId, visitorPhone, memberId) {
  if (!visitorPhone) return 0;
  const candidates = await Attendance.find({ churchId, memberId: null, visitorPhone: { $ne: null } });
  let relinked = 0;
  for (const row of candidates) {
    if (!phonesMatch(visitorPhone, row.visitorPhone)) continue;
    row.memberId = memberId;
    row.visitorName = null;
    row.visitorPhone = null;
    try {
      await row.save();
      relinked += 1;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return relinked;
}

const GENDERS = ["Male", "Female"];
const MARITAL_STATUSES = ["single", "married", "divorced", "widowed", "separated"];
const JOB_STATUSES = ["employed", "unemployed", "self_employed", "student"];
const DEPARTMENTS = ["Youth", "Children", "Men", "Leader", "Women"];

function pickEnum(value, allowed, label, errors) {
  if (value === undefined || value === null || value === "") return null;
  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of: ${allowed.join(", ")}.`);
    return null;
  }
  return value;
}

// POST /api/visitors/:id/convert-to-member
// Creates a new Member from this visitor's info (name/phone/email, plus
// any of the same optional profile fields /api/members itself accepts —
// all optional here too), marks the visitor "converted", and re-links any
// matching past visitor-attendance rows onto the new member. Rejects a
// visitor that's already been converted, rather than silently creating a
// second member from the same visitor entry.
router.post("/:id/convert-to-member", async (req, res) => {
  const visitor = await findOwnVisitor(req.params.id, req.user.churchId);
  if (!visitor) return res.status(404).json({ error: "Visitor not found." });
  if (visitor.status === "converted") {
    return res.status(400).json({ error: "This visitor has already been converted to a member." });
  }

  const errors = [];
  const gender = pickEnum(req.body?.gender, GENDERS, "Gender", errors);
  const maritalStatus = pickEnum(req.body?.maritalStatus, MARITAL_STATUSES, "Marital status", errors);
  const jobStatus = pickEnum(req.body?.jobStatus, JOB_STATUSES, "Job status", errors);
  const department = pickEnum(req.body?.department, DEPARTMENTS, "Department", errors);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const name = String(req.body?.name || visitor.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name is required." });
  const phone = req.body?.phone !== undefined ? String(req.body.phone || "").trim() : visitor.phone || "";
  const email = req.body?.email !== undefined ? String(req.body.email || "").trim() : visitor.email || "";

  const member = await Member.create({
    name,
    phone: phone || null,
    email: email || null,
    qrToken: newQrToken(),
    churchId: req.user.churchId,
    gender,
    maritalStatus,
    jobStatus,
    department,
  });

  const relinkedCount = await relinkVisitorAttendance(req.user.churchId, visitor.phone, member.id);

  visitor.status = "converted";
  visitor.convertedMemberId = member.id;
  visitor.convertedAt = new Date();
  await visitor.save();

  res.status(201).json({
    visitor: serialize(visitor),
    member: {
      id: member.id,
      name: member.name,
      phone: member.phone,
      email: member.email,
      qrToken: member.qrToken,
    },
    relinkedAttendanceCount: relinkedCount,
  });
});

module.exports = router;

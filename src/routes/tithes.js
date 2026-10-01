const express = require("express");
const TitheRecord = require("../models/TitheRecord");
const Member = require("../models/Member");
const { requireAuth } = require("../middleware/auth");
const { todayIso } = require("../lib/utils");

const router = express.Router();
router.use(requireAuth);

// `memberId` comes back populated (just { id, name }) when the caller asked
// for every church's record rather than one member's own history — the
// church-wide overview needs a name to show per row; a member's own
// history page already knows whose records it's looking at.
function serialize(t) {
  const member = t.memberId && typeof t.memberId === "object" && t.memberId.name !== undefined ? t.memberId : null;
  return {
    id: t.id,
    memberId: member ? member.id : String(t.memberId),
    memberName: member ? member.name : null,
    amount: t.amount,
    date: t.date,
    note: t.note,
    createdAt: t.createdAt,
  };
}

// Fetches a tithe record but ONLY if it belongs to the caller's church —
// same cross-tenant guard used everywhere else in this app.
async function findOwnTithe(id, churchId) {
  const record = await TitheRecord.findById(id).catch(() => null);
  if (!record || String(record.churchId) !== String(churchId)) return null;
  return record;
}

// GET /api/tithes?memberId=<id>  — all of this church's tithe records, or
// just one member's, newest first.
router.get("/", async (req, res) => {
  const filter = { churchId: req.user.churchId };
  if (req.query.memberId) filter.memberId = req.query.memberId;
  const records = await TitheRecord.find(filter).sort({ date: -1, createdAt: -1 }).populate("memberId", "name");
  res.json({ tithes: records.map(serialize) });
});

router.post("/", async (req, res) => {
  const memberId = String(req.body?.memberId || "").trim();
  const amount = Number(req.body?.amount);
  const date = String(req.body?.date || "").trim() || todayIso();
  const note = String(req.body?.note || "").trim() || null;

  if (!memberId) return res.status(400).json({ error: "Member is required." });
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number." });
  }

  const member = await Member.findById(memberId).catch(() => null);
  if (!member || String(member.churchId) !== String(req.user.churchId)) {
    return res.status(404).json({ error: "Member not found." });
  }

  const record = await TitheRecord.create({
    churchId: req.user.churchId,
    memberId,
    amount,
    date,
    note,
    recordedBy: req.user.id,
  });
  const populated = await record.populate("memberId", "name");
  res.status(201).json({ tithe: serialize(populated) });
});

router.patch("/:id", async (req, res) => {
  const record = await findOwnTithe(req.params.id, req.user.churchId);
  if (!record) return res.status(404).json({ error: "Tithe record not found." });

  const update = {};
  if (req.body?.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number." });
    }
    update.amount = amount;
  }
  if (req.body?.date !== undefined) {
    const date = String(req.body.date || "").trim();
    if (!date) return res.status(400).json({ error: "Date is required." });
    update.date = date;
  }
  if (req.body?.note !== undefined) {
    update.note = String(req.body.note || "").trim() || null;
  }

  const updated = await TitheRecord.findByIdAndUpdate(req.params.id, update, { new: true }).populate("memberId", "name");
  res.json({ tithe: serialize(updated) });
});

router.delete("/:id", async (req, res) => {
  const record = await findOwnTithe(req.params.id, req.user.churchId);
  if (!record) return res.status(404).json({ error: "Tithe record not found." });
  await TitheRecord.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

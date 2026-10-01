const express = require("express");
const mongoose = require("mongoose");
const Levy = require("../models/Levy");
const LevyContribution = require("../models/LevyContribution");
const Member = require("../models/Member");
const { requireAuth } = require("../middleware/auth");
const { todayIso } = require("../lib/utils");

const router = express.Router();
router.use(requireAuth);

function serializeLevy(l) {
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    amountPerMember: l.amountPerMember,
    active: l.active,
    createdAt: l.createdAt,
  };
}

function serializeContribution(c) {
  const member = c.memberId && typeof c.memberId === "object" && c.memberId.name !== undefined ? c.memberId : null;
  return {
    id: c.id,
    memberId: member ? member.id : String(c.memberId),
    memberName: member ? member.name : null,
    amount: c.amount,
    date: c.date,
    note: c.note,
    createdAt: c.createdAt,
  };
}

async function findOwnLevy(id, churchId) {
  const levy = await Levy.findById(id).catch(() => null);
  if (!levy || String(levy.churchId) !== String(churchId)) return null;
  return levy;
}

// Fetches a contribution, but ONLY if it belongs to both the given levy AND
// the caller's church — two independent checks, same reasoning as every
// other cross-tenant guard in this app: a contribution id alone should
// never let someone probe or edit a record outside their own church/levy.
async function findOwnContribution(levyId, contributionId, churchId) {
  const contribution = await LevyContribution.findById(contributionId).catch(() => null);
  if (
    !contribution ||
    String(contribution.levyId) !== String(levyId) ||
    String(contribution.churchId) !== String(churchId)
  ) {
    return null;
  }
  return contribution;
}

// GET /api/levies — every levy for this church, with how much has been
// collected toward it so far and how many distinct members have given
// something, for the overview list. Aggregation bypasses Mongoose's
// automatic string->ObjectId casting (that only happens in find()), so
// churchId has to be cast explicitly here.
router.get("/", async (req, res) => {
  const [levies, memberCount] = await Promise.all([
    Levy.find({ churchId: req.user.churchId }).sort({ createdAt: -1 }),
    Member.countDocuments({ churchId: req.user.churchId, active: true }),
  ]);

  const churchObjectId = new mongoose.Types.ObjectId(req.user.churchId);
  const totals = await LevyContribution.aggregate([
    { $match: { churchId: churchObjectId } },
    { $group: { _id: "$levyId", totalCollected: { $sum: "$amount" }, members: { $addToSet: "$memberId" } } },
  ]);
  const totalsByLevy = new Map(totals.map((t) => [String(t._id), t]));

  // memberCount is included so the frontend can show "collected vs the
  // whole church's expected total" (amountPerMember * memberCount), not
  // just a raw sum with nothing to compare it against.
  res.json({
    levies: levies.map((l) => {
      const t = totalsByLevy.get(String(l.id));
      return {
        ...serializeLevy(l),
        totalCollected: t ? t.totalCollected : 0,
        contributorCount: t ? t.members.length : 0,
        memberCount,
      };
    }),
  });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const description = String(req.body?.description || "").trim() || null;
  const amountPerMember = Number(req.body?.amountPerMember);

  if (!name) return res.status(400).json({ error: "Levy name is required." });
  if (!Number.isFinite(amountPerMember) || amountPerMember <= 0) {
    return res.status(400).json({ error: "Amount per member must be a positive number." });
  }

  const levy = await Levy.create({ churchId: req.user.churchId, name, description, amountPerMember });
  const memberCount = await Member.countDocuments({ churchId: req.user.churchId, active: true });
  res.status(201).json({ levy: { ...serializeLevy(levy), totalCollected: 0, contributorCount: 0, memberCount } });
});

// GET /api/levies/:id — the levy itself, plus every active member's
// progress toward it (paid so far vs amountPerMember) and the full
// contribution history. "Progress" is always computed here from
// LevyContribution, never stored, so it can't drift out of sync.
router.get("/:id", async (req, res) => {
  const levy = await findOwnLevy(req.params.id, req.user.churchId);
  if (!levy) return res.status(404).json({ error: "Levy not found." });

  const [members, contributions] = await Promise.all([
    Member.find({ churchId: req.user.churchId, active: true }).sort({ name: 1 }).select("name"),
    LevyContribution.find({ levyId: levy.id }).sort({ date: -1, createdAt: -1 }).populate("memberId", "name"),
  ]);

  const paidByMember = new Map();
  let totalCollected = 0;
  for (const c of contributions) {
    const id = String(c.memberId?.id || c.memberId);
    paidByMember.set(id, (paidByMember.get(id) || 0) + c.amount);
    totalCollected += c.amount;
  }

  const progress = members.map((m) => {
    const paid = paidByMember.get(String(m.id)) || 0;
    return {
      memberId: m.id,
      memberName: m.name,
      paid,
      outstanding: Math.max(0, levy.amountPerMember - paid),
      fullyPaid: paid >= levy.amountPerMember,
    };
  });

  res.json({
    levy: serializeLevy(levy),
    totalCollected,
    progress,
    contributions: contributions.map(serializeContribution),
  });
});

router.patch("/:id", async (req, res) => {
  const levy = await findOwnLevy(req.params.id, req.user.churchId);
  if (!levy) return res.status(404).json({ error: "Levy not found." });

  const update = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Levy name is required." });
    update.name = name;
  }
  if (req.body?.description !== undefined) {
    update.description = String(req.body.description || "").trim() || null;
  }
  if (req.body?.amountPerMember !== undefined) {
    const amountPerMember = Number(req.body.amountPerMember);
    if (!Number.isFinite(amountPerMember) || amountPerMember <= 0) {
      return res.status(400).json({ error: "Amount per member must be a positive number." });
    }
    update.amountPerMember = amountPerMember;
  }
  if (req.body?.active !== undefined) {
    update.active = !!req.body.active;
  }

  const updated = await Levy.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({ levy: serializeLevy(updated) });
});

// Deleting a levy takes its contribution history with it — there's no
// "orphaned contribution" state in this schema (every contribution needs
// its levy to mean anything), so this cascades rather than leaving rows
// behind that findOwnLevy would reject but still sit in the collection.
router.delete("/:id", async (req, res) => {
  const levy = await findOwnLevy(req.params.id, req.user.churchId);
  if (!levy) return res.status(404).json({ error: "Levy not found." });
  await LevyContribution.deleteMany({ levyId: levy.id });
  await Levy.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

router.post("/:id/contributions", async (req, res) => {
  const levy = await findOwnLevy(req.params.id, req.user.churchId);
  if (!levy) return res.status(404).json({ error: "Levy not found." });

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

  const contribution = await LevyContribution.create({
    levyId: levy.id,
    memberId,
    churchId: req.user.churchId,
    amount,
    date,
    note,
    recordedBy: req.user.id,
  });
  const populated = await contribution.populate("memberId", "name");
  res.status(201).json({ contribution: serializeContribution(populated) });
});

router.patch("/:id/contributions/:contributionId", async (req, res) => {
  const contribution = await findOwnContribution(req.params.id, req.params.contributionId, req.user.churchId);
  if (!contribution) return res.status(404).json({ error: "Contribution not found." });

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

  const updated = await LevyContribution.findByIdAndUpdate(req.params.contributionId, update, { new: true }).populate(
    "memberId",
    "name"
  );
  res.json({ contribution: serializeContribution(updated) });
});

router.delete("/:id/contributions/:contributionId", async (req, res) => {
  const contribution = await findOwnContribution(req.params.id, req.params.contributionId, req.user.churchId);
  if (!contribution) return res.status(404).json({ error: "Contribution not found." });
  await LevyContribution.findByIdAndDelete(req.params.contributionId);
  res.json({ ok: true });
});

module.exports = router;

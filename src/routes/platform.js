const express = require("express");
const Church = require("../models/Church");
const User = require("../models/User");
const Member = require("../models/Member");
const { requireAuth, requirePlatformAdmin } = require("../middleware/auth");

const router = express.Router();

// Exclusive prefix (/api/platform, mounted in server.js) — same
// router-mounting-safety rule as analyticsRoutes: a blanket router.use()
// auth gate is only safe here because nothing else shares this prefix.
// Every route below spans every church at once, unlike the rest of this
// API, which is always scoped to req.user.churchId.
router.use(requireAuth, requirePlatformAdmin);

async function serializeChurch(church) {
  const [memberCount, firstAdmin] = await Promise.all([
    Member.countDocuments({ churchId: church.id, active: true }),
    User.findOne({ churchId: church.id, role: "admin" }).sort({ createdAt: 1 }),
  ]);
  return {
    id: church.id,
    name: church.name,
    slug: church.slug,
    active: church.active,
    createdAt: church.createdAt,
    memberCount,
    adminName: firstAdmin ? firstAdmin.name : null,
    adminUsername: firstAdmin ? firstAdmin.username : null,
    paymentStatus: church.paymentStatus,
    paymentNote: church.paymentNote,
    paymentUpdatedAt: church.paymentUpdatedAt,
  };
}

router.get("/churches", async (req, res) => {
  const churches = await Church.find().sort({ createdAt: -1 });
  const serialized = await Promise.all(churches.map(serializeChurch));
  res.json({ churches: serialized });
});

router.patch("/churches/:id/payment", async (req, res) => {
  const { paymentStatus, paymentNote } = req.body || {};
  if (!["paid", "unpaid"].includes(paymentStatus)) {
    return res.status(400).json({ error: 'paymentStatus must be "paid" or "unpaid".' });
  }

  const church = await Church.findById(req.params.id);
  if (!church) {
    return res.status(404).json({ error: "Church not found." });
  }

  church.paymentStatus = paymentStatus;
  church.paymentNote = typeof paymentNote === "string" ? paymentNote.trim() || null : null;
  church.paymentUpdatedAt = new Date();
  await church.save();

  res.json({ church: await serializeChurch(church) });
});

module.exports = router;

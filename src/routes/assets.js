const express = require("express");
const ChurchAsset = require("../models/ChurchAsset");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function serialize(a) {
  return { id: a.id, name: a.name, quantity: a.quantity, notes: a.notes, createdAt: a.createdAt };
}

async function findOwnAsset(id, churchId) {
  const asset = await ChurchAsset.findById(id).catch(() => null);
  if (!asset || String(asset.churchId) !== String(churchId)) return null;
  return asset;
}

router.get("/", async (req, res) => {
  const assets = await ChurchAsset.find({ churchId: req.user.churchId }).sort({ name: 1 });
  res.json({ assets: assets.map(serialize) });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const quantity = req.body?.quantity === undefined || req.body?.quantity === "" ? 1 : Number(req.body.quantity);
  const notes = String(req.body?.notes || "").trim() || null;

  if (!name) return res.status(400).json({ error: "Item name is required." });
  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({ error: "Quantity must be a non-negative number." });
  }

  const asset = await ChurchAsset.create({ churchId: req.user.churchId, name, quantity, notes });
  res.status(201).json({ asset: serialize(asset) });
});

router.patch("/:id", async (req, res) => {
  const asset = await findOwnAsset(req.params.id, req.user.churchId);
  if (!asset) return res.status(404).json({ error: "Item not found." });

  const update = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Item name is required." });
    update.name = name;
  }
  if (req.body?.quantity !== undefined) {
    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({ error: "Quantity must be a non-negative number." });
    }
    update.quantity = quantity;
  }
  if (req.body?.notes !== undefined) {
    update.notes = String(req.body.notes || "").trim() || null;
  }

  const updated = await ChurchAsset.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({ asset: serialize(updated) });
});

router.delete("/:id", async (req, res) => {
  const asset = await findOwnAsset(req.params.id, req.user.churchId);
  if (!asset) return res.status(404).json({ error: "Item not found." });
  await ChurchAsset.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

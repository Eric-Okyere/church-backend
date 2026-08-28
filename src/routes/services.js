const express = require("express");
const Service = require("../models/Service");
const { requireAuth } = require("../middleware/auth");
const { todayIso } = require("../lib/utils");

const router = express.Router();
router.use(requireAuth);

function serialize(s) {
  return { id: s.id, name: s.name, date: s.date, status: s.status, createdAt: s.createdAt };
}

// Fetches a service by id, but ONLY if it belongs to the caller's church.
async function findOwnService(id, churchId) {
  const service = await Service.findById(id).catch(() => null);
  if (!service || String(service.churchId) !== String(churchId)) return null;
  return service;
}

router.get("/", async (req, res) => {
  const services = await Service.find({ churchId: req.user.churchId }).sort({ createdAt: -1 });
  res.json({ services: services.map(serialize) });
});

router.get("/:id", async (req, res) => {
  const service = await findOwnService(req.params.id, req.user.churchId);
  if (!service) return res.status(404).json({ error: "Service not found." });
  res.json({ service: serialize(service) });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const date = String(req.body?.date || "").trim() || todayIso();
  const activateNow = !!req.body?.activateNow;

  if (!name) return res.status(400).json({ error: "Service name is required." });

  if (activateNow) {
    // Only end THIS church's other active services — a second church
    // activating a service must never touch the first church's.
    await Service.updateMany({ status: "active", churchId: req.user.churchId }, { status: "ended" });
  }

  const service = await Service.create({
    name,
    date,
    status: activateNow ? "active" : "scheduled",
    churchId: req.user.churchId,
  });
  res.status(201).json({ service: serialize(service) });
});

router.post("/:id/activate", async (req, res) => {
  const owned = await findOwnService(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Service not found." });

  await Service.updateMany({ status: "active", churchId: req.user.churchId }, { status: "ended" });
  const service = await Service.findByIdAndUpdate(req.params.id, { status: "active" }, { new: true });
  res.json({ service: serialize(service) });
});

router.post("/:id/end", async (req, res) => {
  const owned = await findOwnService(req.params.id, req.user.churchId);
  if (!owned) return res.status(404).json({ error: "Service not found." });

  const service = await Service.findByIdAndUpdate(req.params.id, { status: "ended" }, { new: true });
  res.json({ service: serialize(service) });
});

module.exports = router;

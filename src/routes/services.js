const express = require("express");
const Service = require("../models/Service");
const { requireAuth } = require("../middleware/auth");
const { todayIso } = require("../lib/utils");

const router = express.Router();
router.use(requireAuth);

function serialize(s) {
  return { id: s.id, name: s.name, date: s.date, status: s.status, createdAt: s.createdAt };
}

router.get("/", async (req, res) => {
  const services = await Service.find().sort({ createdAt: -1 });
  res.json({ services: services.map(serialize) });
});

router.get("/:id", async (req, res) => {
  const service = await Service.findById(req.params.id).catch(() => null);
  if (!service) return res.status(404).json({ error: "Service not found." });
  res.json({ service: serialize(service) });
});

router.post("/", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const date = String(req.body?.date || "").trim() || todayIso();
  const activateNow = !!req.body?.activateNow;

  if (!name) return res.status(400).json({ error: "Service name is required." });

  if (activateNow) {
    await Service.updateMany({ status: "active" }, { status: "ended" });
  }

  const service = await Service.create({ name, date, status: activateNow ? "active" : "scheduled" });
  res.status(201).json({ service: serialize(service) });
});

router.post("/:id/activate", async (req, res) => {
  await Service.updateMany({ status: "active" }, { status: "ended" });
  const service = await Service.findByIdAndUpdate(req.params.id, { status: "active" }, { new: true }).catch(
    () => null
  );
  if (!service) return res.status(404).json({ error: "Service not found." });
  res.json({ service: serialize(service) });
});

router.post("/:id/end", async (req, res) => {
  const service = await Service.findByIdAndUpdate(req.params.id, { status: "ended" }, { new: true }).catch(
    () => null
  );
  if (!service) return res.status(404).json({ error: "Service not found." });
  res.json({ service: serialize(service) });
});

module.exports = router;

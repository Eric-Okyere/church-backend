const mongoose = require("mongoose");

// A single member's payment toward a specific Levy. churchId is
// denormalized from the levy at creation time — same reasoning as
// Child.churchId: every query here can filter directly without joining
// through levyId first, and it's a second, independent tenant check
// alongside the levy-ownership check in the routes.
const levyContributionSchema = new mongoose.Schema({
  levyId: { type: mongoose.Schema.Types.ObjectId, ref: "Levy", required: true, index: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  date: { type: String, required: true },
  note: { type: String, default: null, trim: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("LevyContribution", levyContributionSchema);

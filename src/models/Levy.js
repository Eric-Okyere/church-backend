const mongoose = require("mongoose");

// A named, church-defined contribution drive with a fixed amount every
// member is expected to pay (e.g. "Building Fund 2026" at a flat amount
// each). Individual payments toward it live separately in
// LevyContribution — a member's progress is always (sum of their
// contributions) vs amountPerMember, computed on read, never stored here,
// so there's nothing to get out of sync.
const levySchema = new mongoose.Schema({
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: null, trim: true },
  amountPerMember: { type: Number, required: true, min: 0.01 },
  // A closed levy stays visible, with its contribution history intact, but
  // is no longer offered when recording a new contribution — a church
  // closes a levy once its collection period ends rather than deleting it.
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Levy", levySchema);

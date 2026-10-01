const mongoose = require("mongoose");

// A single tithe payment from one member, logged by an admin/usher at the
// time it's received. This is a log of individual payments, not a running
// balance — correcting a mistake means editing or deleting the specific
// entry, never adjusting a stored total (there isn't one; it's always
// computed from these records).
const titheRecordSchema = new mongoose.Schema({
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  // ISO date (yyyy-mm-dd) — the day the tithe was actually given, which an
  // admin may be logging after the fact, so it's a separate field from
  // createdAt rather than reusing it.
  date: { type: String, required: true },
  note: { type: String, default: null, trim: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("TitheRecord", titheRecordSchema);

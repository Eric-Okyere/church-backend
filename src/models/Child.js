const mongoose = require("mongoose");

// A member's child, registered so the child can have their own personal QR
// code — scannable at the kiosk like any member's, or checked in by their
// parent during the venue self-check-in flow. Deliberately NOT a Member:
// children don't sign in anywhere and have no phone number of their own, so
// they can never go through phone-based identity verification themselves —
// every check-in path for a child is either an admin/usher action (kiosk
// scan, manual) or gated through their verified parent (venue flow).
const childSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  parentMemberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", required: true },
  qrToken: { type: String, required: true, unique: true },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Child", childSchema);

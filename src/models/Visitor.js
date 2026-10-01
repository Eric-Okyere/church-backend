const mongoose = require("mongoose");

// A church-maintained list of people who've visited but aren't (yet) a
// registered Member — deliberately separate from the existing public QR
// self-check-in "visitor" attendance rows (Attendance.visitorName/
// visitorPhone), which just log a name/phone against a single service and
// are never meant to be a persistent, editable directory. This model is
// that directory: an admin/usher adds someone here manually (e.g. after
// meeting them, or following up on a walk-in), can edit/remove the entry,
// and — once they've "fellowshipped" with them for however long the church
// judges appropriate, a deliberately unenforced, admin-judgment call, not a
// system-timed rule — converts them into a full Member record.
const visitorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: null, trim: true },
  email: { type: String, default: null, trim: true },
  notes: { type: String, default: null, trim: true },
  // Every query against this collection MUST filter by churchId — same
  // rule as every other tenant-scoped collection in this codebase.
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  status: { type: String, enum: ["visiting", "converted"], default: "visiting" },
  // Set only once converted — which Member record this visitor became, and
  // when. Kept even though status already says "converted", so the member
  // can be linked back to from the visitor list without a second lookup.
  convertedMemberId: { type: mongoose.Schema.Types.ObjectId, ref: "Member", default: null },
  convertedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Visitor", visitorSchema);

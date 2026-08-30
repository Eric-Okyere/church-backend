const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema({
  serviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Service",
    required: true,
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Member",
    default: null,
  },
  childId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Child",
    default: null,
  },
  visitorName: { type: String, default: null },
  visitorPhone: { type: String, default: null },
  // Denormalized from the service at creation time so per-church reporting
  // (dashboard counts, CSV export) never needs to join through serviceId.
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  method: { type: String, enum: ["qr", "manual", "visitor", "venue"], required: true },
  // Only set for method: "venue" — the GPS coordinates reported by the
  // member's own phone at the moment they self-checked-in via the posted
  // QR code, kept for audit purposes (e.g. investigating a disputed
  // check-in). Never required, and never shown back to the member.
  location: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  checkedInAt: { type: Date, default: Date.now },
  // Who actually performed this check-in, when it was an admin/usher acting
  // on someone else's behalf (kiosk scan, manual search, adding a walk-in
  // visitor, or opening a personal-QR link while signed in) — null for every
  // self-service path (venue self-check-in, venue child check-in, a visitor
  // checking themselves in via the posted QR). Useful when more than one
  // usher is covering the kiosk under pressure and it's not obvious later
  // who checked a given person in. Name is denormalized alongside the id
  // (same pattern as churchId elsewhere on this model) so displaying it
  // never needs a populate — a User being renamed later doesn't rewrite
  // history, which is the intended, audit-log-like behavior here.
  checkedInByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  checkedInByName: { type: String, default: null },
});

// Belt-and-suspenders: even though the route logic checks for an existing
// check-in before inserting, this partial unique index stops a member being
// recorded twice for the same service at the database level too (it only
// applies to rows that actually have a memberId — visitor rows are exempt).
attendanceSchema.index(
  { serviceId: 1, memberId: 1 },
  { unique: true, partialFilterExpression: { memberId: { $type: "objectId" } } }
);

// Same protection for children — a child can't be recorded twice for the
// same service either.
attendanceSchema.index(
  { serviceId: 1, childId: 1 },
  { unique: true, partialFilterExpression: { childId: { $type: "objectId" } } }
);

module.exports = mongoose.model("Attendance", attendanceSchema);

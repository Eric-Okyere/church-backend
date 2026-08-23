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
  visitorName: { type: String, default: null },
  visitorPhone: { type: String, default: null },
  method: { type: String, enum: ["qr", "manual", "visitor"], required: true },
  checkedInAt: { type: Date, default: Date.now },
});

// Belt-and-suspenders: even though the route logic checks for an existing
// check-in before inserting, this partial unique index stops a member being
// recorded twice for the same service at the database level too (it only
// applies to rows that actually have a memberId — visitor rows are exempt).
attendanceSchema.index(
  { serviceId: 1, memberId: 1 },
  { unique: true, partialFilterExpression: { memberId: { $type: "objectId" } } }
);

module.exports = mongoose.model("Attendance", attendanceSchema);

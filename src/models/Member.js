const mongoose = require("mongoose");

const memberSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: null, trim: true },
  email: { type: String, default: null, trim: true },
  qrToken: { type: String, required: true, unique: true },
  active: { type: Boolean, default: true },
  // Every query against this collection MUST filter by churchId — this is
  // what keeps one church's members invisible to every other church.
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },

  // Everything below is entirely optional — a member record is complete
  // with just a name. These exist for churches that want to keep richer
  // profiles; the UI presents them as an optional "additional details"
  // section rather than requiring them up front.
  gender: {
    type: String,
    enum: ["Male", "Female"],
    default: null,
  },
  maritalStatus: {
    type: String,
    enum: ["single", "married", "divorced", "widowed", "separated"],
    default: null,
  },
  jobStatus: {
    type: String,
    enum: ["employed", "unemployed", "self_employed", "student"],
    default: null,
  },
  emergencyContactName: { type: String, default: null, trim: true },
  emergencyContactPhone: { type: String, default: null, trim: true },
  address: { type: String, default: null, trim: true },
  // Self-reported total, independent of how many children are actually
  // registered below with their own QR codes (a member might report 3 but
  // only add 2 as check-in-able profiles, e.g. one is grown/not attending).
  numberOfChildren: { type: Number, default: null },
  department: {
    type: String,
    enum: ["Youth", "Children", "Men", "Leader", "Women"],
    default: null,
  },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Member", memberSchema);

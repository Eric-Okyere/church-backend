const mongoose = require("mongoose");

// The church's own inventory of physical items — instruments, sound
// equipment, furniture, anything worth keeping a count of. Deliberately
// simple: a name, how many the church has, and a free-text notes field for
// anything else worth recording (condition, location, serial numbers) —
// see the app-overview doc for why this wasn't built with separate
// category/condition fields.
const churchAssetSchema = new mongoose.Schema({
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 0, default: 1 },
  notes: { type: String, default: null, trim: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("ChurchAsset", churchAssetSchema);

const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  date: { type: String, required: true }, // ISO date (yyyy-mm-dd)
  status: {
    type: String,
    enum: ["scheduled", "active", "ended"],
    default: "scheduled",
  },
  // Multiple churches can each have their own "active" service running at
  // the same time — "the active service" only ever means "the active
  // service for THIS church", so every lookup filters by churchId too.
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Service", serviceSchema);

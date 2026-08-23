const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  date: { type: String, required: true }, // ISO date (yyyy-mm-dd)
  status: {
    type: String,
    enum: ["scheduled", "active", "ended"],
    default: "scheduled",
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Service", serviceSchema);

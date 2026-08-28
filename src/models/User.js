const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Usernames are unique across the WHOLE platform, not just within a
  // church — deliberately, so login stays a plain username+password form
  // with no separate "which church" step. Nothing else about a user's
  // access is global: every query elsewhere is filtered by churchId.
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["admin", "usher"], default: "usher" },
  churchId: { type: mongoose.Schema.Types.ObjectId, ref: "Church", required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", userSchema);

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
  // Required for an ordinary church user, but optional for a platform admin
  // (isPlatformAdmin: true) — a platform admin isn't scoped to any one
  // church, so it has no churchId at all.
  churchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Church",
    required: function requiresChurch() {
      return !this.isPlatformAdmin;
    },
    default: null,
  },
  // A separate privilege tier from the per-church role above — set only by
  // the `npm run seed:platform-admin` script, never through church signup.
  // Grants access to the cross-church /api/platform/* routes and nothing
  // else; it does NOT imply role: "admin" within any particular church.
  isPlatformAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", userSchema);

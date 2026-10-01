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
  // Collected at signup going forward (required there) so password
  // reset has somewhere to send a link. Optional here at the schema
  // level only so accounts created before this existed don't fail
  // validation on save — they add one later from /admin/settings.
  // sparse so any number of accounts can have no email on file without
  // colliding on the unique index.
  email: { type: String, default: null, lowercase: true, trim: true, unique: true, sparse: true },
  // True for every account except a brand-new signup still working through
  // the 6-digit email-verification step (see routes/churches.js) — that
  // account is created with this explicitly set to false and can't sign in
  // until it verifies. Defaults to true so every account that predates
  // this feature (including the platform admin, and any account that
  // added its email later from Settings rather than at signup) is
  // unaffected — the login gate below only ever blocks an account that
  // was deliberately created unverified.
  emailVerified: { type: Boolean, default: true },
  // Set by POST /api/auth/forgot-password, cleared on successful reset
  // or once it expires. The raw token is never stored — only its SHA-256
  // hash, so a database read alone can't be used to reset someone's
  // password.
  resetTokenHash: { type: String, default: null },
  resetTokenExpires: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", userSchema);

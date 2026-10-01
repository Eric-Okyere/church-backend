const mongoose = require("mongoose");

// A short-lived record of "we sent this email a 6-digit code and they
// proved they received it" — used to verify an email BEFORE a church
// account exists for it, so there's nowhere on a User/Church document yet
// to store this. One document per email (upserted on each new code
// request); cleaned up once signup actually completes.
const emailVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // SHA-256 hash only — the raw 6-digit code is never stored, same
  // convention as User.resetTokenHash.
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  // Wrong-code guesses against this record. Locked out (must request a
  // fresh code) once this hits MAX_ATTEMPTS in routes/churches.js, so a
  // 6-digit code can't just be brute-forced (only 10,000 possibilities).
  attempts: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  // Throttles "resend" spam independently of the attempts/rate-limit
  // middleware above it — see MIN_RESEND_INTERVAL_MS in routes/churches.js.
  lastSentAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("EmailVerification", emailVerificationSchema);

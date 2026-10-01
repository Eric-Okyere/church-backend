const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const Church = require("../models/Church");
const User = require("../models/User");
const EmailVerification = require("../models/EmailVerification");
const { signToken, requireAuth, requireAdmin } = require("../middleware/auth");
const { slugify } = require("../lib/utils");
const { sendSignupVerificationCode } = require("../lib/mailer");

const router = express.Router();

// Public — creating a church account is how a new congregation joins the
// platform at all, so there's nothing to authenticate against yet.
// Rate-limited since it's an unauthenticated endpoint that writes to the
// database (account creation is a classic abuse target).
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts from this device — please try again later." },
});

// Separate, slightly more generous limiter for the verification-code
// endpoints — someone legitimately mistyping a code or wanting a resend
// shouldn't burn through the same budget as full signup attempts.
const verificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts from this device — please try again later." },
});

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CODE_ATTEMPTS = 5; // wrong guesses against one sent code before it's locked
const MIN_RESEND_INTERVAL_MS = 30 * 1000; // throttle "resend" independent of the rate limiter above

function hashCode(rawCode) {
  return crypto.createHash("sha256").update(rawCode).digest("hex");
}

function generateCode() {
  // 6 digits, zero-padded — crypto.randomInt is uniform (unlike
  // Math.random()) and still trivial to type back in from an email.
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Generates a code, stores only its hash (upserting over any previous
// pending code for this email), and emails the raw code. Shared by the
// auto-send right after signup below and the standalone resend endpoint,
// so both paths are guaranteed to behave identically.
async function issueAndSendVerificationCode(email) {
  const rawCode = generateCode();
  await EmailVerification.findOneAndUpdate(
    { email },
    {
      email,
      codeHash: hashCode(rawCode),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      attempts: 0,
      verified: false,
      verifiedAt: null,
      lastSentAt: new Date(),
    },
    { upsert: true }
  );
  await sendSignupVerificationCode({ to: email, code: rawCode });
}

// POST /api/churches/send-signup-code { email }
// "Resend my code" — for an account that ALREADY EXISTS (created by
// /churches/signup below) but hasn't verified its email yet. Not usable to
// pre-verify before an account exists anymore — see the twenty-first vs.
// twenty-second round note in app-overview.md for why that changed.
router.post("/churches/send-signup-code", verificationLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(404).json({ error: "We don't have a pending signup for that email — sign up first." });
  }
  if (user.emailVerified) {
    return res.status(400).json({ error: "That email is already verified — sign in instead." });
  }

  const existing = await EmailVerification.findOne({ email });
  if (existing && Date.now() - existing.lastSentAt.getTime() < MIN_RESEND_INTERVAL_MS) {
    return res.status(429).json({ error: "Please wait a moment before requesting another code." });
  }

  try {
    await issueAndSendVerificationCode(email);
  } catch (err) {
    console.error("Failed to send signup verification email:", err.message);
    return res.status(502).json({ error: "Couldn't send a verification email right now — try again shortly." });
  }

  res.json({ ok: true, message: "We've sent a new 6-digit code to that email." });
});

// POST /api/churches/verify-signup-code { email, code }
// Confirms the code for an account that /churches/signup already created
// (unverified). On success, marks the account verified AND signs it in
// (same response shape as /api/auth/login) — the person doesn't need to
// separately retype their username/password right after verifying. Locks
// the record (must request a fresh code) after MAX_CODE_ATTEMPTS wrong
// guesses, since a 6-digit code only has 1,000,000 possibilities.
router.post("/churches/verify-signup-code", verificationLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  if (!email || !code) return res.status(400).json({ error: "Enter the code we emailed you." });

  const record = await EmailVerification.findOne({ email });
  if (!record || record.expiresAt < new Date()) {
    return res.status(400).json({ error: "That code has expired — request a new one." });
  }
  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    return res.status(400).json({ error: "Too many incorrect attempts — request a new code." });
  }
  if (record.codeHash !== hashCode(code)) {
    record.attempts += 1;
    await record.save();
    return res.status(400).json({ error: "That code is incorrect." });
  }

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(400).json({ error: "We couldn't find that account — please sign up again." });
  }
  user.emailVerified = true;
  await user.save();
  await EmailVerification.deleteOne({ email }).catch(() => {});

  const church = user.churchId ? await Church.findById(user.churchId).catch(() => null) : null;
  const token = signToken({
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    churchId: user.churchId,
    isPlatformAdmin: user.isPlatformAdmin,
  });
  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, role: user.role, isPlatformAdmin: !!user.isPlatformAdmin },
    church: church ? { id: church.id, name: church.name, slug: church.slug } : null,
  });
});

async function uniqueSlug(name) {
  const base = slugify(name) || "church";
  let slug = base;
  let n = 2;
  // Small collision space in practice (church names rarely collide
  // exactly), so a simple retry loop is plenty — no need for anything
  // fancier than "keep appending -2, -3, ...".
  // eslint-disable-next-line no-await-in-loop
  while (await Church.findOne({ slug })) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

// POST /api/churches/signup
// { churchName, adminName, username, email, password, phone?, latitude?, longitude?, radiusMeters? }
// Creates the Church AND its first admin User together — in ONE step, all
// fields at once, unlike the twenty-first round's now-superseded two-step
// "verify your email, then see the rest of the form" flow. The account is
// created immediately but with emailVerified: false, and a 6-digit code is
// auto-sent to confirm it. No token is issued here — the admin can't
// actually sign in (see the new emailVerified check in routes/auth.js's
// /login) until /churches/verify-signup-code below confirms that code.
router.post("/churches/signup", signupLimiter, async (req, res) => {
  const churchName = String(req.body?.churchName || "").trim();
  const adminName = String(req.body?.adminName || "").trim();
  const username = String(req.body?.username || "").trim().toLowerCase();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim();
  const password = String(req.body?.password || "");
  const latitude = req.body?.latitude === undefined || req.body?.latitude === "" ? null : Number(req.body.latitude);
  const longitude =
    req.body?.longitude === undefined || req.body?.longitude === "" ? null : Number(req.body.longitude);
  const radiusMeters =
    req.body?.radiusMeters === undefined || req.body?.radiusMeters === "" ? 200 : Number(req.body.radiusMeters);

  const errors = [];
  if (!churchName) errors.push("Church name is required.");
  if (!adminName) errors.push("Your name is required.");
  if (!username || username.length < 3) errors.push("Username must be at least 3 characters.");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Enter a valid email address.");
  if (!password || password.length < 8) errors.push("Password must be at least 8 characters.");
  if (latitude !== null && !Number.isFinite(latitude)) errors.push("Latitude must be a number.");
  if (longitude !== null && !Number.isFinite(longitude)) errors.push("Longitude must be a number.");
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) errors.push("Check-in radius must be a positive number.");
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const existingUsername = await User.findOne({ username });
  if (existingUsername) {
    return res.status(400).json({ error: "That username is already taken — pick another." });
  }
  const existingEmail = await User.findOne({ email });
  if (existingEmail) {
    return res.status(400).json({ error: "That email already has an account — sign in instead." });
  }

  const slug = await uniqueSlug(churchName);

  const church = await Church.create({
    name: churchName,
    slug,
    phone: phone || null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    radiusMeters,
  });

  let admin;
  try {
    admin = await User.create({
      name: adminName,
      username,
      email,
      emailVerified: false,
      passwordHash: await bcrypt.hash(password, 10),
      role: "admin",
      churchId: church.id,
    });
  } catch (err) {
    // Someone else took the username in the moment between our check above
    // and this insert — clean up the church we just created rather than
    // leaving an orphaned, admin-less tenant behind.
    await Church.findByIdAndDelete(church.id).catch(() => {});
    if (err.code === 11000) {
      const field = err.keyPattern && err.keyPattern.email ? "email" : "username";
      return res.status(400).json({
        error: field === "email" ? "That email already has an account — sign in instead." : "That username is already taken — pick another.",
      });
    }
    throw err;
  }

  let emailSendFailed = false;
  try {
    await issueAndSendVerificationCode(email);
  } catch (err) {
    console.error("Failed to send signup verification email:", err.message);
    emailSendFailed = true;
  }

  res.status(201).json({
    requiresVerification: true,
    email: admin.email,
    emailSendFailed,
    message: emailSendFailed
      ? "Your account was created, but we couldn't send a verification email — tap \"Resend code\" to try again."
      : "Check your email for a 6-digit code to finish signing in.",
  });
});

// GET /api/churches/:slug — PUBLIC, minimal. Powers the /venue/[slug] page
// header ("Checking in at {Church Name}") and lets it fail gracefully (a
// clear "we don't recognize this link" message) before asking for GPS
// permission or a name search. Deliberately returns nothing sensitive — no
// GPS coordinates, no member data, just a display name.
router.get("/churches/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const church = await Church.findOne({ slug, active: true });
  if (!church) return res.status(404).json({ error: "We don't recognize that check-in link." });
  res.json({ church: { name: church.name, slug: church.slug } });
});

// NOTE: deliberately NOT `router.use(requireAuth)` here. This router is
// mounted at the broad, shared "/api" prefix (alongside attendance.js,
// venue.js) — an unconditional router-wide `use()` would intercept every
// OTHER public route that happens to be checked after this router in the
// app's middleware chain (member lookup, venue-verify, /c/[token]
// check-in, etc.), rejecting them with 401 before they ever reach their
// real handler. requireAuth/requireAdmin are applied per-route below
// instead, exactly where they're actually needed.

function serializeSettings(c) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    phone: c.phone,
    latitude: c.latitude,
    longitude: c.longitude,
    radiusMeters: c.radiusMeters,
  };
}

// GET/PATCH /api/church/settings — admin-only. Replaces the old
// CHURCH_LATITUDE/CHURCH_LONGITUDE/CHURCH_CHECKIN_RADIUS_METERS env vars —
// each church now sets its own from here instead of a platform operator
// setting one value for everyone.
router.get("/church/settings", requireAuth, requireAdmin, async (req, res) => {
  const church = await Church.findById(req.user.churchId).catch(() => null);
  if (!church) return res.status(404).json({ error: "Church not found." });
  res.json({ church: serializeSettings(church) });
});

router.patch("/church/settings", requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Church name is required." });
  const phone = req.body?.phone === undefined ? undefined : String(req.body.phone || "").trim();

  const latitude = req.body?.latitude === "" || req.body?.latitude === null ? null : Number(req.body?.latitude);
  const longitude = req.body?.longitude === "" || req.body?.longitude === null ? null : Number(req.body?.longitude);
  const radiusMeters = req.body?.radiusMeters === undefined ? undefined : Number(req.body.radiusMeters);

  const errors = [];
  if (latitude !== null && !Number.isFinite(latitude)) errors.push("Latitude must be a number.");
  if (longitude !== null && !Number.isFinite(longitude)) errors.push("Longitude must be a number.");
  if (radiusMeters !== undefined && (!Number.isFinite(radiusMeters) || radiusMeters <= 0)) {
    errors.push("Check-in radius must be a positive number.");
  }
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const update = { name, latitude, longitude };
  if (radiusMeters !== undefined) update.radiusMeters = radiusMeters;
  if (phone !== undefined) update.phone = phone || null;

  const church = await Church.findByIdAndUpdate(req.user.churchId, update, { new: true }).catch(() => null);
  if (!church) return res.status(404).json({ error: "Church not found." });
  res.json({ church: serializeSettings(church) });
});

module.exports = router;

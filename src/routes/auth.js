const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const Church = require("../models/Church");
const { signToken, requireAuth } = require("../middleware/auth");
const { sendPasswordResetEmail } = require("../lib/mailer");

const router = express.Router();

router.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Enter your username and password." });
  }

  const user = await User.findOne({ username });
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  // A brand-new signup is created with emailVerified: false and stays that
  // way until the 6-digit code from routes/churches.js is confirmed —
  // correct credentials alone aren't enough to sign in yet. `email` is
  // included so the frontend can offer an inline "enter your code" form
  // without the person having to remember/retype it.
  if (user.emailVerified === false) {
    return res.status(403).json({
      error: "Please verify your email before signing in — check your inbox for the code.",
      requiresVerification: true,
      email: user.email,
    });
  }

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
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      isPlatformAdmin: !!user.isPlatformAdmin,
    },
  });
});

// Tokens are stateless JWTs, so there's nothing to invalidate server-side —
// the frontend just discards the token. This endpoint exists mainly so the
// client has a consistent "logout" call to make.
router.post("/logout", (req, res) => {
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  // A platform admin has no churchId, so there's no church to look up.
  const [church, user] = await Promise.all([
    req.user.churchId ? Church.findById(req.user.churchId).catch(() => null) : null,
    User.findById(req.user.id).catch(() => null),
  ]);
  res.json({
    user: { ...req.user, churchName: church ? church.name : null, email: user ? user.email : null },
  });
});

// --- Password reset ---------------------------------------------------
// There's no usher/admin invite flow in this app yet, so this is currently
// used by church admins (and the platform admin, if they ever set an
// email). Requires an email on file (see routes/churches.js signup, and
// PATCH /profile below for accounts created before email was collected).

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reset requests from this device — please try again later." },
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// FRONTEND_URL can list more than one origin (production + localhost for
// local dev) — an email needs exactly one real link, so the first
// configured origin is treated as the canonical one.
function appUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
}

// POST /api/auth/forgot-password { email }
// Always responds with the same generic message whether or not the email
// is on file — this avoids leaking which emails have Linkpii Church Management accounts.
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter your email address." });

  const generic = { ok: true, message: "If that email is on an account, we've sent a reset link." };

  const user = await User.findOne({ email });
  if (!user) return res.json(generic);

  const rawToken = crypto.randomBytes(32).toString("hex");
  user.resetTokenHash = hashToken(rawToken);
  user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await user.save();

  const resetUrl = `${appUrl()}/reset-password?token=${rawToken}`;
  try {
    await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });
  } catch (err) {
    // Don't leak send failures to the client (same generic response either
    // way, so this never becomes an account-enumeration channel) — but DO
    // log it, since a silently-broken RESEND_API_KEY would otherwise look
    // like success forever.
    console.error("Failed to send password reset email:", err.message);
  }
  res.json(generic);
});

// POST /api/auth/reset-password { token, password }
router.post("/reset-password", async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (!token) return res.status(400).json({ error: "Missing reset token." });
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const user = await User.findOne({
    resetTokenHash: hashToken(token),
    resetTokenExpires: { $gt: new Date() },
  });
  if (!user) {
    return res.status(400).json({ error: "That reset link is invalid or has expired — request a new one." });
  }

  user.passwordHash = await bcrypt.hash(password, 10);
  user.resetTokenHash = null;
  user.resetTokenExpires = null;
  await user.save();

  res.json({ ok: true });
});

// --- Account profile (own email) ---------------------------------------
// Deliberately separate from /api/church/settings (admin-only, about the
// CHURCH) — this is any signed-in user's OWN email, since it's where
// their password-reset link goes. Lets accounts created before email was
// collected (every account that existed before this round) add one.

router.get("/profile", requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.json({ user: { id: user.id, name: user.name, username: user.username, email: user.email } });
});

router.patch("/profile", requireAuth, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: "Account not found." });

  user.email = email;
  try {
    await user.save();
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "That email is already in use on another account." });
    }
    throw err;
  }

  res.json({ user: { id: user.id, name: user.name, username: user.username, email: user.email } });
});

module.exports = router;

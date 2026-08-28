const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const Church = require("../models/Church");
const User = require("../models/User");
const { signToken, requireAuth, requireAdmin } = require("../middleware/auth");
const { slugify } = require("../lib/utils");

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
// { churchName, adminName, username, password, latitude?, longitude?, radiusMeters? }
// Creates the Church AND its first admin User together, then signs the
// admin straight in (returns a token) — a normal SaaS-signup shape, not a
// two-step "create church, then separately create a login" flow.
router.post("/churches/signup", signupLimiter, async (req, res) => {
  const churchName = String(req.body?.churchName || "").trim();
  const adminName = String(req.body?.adminName || "").trim();
  const username = String(req.body?.username || "").trim().toLowerCase();
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
  if (!password || password.length < 8) errors.push("Password must be at least 8 characters.");
  if (latitude !== null && !Number.isFinite(latitude)) errors.push("Latitude must be a number.");
  if (longitude !== null && !Number.isFinite(longitude)) errors.push("Longitude must be a number.");
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) errors.push("Check-in radius must be a positive number.");
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const existingUsername = await User.findOne({ username });
  if (existingUsername) {
    return res.status(400).json({ error: "That username is already taken — pick another." });
  }

  const slug = await uniqueSlug(churchName);

  const church = await Church.create({
    name: churchName,
    slug,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    radiusMeters,
  });

  let admin;
  try {
    admin = await User.create({
      name: adminName,
      username,
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
      return res.status(400).json({ error: "That username is already taken — pick another." });
    }
    throw err;
  }

  const token = signToken({ id: admin.id, name: admin.name, username: admin.username, role: admin.role, churchId: church.id });
  res.status(201).json({
    token,
    user: { id: admin.id, name: admin.name, username: admin.username, role: admin.role },
    church: { id: church.id, name: church.name, slug: church.slug },
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

  const church = await Church.findByIdAndUpdate(req.user.churchId, update, { new: true }).catch(() => null);
  if (!church) return res.status(404).json({ error: "Church not found." });
  res.json({ church: serializeSettings(church) });
});

module.exports = router;

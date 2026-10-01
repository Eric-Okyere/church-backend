const jwt = require("jsonwebtoken");

function requireEnvSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not set — see .env.example.");
  }
  return process.env.JWT_SECRET;
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      churchId: user.churchId,
      // False/absent for every ordinary church user; true only for a
      // platform-admin account created via `npm run seed:platform-admin`.
      isPlatformAdmin: !!user.isPlatformAdmin,
    },
    requireEnvSecret(),
    { expiresIn: "30d" }
  );
}

// Signed with a DIFFERENT key (derived from JWT_SECRET, not JWT_SECRET
// itself) so a venue token can never be verified by requireAuth below, even
// by accident — the two token types are cryptographically distinct, not
// just distinguished by a claim someone could try to forge. A venue token
// only ever proves "this is the member who passed the venue self-check-in's
// location + phone verification a moment ago" — nothing more.
function venueSecret() {
  return `${requireEnvSecret()}|venue`;
}

function signVenueToken(memberId) {
  return jwt.sign({ sub: memberId, purpose: "venue" }, venueSecret(), { expiresIn: "15m" });
}

// Returns the memberId it was issued for, or throws if invalid/expired.
function verifyVenueToken(token) {
  const payload = jwt.verify(token, venueSecret());
  if (payload.purpose !== "venue") throw new Error("wrong token purpose");
  return payload.sub;
}

// Verifies the Bearer token and attaches { id, name, username, role,
// churchId, isPlatformAdmin } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not signed in." });
  }
  try {
    const payload = jwt.verify(token, requireEnvSecret());
    // A token minted before multi-tenancy (or otherwise missing its church)
    // can't be scoped to anything — treat it as invalid rather than letting
    // it fall through with an undefined churchId, which would silently
    // match no rows (fail-closed, not fail-open). A platform-admin token is
    // the one deliberate exception: it has no churchId by design, so it's
    // accepted on isPlatformAdmin alone.
    if (!payload.churchId && !payload.isPlatformAdmin) {
      return res.status(401).json({ error: "Your session has expired — please sign in again." });
    }
    req.user = {
      id: payload.sub,
      name: payload.name,
      username: payload.username,
      role: payload.role,
      churchId: payload.churchId || null,
      isPlatformAdmin: !!payload.isPlatformAdmin,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Your session has expired — please sign in again." });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admins only." });
  }
  next();
}

// Gates the cross-church /api/platform/* routes. Deliberately separate from
// requireAdmin above — a platform admin is not a church's role:"admin",
// and an ordinary church admin must never pass this check.
function requirePlatformAdmin(req, res, next) {
  if (!req.user?.isPlatformAdmin) {
    return res.status(403).json({ error: "Platform admins only." });
  }
  next();
}

module.exports = {
  signToken,
  requireAuth,
  requireAdmin,
  requirePlatformAdmin,
  signVenueToken,
  verifyVenueToken,
};

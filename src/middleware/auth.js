const jwt = require("jsonwebtoken");

function requireEnvSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not set — see .env.example.");
  }
  return process.env.JWT_SECRET;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, username: user.username, role: user.role },
    requireEnvSecret(),
    { expiresIn: "30d" }
  );
}

// Verifies the Bearer token and attaches { id, name, username, role } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not signed in." });
  }
  try {
    const payload = jwt.verify(token, requireEnvSecret());
    req.user = {
      id: payload.sub,
      name: payload.name,
      username: payload.username,
      role: payload.role,
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

module.exports = { signToken, requireAuth, requireAdmin };

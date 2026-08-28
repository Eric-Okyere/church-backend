const crypto = require("crypto");

function newQrToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Turns a church name into a URL-safe slug for its public self-check-in
// link (FRONTEND_URL/venue/<slug>) — lowercase, alphanumerics and hyphens
// only, no leading/trailing/doubled hyphens.
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

module.exports = { newQrToken, todayIso, slugify };

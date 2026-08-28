const mongoose = require("mongoose");

// One tenant of the platform. Every other collection (User, Member, Child,
// Service, Attendance) carries a churchId pointing back here, and every
// authenticated route filters by req.user.churchId — this is the single
// data-isolation boundary the whole multi-tenant model rests on: a church
// only ever sees rows with its own churchId, never another church's.
const churchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // URL-safe identifier used in the public self-check-in link
  // (FRONTEND_URL/venue/<slug>) and in admin-facing "your venue link" UI.
  // Never used for authorization by itself — it's a routing key, not a
  // secret — but must be unique so two churches never collide on one link.
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },

  // The church's own coordinates + how far (in meters) a member's phone is
  // allowed to be from them for venue self-check-in to succeed. Replaces
  // the old single-tenant CHURCH_LATITUDE/CHURCH_LONGITUDE/
  // CHURCH_CHECKIN_RADIUS_METERS env vars — each church now sets its own
  // from its admin Settings page. null lat/lng means "not configured yet"
  // (venue self-check-in reports not_configured until the church sets it).
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  radiusMeters: { type: Number, default: 200 },

  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Church", churchSchema);

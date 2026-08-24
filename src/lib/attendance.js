const Member = require("../models/Member");
const Child = require("../models/Child");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const { distanceMeters } = require("./geo");
const { signVenueToken, verifyVenueToken } = require("../middleware/auth");

// The church's location and how far (in meters) a member's phone is allowed
// to be from it for the venue self-check-in to succeed. Required for
// verifyVenueMember — everything else in this file works without them.
const CHURCH_LAT = Number(process.env.CHURCH_LATITUDE);
const CHURCH_LNG = Number(process.env.CHURCH_LONGITUDE);
const CHURCH_RADIUS_METERS = Number(process.env.CHURCH_CHECKIN_RADIUS_METERS) || 200;

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

// Compares phone numbers by their last 8 digits rather than requiring an
// exact string match — tolerant of spaces/dashes and of a member typing
// "024..." while the record on file has "+233 24..." (or vice versa),
// which is the single biggest source of false "identity mismatch"
// rejections in practice. Still requires both numbers be at least 8 digits,
// which is enough entropy to not be reasonably guessable.
function phonesMatch(a, b) {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  const TAIL = 8;
  if (da.length < TAIL || db.length < TAIL) return false;
  return da.slice(-TAIL) === db.slice(-TAIL);
}

async function getActiveService() {
  return Service.findOne({ status: "active" });
}

// Shared by every check-in path: catches the duplicate-key error from the
// partial unique indexes (serviceId+memberId, serviceId+childId) as a
// graceful "already checked in" rather than a 500, in case of a race
// between two near-simultaneous check-ins of the same person.
async function insertAttendance(doc) {
  try {
    await Attendance.create(doc);
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // duplicate — already checked in
    throw err;
  }
}

// Shared "does this person already have an attendance row for this service,
// otherwise insert one" logic, used by every check-in path regardless of
// whether it's a member or a child, or how they got here (QR, manual,
// venue). `who` is { memberId } or { childId } — exactly one is set.
async function recordCheckIn(service, name, method, who, extra = {}) {
  const filter = { serviceId: service.id, ...who };
  const existing = await Attendance.findOne(filter);
  if (existing) {
    return { ok: true, alreadyIn: true, memberName: name, serviceId: service.id, serviceName: service.name };
  }

  const inserted = await insertAttendance({ serviceId: service.id, method, ...who, ...extra });
  return { ok: true, alreadyIn: !inserted, memberName: name, serviceId: service.id, serviceName: service.name };
}

// Looks a QR token up across BOTH members and children — a child's personal
// QR code works everywhere a member's does (kiosk scan, or opening the
// /c/[token] link directly), since a young child obviously can't go through
// the venue self-check-in's phone-number identity check themselves.
async function checkInByToken(qrToken) {
  const service = await getActiveService();
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await Member.findOne({ qrToken });
  if (member) {
    if (!member.active) return { ok: false, reason: "inactive_member" };
    return recordCheckIn(service, member.name, "qr", { memberId: member.id });
  }

  const child = await Child.findOne({ qrToken });
  if (child) {
    if (!child.active) return { ok: false, reason: "inactive_member" };
    return recordCheckIn(service, child.name, "qr", { childId: child.id });
  }

  return { ok: false, reason: "invalid_token" };
}

// Admin/usher manual check-in from the dashboard — exactly one of memberId /
// childId is provided. This is the one path with no restriction on *whose*
// attendance can be recorded, which is intentional: it requires an
// authenticated admin/usher session (enforced by requireAuth on the route),
// and only an admin/usher is allowed to check in someone other than
// themselves or their own children.
async function checkInPersonManually({ memberId, childId, serviceId }) {
  const service = await Service.findById(serviceId);
  if (!service) return { ok: false, reason: "no_active_service" };

  if (memberId) {
    const member = await Member.findById(memberId).catch(() => null);
    if (!member) return { ok: false, reason: "invalid_token" };
    return recordCheckIn(service, member.name, "manual", { memberId: member.id });
  }

  const child = await Child.findById(childId).catch(() => null);
  if (!child) return { ok: false, reason: "invalid_token" };
  return recordCheckIn(service, child.name, "manual", { childId: child.id });
}

async function checkInVisitor(serviceId, visitorName, visitorPhone) {
  await Attendance.create({
    serviceId,
    visitorName,
    visitorPhone: visitorPhone || null,
    method: "visitor",
  });
}

// --- Venue self-check-in (the posted QR code members scan on-site) -------
//
// A member here has no account/login, so two things stand in for one:
//   1. Their phone's GPS must place them within CHURCH_RADIUS_METERS of the
//      church — checked first, before touching any member-specific data.
//   2. They must type the full phone number already on file for themselves
//      — proves it's actually them.
// Passing both mints a short-lived venue token (see middleware/auth.js —
// signed with a DIFFERENT key derived from JWT_SECRET, so it can never be
// used to authenticate as an admin/usher even if someone tried it against
// an admin-only route) scoped to exactly that member. Every subsequent
// action in this venue session — checking the member in, checking in one of
// their children — requires that token and is restricted to that one
// member and that member's own registered children. There is no way to
// check in an unrelated member through this flow: identity is verified
// once, and everything after is scoped to who was verified, not to
// whatever memberId/childId happens to be in the request body.
async function verifyVenueMember(memberId, phone, lat, lng) {
  if (!Number.isFinite(CHURCH_LAT) || !Number.isFinite(CHURCH_LNG)) {
    return { ok: false, reason: "not_configured" };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: "invalid_location" };
  }
  if (distanceMeters(CHURCH_LAT, CHURCH_LNG, lat, lng) > CHURCH_RADIUS_METERS) {
    return { ok: false, reason: "out_of_range" };
  }

  const service = await getActiveService();
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await Member.findById(memberId).catch(() => null);
  if (!member) return { ok: false, reason: "invalid_member" };
  if (!member.active) return { ok: false, reason: "inactive_member" };
  if (!phonesMatch(phone, member.phone)) return { ok: false, reason: "identity_mismatch" };

  const children = await Child.find({ parentMemberId: member.id, active: true }).sort({ name: 1 });

  return {
    ok: true,
    venueToken: signVenueToken(member.id),
    member: { id: member.id, name: member.name },
    children: children.map((c) => ({ id: c.id, name: c.name })),
  };
}

function resolveVenueMemberId(venueToken) {
  try {
    return verifyVenueToken(venueToken);
  } catch {
    return null;
  }
}

async function checkInSelfAtVenue(venueToken, lat, lng) {
  const memberId = resolveVenueMemberId(venueToken);
  if (!memberId) return { ok: false, reason: "session_expired" };

  const service = await getActiveService();
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await Member.findById(memberId).catch(() => null);
  if (!member || !member.active) return { ok: false, reason: "invalid_member" };

  const location = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  return recordCheckIn(service, member.name, "venue", { memberId: member.id }, location && { location });
}

// Only checks in a child whose parentMemberId matches the member the venue
// token was issued to — this is the enforcement point for "a parent can
// check in their children, not anyone else's".
async function checkInChildAtVenue(venueToken, childId, lat, lng) {
  const memberId = resolveVenueMemberId(venueToken);
  if (!memberId) return { ok: false, reason: "session_expired" };

  const service = await getActiveService();
  if (!service) return { ok: false, reason: "no_active_service" };

  const child = await Child.findById(childId).catch(() => null);
  if (!child) return { ok: false, reason: "invalid_member" };
  if (String(child.parentMemberId) !== String(memberId)) return { ok: false, reason: "not_your_child" };
  if (!child.active) return { ok: false, reason: "inactive_member" };

  const location = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  return recordCheckIn(service, child.name, "venue", { childId: child.id }, location && { location });
}

module.exports = {
  checkInByToken,
  checkInPersonManually,
  checkInVisitor,
  verifyVenueMember,
  checkInSelfAtVenue,
  checkInChildAtVenue,
  getActiveService,
};

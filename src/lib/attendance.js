const Member = require("../models/Member");
const Child = require("../models/Child");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const Church = require("../models/Church");
const { distanceMeters } = require("./geo");
const { signVenueToken, verifyVenueToken } = require("../middleware/auth");

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

// "The active service" only ever means "the active service for THIS
// church" — multiple churches can each have one running at the same time,
// so churchId is required here, never optional.
async function getActiveService(churchId) {
  return Service.findOne({ status: "active", churchId });
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

  const inserted = await insertAttendance({
    serviceId: service.id,
    churchId: service.churchId,
    method,
    ...who,
    ...extra,
  });
  return { ok: true, alreadyIn: !inserted, memberName: name, serviceId: service.id, serviceName: service.name };
}

// Looks a QR token up across BOTH members and children — a child's personal
// QR code works everywhere a member's does (kiosk scan, or opening the
// /c/[token] link directly), since a young child obviously can't go through
// the venue self-check-in's phone-number identity check themselves.
//
// `expectedChurchId`, when given, restricts the lookup to that church —
// used by the admin-authenticated kiosk scan so it can never resolve a
// token belonging to a different church (even though qrTokens are random
// and globally unique in practice, this is the defense-in-depth check that
// makes it structurally impossible, not just unlikely). The public
// /c/[token] page (no login, just the personal QR itself) omits it — the
// token IS the credential there, and the church is derived FROM whichever
// record it resolves to, not asserted up front.
async function checkInByToken(qrToken, expectedChurchId) {
  const memberFilter = expectedChurchId ? { qrToken, churchId: expectedChurchId } : { qrToken };
  const member = await Member.findOne(memberFilter);
  if (member) {
    if (!member.active) return { ok: false, reason: "inactive_member" };
    const service = await getActiveService(member.churchId);
    if (!service) return { ok: false, reason: "no_active_service" };
    return recordCheckIn(service, member.name, "qr", { memberId: member.id });
  }

  const childFilter = expectedChurchId ? { qrToken, churchId: expectedChurchId } : { qrToken };
  const child = await Child.findOne(childFilter);
  if (child) {
    if (!child.active) return { ok: false, reason: "inactive_member" };
    const service = await getActiveService(child.churchId);
    if (!service) return { ok: false, reason: "no_active_service" };
    return recordCheckIn(service, child.name, "qr", { childId: child.id });
  }

  return { ok: false, reason: "invalid_token" };
}

// Admin/usher manual check-in from the dashboard — exactly one of memberId /
// childId is provided. This is the one path with no restriction on *whose*
// attendance can be recorded, which is intentional: it requires an
// authenticated admin/usher session (enforced by requireAuth on the route),
// and only an admin/usher is allowed to check in someone other than
// themselves or their own children. `churchId` (the admin's own) is
// required and re-verified against the service/member/child here — never
// trust that the memberId/childId/serviceId the client sent actually
// belongs to the caller's church.
async function checkInPersonManually({ memberId, childId, serviceId }, churchId) {
  const service = await Service.findById(serviceId).catch(() => null);
  if (!service || String(service.churchId) !== String(churchId)) return { ok: false, reason: "no_active_service" };

  if (memberId) {
    const member = await Member.findById(memberId).catch(() => null);
    if (!member || String(member.churchId) !== String(churchId)) return { ok: false, reason: "invalid_token" };
    return recordCheckIn(service, member.name, "manual", { memberId: member.id });
  }

  const child = await Child.findById(childId).catch(() => null);
  if (!child || String(child.churchId) !== String(churchId)) return { ok: false, reason: "invalid_token" };
  return recordCheckIn(service, child.name, "manual", { childId: child.id });
}

async function checkInVisitor(serviceId, visitorName, visitorPhone, churchId) {
  const service = await Service.findById(serviceId).catch(() => null);
  if (!service || String(service.churchId) !== String(churchId)) {
    throw Object.assign(new Error("Service not found."), { status: 404 });
  }
  await Attendance.create({
    serviceId,
    churchId,
    visitorName,
    visitorPhone: visitorPhone || null,
    method: "visitor",
  });
}

// --- Venue self-check-in (the posted QR code members scan on-site) -------
//
// A member here has no account/login, so two things stand in for one:
//   1. Their phone's GPS must place them within their OWN CHURCH's
//      configured radius of that church's coordinates (set by that
//      church's admin on the Settings page, not a global env var — each
//      church has its own) — checked before touching phone data.
//   2. They must type the full phone number already on file for themselves
//      — proves it's actually them.
// Passing both mints a short-lived venue token (see middleware/auth.js —
// signed with a DIFFERENT key derived from JWT_SECRET, so it can never be
// used to authenticate as an admin/usher even if someone tried it against
// an admin-only route) scoped to exactly that member. Every subsequent
// action in this venue session — checking the member in, checking in one of
// their children — requires that token and is restricted to that one
// member and that member's own registered children. There is no way to
// check in an unrelated member (of this church OR any other church)
// through this flow: identity is verified once, and everything after is
// scoped to who was verified, not to whatever memberId/childId happens to
// be in the request body.
async function verifyVenueMember(memberId, phone, lat, lng) {
  const member = await Member.findById(memberId).catch(() => null);
  if (!member) return { ok: false, reason: "invalid_member" };
  if (!member.active) return { ok: false, reason: "inactive_member" };

  const church = await Church.findById(member.churchId).catch(() => null);
  if (!church || !Number.isFinite(church.latitude) || !Number.isFinite(church.longitude)) {
    return { ok: false, reason: "not_configured" };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: "invalid_location" };
  }
  const radius = Number.isFinite(church.radiusMeters) && church.radiusMeters > 0 ? church.radiusMeters : 200;
  if (distanceMeters(church.latitude, church.longitude, lat, lng) > radius) {
    return { ok: false, reason: "out_of_range" };
  }

  const service = await getActiveService(member.churchId);
  if (!service) return { ok: false, reason: "no_active_service" };

  if (!phonesMatch(phone, member.phone)) return { ok: false, reason: "identity_mismatch" };

  const children = await Child.find({ parentMemberId: member.id, churchId: member.churchId, active: true }).sort({
    name: 1,
  });

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

  const member = await Member.findById(memberId).catch(() => null);
  if (!member || !member.active) return { ok: false, reason: "invalid_member" };

  const service = await getActiveService(member.churchId);
  if (!service) return { ok: false, reason: "no_active_service" };

  const location = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  return recordCheckIn(service, member.name, "venue", { memberId: member.id }, location && { location });
}

// Only checks in a child whose parentMemberId matches the member the venue
// token was issued to — this is the enforcement point for "a parent can
// check in their children, not anyone else's" (and, transitively, never a
// child from a different church, since a child's parentMemberId can only
// ever point to a member of its own church).
async function checkInChildAtVenue(venueToken, childId, lat, lng) {
  const memberId = resolveVenueMemberId(venueToken);
  if (!memberId) return { ok: false, reason: "session_expired" };

  const child = await Child.findById(childId).catch(() => null);
  if (!child) return { ok: false, reason: "invalid_member" };
  if (String(child.parentMemberId) !== String(memberId)) return { ok: false, reason: "not_your_child" };
  if (!child.active) return { ok: false, reason: "inactive_member" };

  const service = await getActiveService(child.churchId);
  if (!service) return { ok: false, reason: "no_active_service" };

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

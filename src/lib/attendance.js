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

// Finds the one active member in `churchId` whose phone number matches
// (by the same tolerant last-8-digit comparison used everywhere else),
// scoped to that church so a phone number can never resolve to a member of
// a different church. Loads only phone+name+_id — this runs on every venue
// self-check-in attempt, so it stays cheap even for a large congregation.
//
// Deliberately does NOT try to narrow the DB query with a regex on the
// phone field first — an earlier version did (`phone: { $regex: tail+'$' }`),
// but that's anchored on the raw stored string, so any formatting in a
// member's saved phone number (a space, a dash, a "+233" prefix instead of
// a leading 0) could make the last 8 CHARACTERS of the string not equal the
// last 8 DIGITS, silently excluding a real match before phonesMatch() ever
// got a chance to run its tolerant comparison. Filtering every active
// member of the church in JS is a little more work per request, but it's
// correct regardless of how phone numbers happen to be formatted in the
// database, and a single church's active-member count is small enough that
// this is still cheap.
async function findMemberByPhoneInChurch(churchId, phone) {
  const digits = normalizePhone(phone);
  if (digits.length < 8) return null;
  const candidates = await Member.find({ churchId, active: true }).select("_id name phone");
  return candidates.find((m) => phonesMatch(phone, m.phone)) || null;
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
// `checkedInBy`, when given (`{ id, name }` of the signed-in admin/usher),
// is recorded on the attendance row — see the Attendance model comment.
// Omitted entirely by every self-service path.
function checkedInByExtra(checkedInBy) {
  return checkedInBy ? { checkedInByUserId: checkedInBy.id, checkedInByName: checkedInBy.name } : {};
}

async function checkInByToken(qrToken, expectedChurchId, checkedInBy) {
  const memberFilter = expectedChurchId ? { qrToken, churchId: expectedChurchId } : { qrToken };
  const member = await Member.findOne(memberFilter);
  if (member) {
    if (!member.active) return { ok: false, reason: "inactive_member" };
    const service = await getActiveService(member.churchId);
    if (!service) return { ok: false, reason: "no_active_service" };
    return recordCheckIn(service, member.name, "qr", { memberId: member.id }, checkedInByExtra(checkedInBy));
  }

  const childFilter = expectedChurchId ? { qrToken, churchId: expectedChurchId } : { qrToken };
  const child = await Child.findOne(childFilter);
  if (child) {
    if (!child.active) return { ok: false, reason: "inactive_member" };
    const service = await getActiveService(child.churchId);
    if (!service) return { ok: false, reason: "no_active_service" };
    return recordCheckIn(service, child.name, "qr", { childId: child.id }, checkedInByExtra(checkedInBy));
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
async function checkInPersonManually({ memberId, childId, serviceId }, churchId, checkedInBy) {
  const service = await Service.findById(serviceId).catch(() => null);
  if (!service || String(service.churchId) !== String(churchId)) return { ok: false, reason: "no_active_service" };

  if (memberId) {
    const member = await Member.findById(memberId).catch(() => null);
    if (!member || String(member.churchId) !== String(churchId)) return { ok: false, reason: "invalid_token" };
    return recordCheckIn(service, member.name, "manual", { memberId: member.id }, checkedInByExtra(checkedInBy));
  }

  const child = await Child.findById(childId).catch(() => null);
  if (!child || String(child.churchId) !== String(churchId)) return { ok: false, reason: "invalid_token" };
  return recordCheckIn(service, child.name, "manual", { childId: child.id }, checkedInByExtra(checkedInBy));
}

async function checkInVisitor(serviceId, visitorName, visitorPhone, churchId, checkedInBy) {
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
    ...checkedInByExtra(checkedInBy),
  });
}

// --- Venue self-check-in for a first-time visitor (not yet a member) -----
//
// A visitor scanning the posted QR code has no phone number on file to
// verify against — that's the whole point, they're not registered yet.
// Same on-site geofence requirement as the member flow (checked BEFORE
// touching anything else, same as everywhere else in this file), but no
// identity check beyond that: they simply state their name (required) and
// phone (optional, so an usher can follow up if they're interested in
// joining) themselves. `checkedInByUserId`/`checkedInByName` are correctly
// left unset here — this is a self-service path, not an usher acting on
// someone's behalf.
async function checkInVisitorAtVenue(churchId, name, phone, lat, lng) {
  const church = await Church.findById(churchId).catch(() => null);
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

  const service = await getActiveService(church.id);
  if (!service) return { ok: false, reason: "no_active_service" };

  const trimmedName = String(name || "").trim();
  if (!trimmedName) return { ok: false, reason: "invalid_request" };
  const trimmedPhone = phone ? String(phone).trim() : null;

  await Attendance.create({
    serviceId: service.id,
    churchId: church.id,
    visitorName: trimmedName,
    visitorPhone: trimmedPhone,
    method: "visitor",
    location: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined,
  });

  return { ok: true, alreadyIn: false, memberName: trimmedName, serviceId: service.id, serviceName: service.name };
}

// --- Venue self-check-in (the posted QR code members scan on-site) -------
//
// A member here has no account/login, so their phone number IS how they
// identify themselves — there's no separate "search for your name first"
// step, both because it's one less thing to type on a phone at the door,
// and because it means the page never shows a stranger a list of member
// names to browse. Two things stand in for a login:
//   1. Their phone's GPS must place them within their OWN CHURCH's
//      configured radius of that church's coordinates (set by that
//      church's admin on the Settings page, not a global env var — each
//      church has its own) — checked before ever touching phone/member
//      data, so a bad phone number can't be used to probe whether it's
//      registered at all without also being on-site.
//   2. Their phone number must match a member already on file *at this
//      specific church* — churchId (resolved server-side from the /venue/
//      <slug> link's slug, never client-asserted) scopes the lookup so the
//      same phone number can never resolve to a member of a different
//      church.
// Passing both mints a short-lived venue token (see middleware/auth.js —
// signed with a DIFFERENT key derived from JWT_SECRET, so it can never be
// used to authenticate as an admin/usher even if someone tried it against
// an admin-only route) scoped to exactly that member. Every subsequent
// action in this venue session — checking the member in, checking in one of
// their children — requires that token and is restricted to that one
// member and that member's own registered children.
async function verifyVenueMember(churchId, phone, lat, lng) {
  const church = await Church.findById(churchId).catch(() => null);
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

  const service = await getActiveService(church.id);
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await findMemberByPhoneInChurch(church.id, phone);
  if (!member) return { ok: false, reason: "not_found" };

  const children = await Child.find({ parentMemberId: member.id, churchId: church.id, active: true }).sort({
    name: 1,
  });

  return {
    ok: true,
    venueToken: signVenueToken(member.id),
    member: { id: member.id, name: member.name },
    children: children.map((c) => ({ id: c.id, name: c.name })),
  };
}

// --- Admin/usher on-premises check ---------------------------------------
//
// Reuses the exact same coordinates + radius a church already sets on its
// Settings page for venue self-check-in (Church.latitude/longitude/
// radiusMeters) — there's only ever one "the church's premises" per church,
// not a separate value for members vs. staff. Called before every admin/
// usher action that records someone's attendance (QR kiosk scan, manual
// check-in, the personal-QR link, adding a walk-in visitor).
//
// A church that hasn't configured GPS yet (both null — the schema default)
// is deliberately left UNENFORCED rather than locked out: there's nothing
// to check the admin's phone against, and failing closed the moment this
// ships would break check-in for every church that hasn't visited Settings
// yet. Once a church sets its coordinates, this starts enforcing
// immediately for that church, same as venue self-check-in already does.
async function verifyAdminAtChurch(churchId, lat, lng) {
  const church = await Church.findById(churchId).catch(() => null);
  if (!church || !Number.isFinite(church.latitude) || !Number.isFinite(church.longitude)) {
    return { ok: true, enforced: false };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: "location_required" };
  }
  const radius = Number.isFinite(church.radiusMeters) && church.radiusMeters > 0 ? church.radiusMeters : 200;
  const distance = distanceMeters(church.latitude, church.longitude, lat, lng);
  if (distance > radius) {
    return { ok: false, reason: "out_of_range", distanceMeters: Math.round(distance) };
  }
  return { ok: true, enforced: true };
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
  checkInVisitorAtVenue,
  verifyVenueMember,
  checkInSelfAtVenue,
  checkInChildAtVenue,
  getActiveService,
  verifyAdminAtChurch,
};

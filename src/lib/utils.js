const crypto = require("crypto");

function newQrToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { newQrToken, todayIso };

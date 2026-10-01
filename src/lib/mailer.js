const { Resend } = require("resend");

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is not set — see .env.example.");
    }
    client = new Resend(process.env.RESEND_API_KEY);
  }
  return client;
}

// Resend's shared "onboarding@resend.dev" sender only delivers to the email
// address your OWN Resend account is registered with — fine for testing,
// but it can't email a real church. Verify a domain you control in the
// Resend dashboard (e.g. linkpiichurch.com) and set RESEND_FROM_EMAIL to an
// address on it once you're ready to send to anyone besides yourself.
const FROM = process.env.RESEND_FROM_EMAIL || "Linkpii Church Management <onboarding@resend.dev>";

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  const resend = getClient();
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: "Reset your Linkpii Church Management password",
    html: `
      <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
        <h2 style="margin-bottom: 4px;">Reset your password</h2>
        <p>Hi ${escapeHtml(name || "there")},</p>
        <p>We got a request to reset the password on your Linkpii Church Management account. This link expires in 1 hour.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">
            Reset password
          </a>
        </p>
        <p style="color:#555;">If the button doesn't work, paste this link into your browser:<br />
          <span style="word-break: break-all;">${resetUrl}</span>
        </p>
        <p>If you didn't ask for this, you can safely ignore this email — your password won't change.</p>
        <p style="color:#888; font-size:12px; margin-top: 32px;">Linkpii Church Management</p>
      </div>
    `,
  });
  if (error) {
    throw new Error(error.message || "Failed to send reset email.");
  }
}

async function sendSignupVerificationCode({ to, code }) {
  const resend = getClient();
  const { error } = await resend.emails.send({
    from: FROM,
    to,
    subject: `${code} is your Linkpii Church Management verification code`,
    html: `
      <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
        <h2 style="margin-bottom: 4px;">Verify your email</h2>
        <p>Use this code to finish creating your church's Linkpii Church Management account. It expires in 10 minutes.</p>
        <p style="margin: 24px 0; font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center; background: #f4f4f6; border-radius: 8px; padding: 16px;">
          ${code}
        </p>
        <p>If you didn't start creating a Linkpii Church Management account, you can safely ignore this email.</p>
        <p style="color:#888; font-size:12px; margin-top: 32px;">Linkpii Church Management</p>
      </div>
    `,
  });
  if (error) {
    throw new Error(error.message || "Failed to send verification email.");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

module.exports = { sendPasswordResetEmail, sendSignupVerificationCode };

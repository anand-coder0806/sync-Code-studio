const nodemailer = require('nodemailer');

const buildTransport = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
};

const sendVerificationEmail = async (toEmail, verificationUrl) => {
  const transporter = buildTransport();

  // Fallback for local development when SMTP is not configured.
  if (!transporter) {
    console.log(`Verification URL for ${toEmail}: ${verificationUrl}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Verify your SyncCode account',
    text: `Please verify your account by visiting: ${verificationUrl}`,
    html: `<p>Please verify your account by clicking <a href="${verificationUrl}">this link</a>.</p>`,
  });
};

module.exports = {
  sendVerificationEmail,
};

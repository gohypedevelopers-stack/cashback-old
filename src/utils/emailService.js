const nodemailer = require('nodemailer');

// Create a transporter using SMTP settings from environment variables
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send an email using the configured SMTP transporter
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject line
 * @param {string} options.text - Plain text body
 * @param {string} options.html - HTML body
 * @returns {Promise<Object>} - Nodemailer send result
 */
const sendEmail = async ({ to, subject, text, html }) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
      html,
    });

    console.log('Email sent: %s', info.messageId);
    return info;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
};

/**
 * Send an OTP verification email
 * @param {string} email - Recipient email address
 * @param {string} otp - The 6-digit OTP code
 */
const sendOTPEmail = async (email, otp, context = 'wallet') => {
  const isVendor = context === 'vendor';
  const subject = `${otp} is your verification code`;
  const senderEmail = process.env.SMTP_USER || 'support@assuredrewards.in';
  const contextMessage = isVendor 
    ? `Use the verification code below to verify your work email for Brand Registration.`
    : `Use the verification code below to sign in to your Assured Rewards wallet.`;
  const appName = isVendor ? `Assured Rewards Vendor Portal` : `Assured Rewards`;
  const text = `Your verification code is: ${otp}. It will expire in 10 minutes.`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verification Code</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed;">
        <tr>
          <td align="center" style="padding: 40px 0;">
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 500px; background-color: #ffffff; border-radius: 24px; overflow: hidden; shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
              <!-- Header -->
              <tr>
                <td align="center" style="padding: 40px 40px 20px 40px;">
                  <div style="margin-bottom: 24px;">
                    <img src="https://assuredrewards.in/logo.png" alt="Assured Rewards" style="height: 100px; width: auto; display: block;">
                  </div>
                  <h1 style="margin: 0; color: #1e293b; font-size: 24px; font-weight: 800; letter-spacing: -0.025em;">Verify your account</h1>
                </td>
              </tr>
              
              <!-- Content -->
              <tr>
                <td style="padding: 0 40px 40px 40px; text-align: center;">
                  <p style="margin: 0 0 24px 0; color: #64748b; font-size: 16px; line-height: 24px;">
                    Hello,<br>
                    ${contextMessage}
                  </p>
                  
                  <div style="background-color: #f1f5f9; border-radius: 16px; padding: 32px; margin-bottom: 24px; border: 1px solid #e2e8f0;">
                    <div style="color: #1e293b; font-size: 36px; font-weight: 800; letter-spacing: 0.25em; font-family: 'Courier New', Courier, monospace;">
                      ${otp}
                    </div>
                  </div>
                  
                  <p style="margin: 0; color: #94a3b8; font-size: 14px; line-height: 20px;">
                    This code will expire in <span style="color: #4f46e5; font-weight: 600;">10 minutes</span>.
                    If you didn't request this code, you can safely ignore this email.
                  </p>
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="padding: 32px 40px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
                  <p style="margin: 0 0 8px 0; color: #1e293b; font-size: 14px; font-weight: 700;">${appName}</p>
                  <p style="margin: 0; color: #94a3b8; font-size: 12px;">© 2026 Assured Rewards. All rights reserved.</p>
                </td>
              </tr>
            </table>
            
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 500px; margin-top: 24px;">
              <tr>
                <td align="center">
                  <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                    Sent from ${senderEmail}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, text, html });
};

module.exports = {
  sendEmail,
  sendOTPEmail,
  transporter
};

const nodemailer = require('nodemailer');
require('dotenv').config();

const createTransporter = () => {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
};

const getAppUrl = () => {
  return process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
};

const getFromHeader = () => {
  const sender = process.env.SMTP_USER || process.env.EMAIL_USER || 'noreply@smagen.com';
  return process.env.SMTP_FROM || `SMAgen <${sender}>`;
};

// Send verification link email
const sendVerificationEmail = async (to, token, userName = 'Developer') => {
  const appUrl = getAppUrl();
  const verificationLink = `${appUrl}/api/v1/developers/verify-email?token=${token}`;
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`[MAIL SERVICE - SIMULATION] Email verification for ${to}`);
    console.log(`[MAIL SERVICE - SIMULATION] Link: ${verificationLink}`);
    console.log(`[MAIL SERVICE - SIMULATION] Token: ${token}`);
    return { simulated: true, verificationLink, token };
  }

  return transporter.sendMail({
    from: getFromHeader(),
    to,
    subject: 'Confirm your email address - SMAgen',
    html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        .container {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          border: 1px solid #e1e1e1;
          border-radius: 10px;
        }
        .header { text-align: center; padding-bottom: 20px; }
        .button-container { text-align: center; margin: 30px 0; }
        .button {
          background-color: #4F46E5;
          color: white !important;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 5px;
          font-weight: bold;
          display: inline-block;
        }
        .footer { font-size: 12px; color: #888; text-align: center; margin-top: 30px; }
        .link-alt { word-break: break-all; font-size: 11px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Welcome to SMAgen!</h2>
        </div>
        <p>Hi <strong>${userName}</strong>,</p>
        <p>Thanks for signing up! Please confirm your email address to activate your account and get started.</p>
        
        <div class="button-container">
          <a href="${verificationLink}" class="button">Verify Email Address</a>
        </div>
        
        <p>This link will <strong>expire in 24 hours</strong>. If you did not create an account, no further action is required.</p>
        
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} SMAgen AI Platform. All rights reserved.</p>
          <p class="link-alt">If the button doesn't work, copy and paste this link into your browser:<br>
          ${verificationLink}</p>
        </div>
      </div>
    </body>
    </html>
    `,
  });
};

// Send OTP email
const sendOTPEmail = async (to, otp, userName = 'User') => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`[MAIL SERVICE - SIMULATION] OTP for ${to}: ${otp}`);
    return { simulated: true, otp };
  }

  return transporter.sendMail({
    from: getFromHeader(),
    to,
    subject: 'Your Password Reset Code - SMAgen',
    html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        .container { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; border-radius: 10px; }
        .header { text-align: center; color: #4F46E5; }
        .otp-box { 
          background-color: #f3f4f6; 
          border: 2px dashed #4F46E5; 
          border-radius: 8px; 
          padding: 20px; 
          text-align: center; 
          margin: 20px 0;
          font-size: 32px;
          font-weight: bold;
          letter-spacing: 5px;
          color: #111827;
        }
        .footer { font-size: 12px; color: #888; text-align: center; margin-top: 30px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Password Reset Request</h1>
        </div>
        <h4>Hi <strong>${userName}</strong>,</h4>
        <p>You requested to reset your password. This code is valid for <strong>15 minutes</strong>.</p>
        
        <div class="otp-box">
          ${otp}
        </div>
        
        <p>If you did not request this, please ignore this email or contact support if you have concerns.</p>
        
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} SMAgen AI Platform. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
    `,
  });
};

// Send password reset link email
const sendResetLinkEmail = async (to, token, userName = 'User') => {
  const appUrl = getAppUrl();
  const resetLink = `${appUrl}/api/v1/developer/auth/verify-reset-password?token=${token}`;
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`[MAIL SERVICE - SIMULATION] Reset link for ${to}: ${resetLink}`);
    return { simulated: true, resetLink, token };
  }

  return transporter.sendMail({
    from: getFromHeader(),
    to,
    subject: 'Reset your password - SMAgen',
    html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        .container {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          border: 1px solid #e1e1e1;
          border-radius: 10px;
        }
        .header { text-align: center; padding-bottom: 20px; }
        .button-container { text-align: center; margin: 30px 0; }
        .button {
          background-color: #4F46E5;
          color: white !important;
          padding: 12px 24px;
          text-decoration: none;
          border-radius: 5px;
          font-weight: bold;
          display: inline-block;
        }
        .footer { font-size: 12px; color: #888; text-align: center; margin-top: 30px; }
        .link-alt { word-break: break-all; font-size: 11px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="color: #4F46E5;">Password Reset Request</h2>
        </div>
        <p>Hello <strong>${userName}</strong>,</p>
        <p>We received a request to reset the password for your account. Click the button below to choose a new password:</p>
        
        <div class="button-container">
          <a href="${resetLink}" class="button">Reset Password</a>
        </div>
        
        <p>This secure link will <strong>expire in 15 minutes</strong>. If you did not make this request, your password will remain secure and you can safely ignore this message.</p>
        
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} SMAgen AI Platform. All rights reserved.</p>
          <p class="link-alt">Trouble with the button? Copy and paste this URL into your browser:<br>
          ${resetLink}</p>
        </div>
      </div>
    </body>
    </html>
    `,
  });
};

// Send password reset success alert
const sendPasswordResetSuccessEmail = async (to, userName = 'User') => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`[MAIL SERVICE - SIMULATION] Password reset success alert for ${to}`);
    return { simulated: true };
  }

  return transporter.sendMail({
    from: getFromHeader(),
    to,
    subject: 'Security Notice: Password Changed Successfully - SMAgen',
    html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        .container {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
          border: 1px solid #e1e1e1;
          border-radius: 10px;
        }
        .header { text-align: center; padding-bottom: 20px; color: #10B981; }
        .footer { font-size: 12px; color: #888; text-align: center; margin-top: 30px; }
        .warning-box {
          background-color: #FEF2F2;
          border-left: 4px solid #EF4444;
          padding: 15px;
          margin-top: 20px;
          border-radius: 4px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Password Updated Successfully</h2>
        </div>
        <p>Hello <strong>${userName}</strong>,</p>
        <p>This is a confirmation notice that the password for your account has been successfully changed.</p>
        <p>You can now use your new password to log in to your dashboard.</p>
        
        <div class="warning-box">
          <strong style="color: #991B1B;">Didn't do this?</strong>
          <p style="margin: 5px 0 0 0; color: #7F1D1D; font-size: 14px;">
            If you did not make this change, please contact your System Administrator immediately to freeze your account.
          </p>
        </div>
        
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} SMAgen AI Platform. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
    `,
  });
};

module.exports = {
  sendVerificationEmail,
  sendOTPEmail,
  sendResetLinkEmail,
  sendPasswordResetSuccessEmail,
};

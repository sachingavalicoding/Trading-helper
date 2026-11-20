import nodemailer from 'nodemailer';

/** Sends mail through the SMTP account in the server settings (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM). Not set up: `enabled` is false and nothing is sent. */
export class Mailer {
  constructor({ host = '', port = 465, user = '', pass = '', from = '' } = {}, transportFactory = nodemailer.createTransport) {
    this.cfg = { host, port, user, pass, from: from || user };
    this.enabled = Boolean(host && user && pass);
    this.make = transportFactory;
  }

  async send({ to, subject, text, attachments = [] }) {
    if (!this.enabled) throw new Error('Email is not set up on the server (SMTP_USER and SMTP_PASS are missing)');
    const { host, port, user, pass, from } = this.cfg;
    const transport = this.make({ host, port, secure: port === 465, auth: { user, pass } });
    return transport.sendMail({ from, to, subject, text, attachments });
  }
}

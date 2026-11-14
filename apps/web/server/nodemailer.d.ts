// Minimal types for the parts of nodemailer that TallyMed uses (the full @types package pulls a large optional dev tree).
declare module 'nodemailer' {
  export interface TransportOptions {
    host: string;
    port: number;
    secure: boolean;
    requireTLS?: boolean;
    ignoreTLS?: boolean;
    name?: string;
    auth?: { user: string; pass: string };
    tls?: { servername?: string; minVersion?: string; rejectUnauthorized?: boolean };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
    disableFileAccess?: boolean;
    disableUrlAccess?: boolean;
    logger?: boolean;
    debug?: boolean;
  }
  export interface MailOptions {
    from: { name: string; address: string };
    to: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }
  export interface SentInfo { messageId?: string; accepted?: unknown[]; rejected?: unknown[] }
  export interface Transporter {
    sendMail(options: MailOptions): Promise<SentInfo>;
    close(): void;
  }
  export function createTransport(options: TransportOptions): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}

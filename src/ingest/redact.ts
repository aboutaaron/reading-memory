const HEADER_RE = /^(to|cc|bcc|from|reply-to|list-unsubscribe|unsubscribe|delivered-to|return-path):.*$/gim;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TOKEN_RE = /(unsubscribe|token|signature|sig|utm_[a-z]+|fbclid)=([^&\s]+)/gi;

export function redactText(input: string): string {
  return input
    .replace(HEADER_RE, '$1: [redacted]')
    .replace(EMAIL_RE, '[email-redacted]')
    .replace(TOKEN_RE, '$1=[redacted]');
}

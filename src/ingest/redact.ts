const HEADER_RE = /^(to|cc|bcc|from|reply-to|list-unsubscribe|unsubscribe|delivered-to|return-path):.*$/gim;
const TOKEN_RE = /(unsubscribe|token|signature|sig|utm_[a-z]+|fbclid)=([^&\s]+)/gi;

export function redactText(input: string): string {
  const withoutHeaders = input.replace(HEADER_RE, '$1: [redacted]');
  return redactEmails(withoutHeaders)
    .replace(TOKEN_RE, '$1=[redacted]');
}

// Scan around each @ once. An unanchored greedy email regexp repeatedly scans
// long non-email words and becomes quadratic on bounded-but-large sources.
function redactEmails(input: string): string {
  const chunks: string[] = [];
  let copiedThrough = 0;
  for (let at = input.indexOf('@'); at !== -1; at = input.indexOf('@', at + 1)) {
    let start = at;
    while (start > copiedThrough && isLocal(input.charCodeAt(start - 1))) start--;
    if (start === at) continue;
    let domainEnd = at + 1;
    while (domainEnd < input.length && isDomain(input.charCodeAt(domainEnd))) domainEnd++;
    let emailEnd = -1;
    for (let dot = domainEnd - 1; dot > at + 1; dot--) {
      if (input.charCodeAt(dot) !== 46 || !isLetter(input.charCodeAt(dot + 1)) || !isLetter(input.charCodeAt(dot + 2))) continue;
      emailEnd = dot + 3;
      while (emailEnd < domainEnd && isLetter(input.charCodeAt(emailEnd))) emailEnd++;
      break;
    }
    if (emailEnd === -1) continue;
    chunks.push(input.slice(copiedThrough, start), '[email-redacted]');
    copiedThrough = emailEnd;
  }
  return chunks.length ? chunks.join('') + input.slice(copiedThrough) : input;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDomain(code: number): boolean {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 46 || code === 45;
}

function isLocal(code: number): boolean {
  return isDomain(code) || code === 95 || code === 37 || code === 43;
}

// Response headers for pages and static files. public/_headers carries the same values for Cloudflare
// (a test keeps the two in step). The CSP starts in report-only mode: it has not been run against the
// live Google Maps scripts yet, so violations show in the browser console instead of breaking the game.
// Once the console is clean, rename it to Content-Security-Policy.

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://*.googleusercontent.com https://*.ggpht.com",
  "connect-src 'self' https://maps.googleapis.com",
  'worker-src blob:',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'content-security-policy-report-only': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
};

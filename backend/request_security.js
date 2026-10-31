'use strict';

function requestSecurityError(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return '';
  if (/^\/tebex\/webhook\//.test(req.path)) return '';
  // Host API tokens are accepted only by the dedicated host provisioning
  // endpoint. A blanket exemption would let a stolen token bypass the
  // browser CSRF/origin gate on every mutating panel route.
  if (req.path === '/host/provision') {
    const authorization = String(req.headers.authorization || '');
    if (/^Bearer\s+\S+$/i.test(authorization) || req.headers['x-nexuspanel-token']) return '';
  }

  if (req.headers['x-nexuspanel-request'] !== '1') return 'Request verification failed.';

  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return 'Cross-site request blocked.';

  const origin = String(req.headers.origin || '');
  if (origin) {
    let originValue;
    try {
      originValue = new URL(origin).origin;
    } catch {
      return 'Cross-site request blocked.';
    }
    const host = typeof req.get === 'function' ? req.get('host') : req.headers.host;
    const requestOrigin = `${req.protocol || 'http'}://${host}`;
    let requestOriginValue;
    try {
      requestOriginValue = new URL(requestOrigin).origin;
    } catch {
      return 'Cross-site request blocked.';
    }
    if (originValue !== requestOriginValue) return 'Cross-site request blocked.';
  }
  return '';
}

module.exports = { requestSecurityError };

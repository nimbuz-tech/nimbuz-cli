/** Decodes (without verifying) a JWT payload. Returns null when not a JWT. */
export function decodeJwt(token) {
  if (!token) return null;
  const raw = String(token).replace(/^bearer\s+/i, "");
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function tokenClaims(token) {
  const payload = decodeJwt(token) || {};
  const props = payload.properties || {};
  return {
    raw: payload,
    userId: props.nimbuzUserId || payload.id || payload.sub,
    accountId: props.nimbuzAccountId,
    org: payload.owner,
    username: payload.name,
    displayName: payload.displayName,
    email: payload.email,
    expiresAt: payload.exp ? new Date(payload.exp * 1000) : null
  };
}

export function isExpired(token, skewSeconds = 30) {
  const payload = decodeJwt(token);
  if (!payload?.exp) return false;
  return payload.exp * 1000 <= Date.now() + skewSeconds * 1000;
}

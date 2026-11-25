import { oidc, password, type OAuthMethod, type OAuthTokens } from "onebase/auth";

// How people sign in, set by the server operator in .env (read once at startup):
//
//   SELF_SIGNUP=on       anyone may create a password account (born "pending", sees nothing until a
//                        workspace admin activates it). Off by default: the admin adds employees.
//   SSO_ISSUER=…         single sign-on with the organization's directory over OpenID Connect
//                        (Microsoft Entra ID, AD FS, Keycloak in front of AD/LDAP, Okta, …).
//   SSO_CLIENT_ID=…  SSO_CLIENT_SECRET=…  SSO_NAME=«الدخول بحساب الجهة»  SSO_SCOPES="openid email profile"
//   SSO_TRUST_EMAIL=on   the directory's email addresses are the organization's own, so a first SSO
//                        sign-in joins the account the admin made for that address (default on).
//   PASSWORD_LOGIN=off   with SSO set, hide passwords entirely.
//
// An account that first signs in through SSO without one made ahead is "pending" (no status field
// = pending, see access.ts) until an admin activates it, like a password sign-up.

const env = process.env;
const on = (v: string | undefined, fallback: boolean) => (v === undefined || v === "" ? fallback : /^(on|true|1|yes)$/i.test(v));

// The profile hook only copies a display name; the status is fixed here, never taken from the client.
const displayName = (value: unknown) => (typeof value === "string" && value.trim() ? { name: value.trim().slice(0, 100) } : {});

/** The ID token's claims. It came straight from the token endpoint over TLS, which OpenID Connect
 * Core §3.1.3.7 accepts in place of checking its signature; issuer and audience are still checked. */
function idTokenClaims(tokens: OAuthTokens, issuer: string, clientId: string): Record<string, any> {
  const raw = typeof tokens.id_token === "string" ? tokens.id_token : "";
  const part = raw.split(".")[1];
  if (!part) return {};
  let claims: Record<string, any>;
  try {
    claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss ?? "").replace(/\/+$/, "") !== issuer || !aud.includes(clientId)) throw new Error("SSO: the ID token is for another issuer or client.");
  return claims;
}

const asEmail = (v: unknown) => (typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : undefined);

/**
 * OpenID Connect with the organization's directory. Reads the user from the userinfo endpoint and
 * the ID token together, since some directories put little in one of them (AD FS's userinfo has
 * only `sub`), and takes the user principal name as the email when there is no email claim.
 */
function ssoMethod(): OAuthMethod | null {
  const issuer = env.SSO_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer) return null;
  const clientId = env.SSO_CLIENT_ID?.trim() ?? "";
  if (!clientId) throw new Error("SSO_ISSUER is set but SSO_CLIENT_ID is not.");
  const trustEmail = on(env.SSO_TRUST_EMAIL, true);
  const method = oidc({
    id: "sso",
    name: env.SSO_NAME?.trim() || "الدخول بحساب الجهة",
    issuer,
    clientId,
    clientSecret: env.SSO_CLIENT_SECRET ?? "",
    scopes: env.SSO_SCOPES?.trim() ? env.SSO_SCOPES.trim().split(/[\s,]+/) : ["openid", "email", "profile"],
  });
  const fromUserinfo = method.profile;
  method.profile = async (tokens, callback) => {
    const claims = idTokenClaims(tokens, issuer, clientId);
    const info = await fromUserinfo(tokens, callback).catch(() => null);
    const id = String(info?.id ?? claims.sub ?? "");
    if (!id || id === "undefined") throw new Error("SSO: the directory sent no user id (sub).");
    if (info && claims.sub && String(claims.sub) !== id) throw new Error("SSO: the ID token and userinfo name different users.");
    const email = asEmail(info?.email) ?? asEmail(claims.email) ?? asEmail(claims.preferred_username) ?? asEmail(claims.upn) ?? asEmail(claims.unique_name);
    const fullName = [claims.given_name, claims.family_name].filter((s) => typeof s === "string" && s).join(" ");
    const name = info?.name || claims.name || fullName || undefined;
    const emailVerified = Boolean(email) && (trustEmail || info?.emailVerified === true || claims.email_verified === true);
    return { id, email, emailVerified, name: typeof name === "string" ? name.slice(0, 100) : undefined };
  };
  return method;
}

const sso = ssoMethod();
// Passwords stay on unless SSO is set and the operator turned them off: never zero ways in.
const passwordLogin = !sso || on(env.PASSWORD_LOGIN, true);

export default {
  methods: [
    ...(passwordLogin
      ? [password({ minLength: 8, signUp: on(env.SELF_SIGNUP, false), profile: (params) => ({ ...displayName(params.name), status: "pending" }) })]
      : []),
    ...(sso ? [sso] : []),
  ],
};

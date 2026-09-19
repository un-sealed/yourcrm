# 04 — Authentication

## Goal
Provide secure authentication that supports free SSO and self-hosting.

## Routes
- `/login`
- `/signup`
- `/forgot-password`
- `/verify-email`
- `/auth/callback/*`
- `/app/settings/authentication`

## Features
- Email/password.
- Email verification.
- Password reset.
- Google OAuth.
- OIDC.
- SAML SSO.
- TOTP 2FA.
- Passkeys.
- Session list/revoke.
- Login history.
- Workspace membership checks.
- Invitation acceptance.
- Account deactivation.
- Secure CSRF/session handling.
- Rate limiting and brute-force protection.
- Recovery flow.
- SSO domain discovery hook.

## Security
- Password hashes with modern password hashing.
- Secrets never logged.
- Short-lived OAuth state.
- Secure cookies.
- Session rotation.
- MFA recovery codes.
- Audit login/security events.

## Acceptance
A user can sign up, verify, log in, reset credentials, connect Google, and an admin can configure OIDC/SAML without bypassing workspace permissions.

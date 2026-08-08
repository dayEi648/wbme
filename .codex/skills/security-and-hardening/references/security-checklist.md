# Security Checklist (Quick Reference)

Condensed checklist for web application security. For detailed patterns and code examples, see the main `security-and-hardening` skill.

## Pre-Commit Checks

- [ ] No secrets in code (`git diff --cached | grep -i "password\|secret\|api_key\|token"`)
- [ ] `.gitignore` covers: `.env`, `.env.local`, `*.pem`, `*.key`
- [ ] `.env.example` uses placeholder values (not real secrets)

## Quick Checks by Category

### Authentication
- [ ] Passwords hashed (bcrypt ≥12 rounds, scrypt, or argon2)
- [ ] Session cookies: `httpOnly`, `secure`, `sameSite: 'lax'`
- [ ] Rate limiting on login (≤10 attempts / 15 min)
- [ ] Password reset tokens: time-limited (≤1 hour), single-use

### Authorization
- [ ] Every endpoint checks authentication
- [ ] Resource ownership verified (prevent IDOR)
- [ ] Admin actions require admin role

### Input Validation
- [ ] All input validated at boundaries (allowlists, not denylists)
- [ ] String lengths constrained, numeric ranges validated
- [ ] File uploads: types restricted, sizes limited, content verified
- [ ] SQL parameterized; HTML encoded; redirect URLs validated
- [ ] Server-side URL fetches allowlisted; private IPs blocked (SSRF)

### Security Headers
```
Content-Security-Policy: default-src 'self'; script-src 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### CORS
```typescript
// Restrictive (recommended)
cors({ origin: ['https://yourdomain.com'], credentials: true });
// NEVER: cors({ origin: '*' })
```

### Data Protection
- [ ] Sensitive fields excluded from API responses
- [ ] Sensitive data not logged
- [ ] HTTPS for all external communication

### Dependency Security
- [ ] Lockfile committed; CI uses `npm ci`
- [ ] New dependencies reviewed (maintenance, downloads, `postinstall` scripts)
- [ ] Watch for typosquats

### Error Handling
```typescript
// Production: generic error, no internals exposed
res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
// NEVER expose: err.message, err.stack, err.sql
```

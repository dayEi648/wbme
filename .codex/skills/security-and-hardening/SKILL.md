---
name: security-and-hardening
description: Hardens code against vulnerabilities. Use when handling user input, authentication, data storage, or external integrations — building any feature that accepts untrusted data, manages user sessions, or interacts with third-party services.
---

# Security and Hardening

## Overview

Security-first development: treat every external input as hostile, every secret as sacred, every authorization check as mandatory. Security isn't a phase — it's a constraint on every line that touches user data, authentication, or external systems.

## Process: Threat Model First

Before hardening, spend five minutes thinking like an attacker:

1. **Map trust boundaries.** Where does untrusted data enter? HTTP requests, form fields, file uploads, webhooks, third-party APIs, message queues, LLM output. Every boundary is attack surface.
2. **Name the assets.** What's worth stealing? Credentials, PII, payment data, admin actions.
3. **Run STRIDE over each boundary:**

| Threat | Ask | Typical mitigation |
|---|---|---|
| **S**poofing | Can someone impersonate a user/service? | Authentication, signature verification |
| **T**ampering | Can data be altered in transit/at rest? | Integrity checks, parameterized queries, HTTPS |
| **R**epudiation | Can an action be denied later? | Audit logging of security events |
| **I**nformation disclosure | Can data leak? | Encryption, field allowlists, generic errors |
| **D**enial of service | Can it be overwhelmed? | Rate limiting, input size caps, timeouts |
| **E**levation of privilege | Can a user gain unauthorized rights? | Authorization checks, least privilege |

4. **Write abuse cases next to use cases.** For each feature, ask "how would I misuse this?" — make that your first test.

If you can't name the trust boundaries, you're not ready to secure it (OWASP A04: Insecure Design).

## The Three-Tier Boundary System

### Always Do (No Exceptions)

- Validate all external input at the system boundary
- Parameterize all database queries — never concatenate user input into SQL
- Encode output to prevent XSS (use framework auto-escaping)
- Use HTTPS for all external communication
- Hash passwords with bcrypt/scrypt/argon2 (never plaintext)
- Set security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- Use httpOnly, secure, sameSite cookies for sessions
- Run `npm audit` before every release

### Ask First (Requires Human Approval)

- New authentication flows or auth logic changes
- Storing new categories of sensitive data (PII, payment info)
- New external service integrations
- Changing CORS configuration
- Adding file upload handlers
- Modifying rate limiting or throttling
- Granting elevated permissions or roles

### Never Do

- Never commit secrets to version control
- Never log sensitive data (passwords, tokens, full CC numbers)
- Never trust client-side validation as a security boundary
- Never disable security headers for convenience
- Never use `eval()` or `innerHTML` with user-provided data
- Never store auth tokens in localStorage
- Never expose stack traces or internal error details to users

## OWASP Top 10 Prevention Patterns

### Injection (SQL, NoSQL, OS Command)

```typescript
// BAD: SQL injection
const query = `SELECT * FROM users WHERE id = '${userId}'`;

// GOOD: Parameterized query
const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

// GOOD: ORM
const user = await prisma.user.findUnique({ where: { id: userId } });
```

### Broken Authentication

```typescript
import { hash, compare } from 'bcrypt';
const SALT_ROUNDS = 12;
const hashedPassword = await hash(plaintext, SALT_ROUNDS);

app.use(session({
  secret: process.env.SESSION_SECRET,  // From env, not code
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
}));
```

### Cross-Site Scripting (XSS)

```typescript
// BAD: element.innerHTML = userInput;
// GOOD: React auto-escapes — <div>{userInput}</div>
// If you MUST render HTML: import DOMPurify; const clean = DOMPurify.sanitize(userInput);
```

### Broken Access Control

```typescript
app.patch('/api/tasks/:id', authenticate, async (req, res) => {
  const task = await taskService.findById(req.params.id);
  if (task.ownerId !== req.user.id) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized' } });
  }
  const updated = await taskService.update(req.params.id, req.body);
  return res.json(updated);
});
```

### Security Misconfiguration

```typescript
import helmet from 'helmet';
app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'] },
}));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:3000' }));
```

### Sensitive Data Exposure

```typescript
function sanitizeUser(user: UserRecord): PublicUser {
  const { passwordHash, resetToken, ...publicFields } = user;
  return publicFields;
}
const API_KEY = process.env.STRIPE_API_KEY;  // Never hardcode
```

### Server-Side Request Forgery (SSRF)

Any server-side URL fetch the user influences (webhooks, link previews, image proxies) can target internal services.

```typescript
import ipaddr from 'ipaddr.js';

async function assertSafeUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('https only');
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error('host not allowed');
  const addrs = await lookup(url.hostname, { all: true });
  if (addrs.some((a) => ipaddr.parse(a.address).range() !== 'unicast')) {
    throw new Error('private/reserved IP');  // Blocks 169.254.169.254 + all private ranges
  }
  return url;
}
await fetch(await assertSafeUrl(req.body.webhookUrl), { redirect: 'error' });
```

**Caveat:** TOCTOU gap exists — `fetch` re-resolves DNS. For high-risk surfaces, resolve once and connect to the pinned IP, or use a filtering agent.

## Input Validation

### Schema Validation at Boundaries

```typescript
import { z } from 'zod';

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

app.post('/api/tasks', async (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: result.error.flatten() } });
  }
  const task = await taskService.create(result.data);  // Typed and validated
  return res.status(201).json(task);
});
```

### File Upload Safety

```typescript
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function validateUpload(file: UploadedFile) {
  if (!ALLOWED_TYPES.includes(file.mimetype)) throw new ValidationError('File type not allowed');
  if (file.size > MAX_SIZE) throw new ValidationError('File too large');
  // Don't trust file extension — check magic bytes if critical
}
```

## Triaging npm audit Results

```
npm audit reports a vulnerability
├── Severity: critical or high
│   ├── Reachable in your app? → Fix immediately (update, patch, replace)
│   └── Dev-only / unreachable? → Fix soon, not a blocker
├── Severity: moderate
│   ├── Reachable in production? → Fix next release cycle
│   └── Dev-only? → Track in backlog
└── Severity: low → Fix during regular dependency updates
```

When deferring, document the reason and set a review date.

### Supply-Chain Hygiene

- Commit the lockfile; CI installs with `npm ci` — reproducible builds, no silent drift
- Review new dependencies: maintenance, downloads, `postinstall` scripts (they run arbitrary code)
- Watch for typosquats: `cross-env` vs `crossenv`, `react-dom` vs `reactdom`

## Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));  // Stricter for auth
```

## Secrets Management

```
.env files:
  ├── .env.example  → Committed (template with placeholders)
  ├── .env          → NOT committed (real secrets)
  └── .env.local    → NOT committed (local overrides)

.gitignore: .env, .env.local, .env.*.local, *.pem, *.key
```

**Pre-commit check:** `git diff --cached | grep -i "password\|secret\|api_key\|token"`

**If a secret is ever committed, rotate it.** Assume compromise the moment it reaches a remote. Revoke and reissue first, then purge from history.

## Securing AI / LLM Features

Map to [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/):

- **LLM05: Treat all model output as untrusted.** Never pass LLM output into `eval`, SQL, shell, `innerHTML`, or file paths. Validate and encode like raw user input.
- **LLM01: Assume prompts can be hijacked.** The system prompt is not a security boundary. Enforce permissions in code.
- **LLM02 / LLM07: Keep secrets out of prompts.** Anything in context can be echoed back. No API keys, cross-tenant data, or full system prompts where the model can repeat them.
- **LLM06: Constrain tool permissions.** Scope to minimum; require confirmation for destructive actions; validate every tool argument.
- **LLM10: Bound consumption.** Cap tokens, request rate, and loop/recursion depth.
- **LLM08: Isolate retrieval data.** In RAG, partition embeddings per tenant; validate documents before indexing.

```typescript
// BAD: model output as command or markup
await db.query(await llm.generate(`Write SQL for: ${userQuestion}`));  // Arbitrary query
container.innerHTML = await llm.reply(userMessage);                     // Stored XSS via model

// GOOD: parse defensively, validate, encode
let intent;
try {
  intent = CommandSchema.parse(JSON.parse(await llm.replyJson(userMessage)));
} catch { throw new ValidationError('unexpected model output'); }
await runAllowlistedAction(intent.action, intent.params);
container.textContent = await llm.reply(userMessage);
```

## Security Review Checklist

For a condensed pre-merge checklist covering authentication, authorization, input validation, data protection, and supply chain, see `references/security-checklist.md`.

## OWASP Top 10 Quick Reference

| # | Vulnerability | Prevention |
|---|---|---|
| 1 | Broken Access Control | Auth checks on every endpoint, ownership verification |
| 2 | Cryptographic Failures | HTTPS, strong hashing, no secrets in code |
| 3 | Injection | Parameterized queries, input validation |
| 4 | Insecure Design | Threat modeling, spec-driven development |
| 5 | Security Misconfiguration | Security headers, minimal permissions, audit deps |
| 6 | Vulnerable Components | `npm audit`, keep deps updated, minimal deps |
| 7 | Auth Failures | Strong passwords, rate limiting, session management |
| 8 | Data Integrity Failures | Verify updates/dependencies, signed artifacts |
| 9 | Logging Failures | Log security events, don't log secrets |
| 10 | SSRF | Validate/allowlist URLs, restrict outbound requests |

## OWASP Top 10 for LLMs Quick Reference

| ID | Risk | Prevention |
|---|---|---|
| LLM01 | Prompt Injection | Permissions in code, not system prompt |
| LLM02 | Sensitive Info Disclosure | Keep secrets/PII out of prompts; filter outputs |
| LLM03 | Supply Chain | Vet models, datasets, plugins |
| LLM04 | Data & Model Poisoning | Trusted sources; vet fine-tuning and RAG data |
| LLM05 | Improper Output Handling | Treat output as untrusted; validate, encode |
| LLM06 | Excessive Agency | Scope tools; confirm destructive actions |
| LLM07 | System Prompt Leakage | Assume it can leak; put no secrets in it |
| LLM08 | Vector/Embedding Weaknesses | Partition per tenant; validate before indexing |
| LLM09 | Misinformation | Ground with citations; human in the loop |
| LLM10 | Unbounded Consumption | Cap tokens, rate, recursion depth |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It's an internal tool, security doesn't matter" | Internal tools get compromised. Attackers target the weakest link. |
| "We'll add security later" | Retrofitting is 10x harder. Build it in now. |
| "No one would try to exploit this" | Automated scanners will find it. |
| "The framework handles security" | Frameworks provide tools, not guarantees. |
| "It's just a prototype" | Prototypes become production. Habits from day one. |
| "Threat modeling is overkill" | Five minutes of "how would I attack this?" prevents unpatchable design flaws. |
| "It's just LLM output, only text" | That "text" can be SQL, a script tag, or a shell command. |

## Red Flags

- User input passed directly to database queries, shell commands, or HTML rendering
- Secrets in source code or commit history
- API endpoints without authentication or authorization checks
- CORS wildcard (`*`) origins
- No rate limiting on authentication endpoints
- Stack traces or internal errors exposed to users
- Dependencies with known critical vulnerabilities
- Server fetches user-supplied URLs without allowlist (SSRF)
- LLM output passed into a query, DOM, shell, or `eval`
- Secrets, PII, or full system prompt inside an LLM context window

## Verification

- [ ] `npm audit` shows no critical or high vulnerabilities
- [ ] No secrets in source code or git history
- [ ] All user input validated at system boundaries
- [ ] Authentication and authorization checked on every protected endpoint
- [ ] Security headers present (check with browser DevTools)
- [ ] Error responses don't expose internal details
- [ ] Rate limiting active on auth endpoints
- [ ] Server-side URL fetches validated against allowlist
- [ ] LLM output validated and encoded before use (if AI features present)

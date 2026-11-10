# Security Policy

## Dependency audit policy

This plugin has no direct runtime npm dependencies. `openclaw` is an optional peer dependency supplied by the host.

For release checks, use:

```bash
npm ci --ignore-scripts
npm run audit:runtime
npm test
npm run validate
```

`npm run audit:runtime` (`npm audit --omit=dev`) is the runtime/package gate. A full `npm run audit:all` is also kept for visibility into the development toolchain.

At the initial public repository baseline:

- runtime audit: **0 known vulnerabilities**;
- full development audit: residual findings are transitive to the pinned OpenClaw development dependency, primarily its bundled npm toolchain;
- Vitest was upgraded to 5.1.0 to remove its critical advisories;
- Zod is overridden from OpenClaw's 4.6.5 to the patched 4.6.6 release;
- no `npm audit fix --force` downgrade or major transitive override is accepted merely to make the development audit green.

The development audit is intentionally not treated as equivalent to shipped runtime exposure. Remaining findings should be re-evaluated whenever the pinned OpenClaw development version is updated.

## Secrets

Never commit a 0G Router API key, wallet/private key, OpenClaw SecretRef materialization, prompt/completion transcript containing credentials, or local secret file. Tests may use clearly marked sentinel strings that are not real credentials.

## Reporting vulnerabilities

Once the repository is public on GitHub, prefer GitHub's private security-advisory flow for vulnerabilities that could expose credentials, bypass trust/TEE policy, alter provider routing, or execute unintended code. Avoid publishing exploit details in a public issue before a fix is available.

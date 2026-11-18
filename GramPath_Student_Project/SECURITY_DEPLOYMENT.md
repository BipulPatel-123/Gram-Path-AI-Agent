# Deploying GramPath AI with Cloudflare, Helmet and rate limiting

**This document is a deployment guide, not a guarantee of security or evidence that Cloudflare is already installed.** A student hackathon demonstration should not collect Aadhaar numbers, OTPs, bank details or real certificates.

## 1. Prerequisites
- A server/VPS with a persistent disk, Python 3.10+, Node 22 LTS+, current security patches, and outbound internet.
- A domain managed in your Cloudflare account and `cloudflared` installed from official Cloudflare documentation.
- Node dependencies installed via `npm ci` using the included lockfile.
- A backup plan for the SQLite database, log monitoring and periodic review of scholarship notices.

## 2. Configure the origin safely

Create `.env` from `.env.example` with:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
INTERNAL_PYTHON_PORT=8765
PYTHON_BIN=python
CLOUDFLARE_TUNNEL=true
ENABLE_ADMIN=false
```

The Node app binds to loopback only, as does the Python backend. Verify that neither port 3000 nor 8765 is publicly open via a firewall, port forwarding, or a secondary reverse proxy. Restrict host access and run the app under a non-root account. **Do not set `HOST=0.0.0.0` simply to make the app reachable from the internet.**

Start with `npm start` under a supervised service manager (systemd, Windows service, etc.).

## 3. Set up Cloudflare Tunnel

Follow Cloudflare's current [Tunnel setup documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/). A locally managed tunnel can be created and routed (exact setup may differ by platform):

```bash
cloudflared tunnel login
cloudflared tunnel create grampath-ai
cloudflared tunnel route dns grampath-ai app.example.com
```

An example `cloudflared` configuration (replace values):

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /path/to/YOUR_TUNNEL_UUID.json
ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Run the tunnel as a service under the same host. Configure TLS/HTTPS for visitors using Cloudflare. Tunnel credentials are sensitive; never commit them to GitHub. With a tunnel, the origin is reached through outbound connections instead of a public inbound listener.

**Note:** `CLOUDFLARE_TUNNEL=true` makes the app optionally use Cloudflare's client IP header *only when the immediate socket is loopback*. It does not establish the tunnel or independently authenticate Cloudflare. Only enable it if traffic is restricted to your trusted local Cloudflare Tunnel.

## 4. Cloudflare dashboard protections

- Enable appropriate WAF managed rules and security alerts on the Cloudflare dashboard.
- Create a rate-limiting rule on `/api/eligibility` (or the main `/api/` prefix), using per-source-IP counting if supported by your plan. Start with modest limits then tune for real traffic; free-plan capabilities are more limited.
- Consider Cloudflare Access with MFA for any staff-only subdomain, staging deployment or backend/admin functionality.
- Choose a safe Bot Fight setting compatible with legitimate student devices, networks and accessibility needs.
- Exclude private APIs and dynamic answers from aggressive caching; current server sets `Cache-Control: no-store` on APIs.
- Monitor blocked traffic and 429 responses so shared campus/village IP addresses are not unfairly blocked.

Cloudflare WAF configuration is **separate** from local Express rate limiting; you should use both where available.

## 5. Admin database security

The public deployment defaults to `ENABLE_ADMIN=false`. There is **no public registration / login** in this prototype, and the local development admin key is not a suitable long-term multi-user identity system. For a future real admin portal:
- Put it behind Cloudflare Access with MFA and appropriate verified identities.
- Replace the shared key with per-admin authorization and server-managed sessions (or an identity provider).
- Add tamper-resistant audit logs, approvals for rule updates and periodic backups.
- Deploy separate read-only production data workflows where possible.

For a private supervised demo (not broadly public), set `ENABLE_ADMIN=true` and a randomly generated 32+ character `GRAMPATH_ADMIN_KEY` in the server environment. Never publish it or paste it into a support chat.

## 6. Data and application security

- Maintain `source_url`, `updated_at`, scheme-specific eligibility text, and a manual verification process before publishing rules.
- Do not claim scholarship eligibility is definitive; the portal may have additional conditions, category-specific exceptions or updated deadlines.
- Add DB backups, monitoring, vulnerability scans, penetration testing and update procedures before serving real personal data.
- Avoid collecting certificates, bank identifiers, caste proof or Aadhaar without an explicit, reviewed legal/privacy basis and secure retention plan.
- SQLite is fine for a lightweight hackathon app on one persistent host. For multiple production instances, use a managed relational database and share a distributed rate-limit store such as Redis (default Express limiter counters are per process).
- Keep dependencies updated and review `npm audit`; run as a non-root user behind a network firewall.

## 7. Test these cases before launch

- Requests to `/.env`, `/server.py` and `/grampath.sqlite3` must return 404.
- Unauthorized `/api/admin/schemes` must return 403.
- `Content-Security-Policy` and other Helmet headers must appear on responses.
- Excessive `/api/eligibility` requests must eventually return 429.
- No public inbound connection can reach port 8765 or 3000 directly.
- Application still functions over HTTPS on the actual domain and never prompts for real Aadhaar, OTPs or bank details.
- Scholarship category outcomes and published deadlines are reviewed against authoritative government notices.

Official docs: https://helmetjs.github.io/ · https://express-rate-limit.mintlify.app/ · https://developers.cloudflare.com/waf/rate-limiting-rules/ · https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

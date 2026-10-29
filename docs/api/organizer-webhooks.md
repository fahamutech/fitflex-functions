# FitFlex organizer webhooks

Dormant until FitFlex switches `EVENTS_WEBHOOKS` on and sets the signing key. The event catalogue and envelope are in `organizer-api-v1.openapi.json` under `webhooks`.

## Register an endpoint

Organizer owner or admin: **Integrations → Webhooks → Add endpoint**. Rules, enforced when you register **and again before every delivery**:

* `https://` only, port 443, a DNS **name** (no IP addresses in any notation), no username or password in the URL.
* Every address the name resolves to must be public. Names that point at private, loopback, link-local, carrier-grade NAT, documentation, multicast or cloud-metadata addresses are refused (`invalid_url` with a reason). A name that later starts resolving privately fails its deliveries as `blocked_address`.
* Redirects are **never** followed: answer on the registered URL.
* FitFlex connects only to the address it validated, presents your hostname (SNI and `Host`), and validates your TLS certificate. A self-signed certificate fails.
* Egress IPs: FitFlex does not publish fixed egress addresses; allow-list by signature, not by IP.

The signing secret (`whsec_…`) is shown **once**. **Verify** the endpoint: FitFlex sends a signed `endpoint.verification` request with a `challenge`; answer `200` with JSON `{"challenge":"<same value>"}` within 10 seconds. An unverified endpoint receives nothing else. After you change the URL, or re-enable an endpoint that was switched off, the handshake runs again.

## What is sent

```
POST <your url>
Content-Type: application/json
User-Agent: FitFlex-Webhooks/1
X-FitFlex-Event-Id: obx_0123456789abcdef
X-FitFlex-Event-Type: kit.collected
X-FitFlex-Timestamp: 1800000000
X-FitFlex-Delivery-Attempt: 1
X-FitFlex-Signature: v1=<hex>[,v1=<hex>]

{"id":"obx_0123456789abcdef","type":"kit.collected","version":"1","createdAt":"2027-03-14T05:41:07.123Z","organizerId":"eorg_…","eventId":"evt_…","data":{"registrationId":"ereg_…","collectionPointId":"ecp_…","collectedAt":"…"}}
```

**No names, phone numbers, emails, amounts or tokens** are in any webhook. Fetch what your scope allows with `GET /v1/organizer/registrations/{id}`.

| Type | Meaning |
|---|---|
| `registration.created` / `registration.paid` | A paid place exists (same moment; subscribe to one) |
| `registration.cancelled` | A paid place was cancelled (`reasonCode`) |
| `registration.updated` | `changed`: `claimed`, `kit`, `bib`, … (which groups changed, never values) |
| `kit.collected`, `bib.assigned` | Venue operations |
| `event.updated`, `event.cancelled` | `changedFields` are field paths only |
| `refund.updated` | `{ orderId, eventId, scope, status: requested \| paid }`, no amounts |

Not sent to organizers: payments, tickets, and `registration.reserved` (an unpaid hold is not a registration). There is no wildcard subscription.

## Verify the signature

`signature = hex(HMAC_SHA256(secret, timestamp + "." + rawBody))`, where `rawBody` is the exact bytes received. Verify **before** parsing. Compare in constant time. Reject if `|now − timestamp| > 300` seconds. During a secret rotation the header carries two `v1=` values (new first): accept if either matches. Timestamp and signature change on every attempt; the event id does not. Delivery is **at least once**: dedupe on `X-FitFlex-Event-Id`, answer `2xx` quickly and process asynchronously. Order is not guaranteed; treat the API as truth and use `createdAt` to ignore stale events.

**Known-answer vector** (use it to test every language):

```
secret    = whsec_test_secret_for_known_answer_vector
timestamp = 1800000000
body      = {"id":"obx_0123456789abcdef","type":"kit.collected","version":"1","createdAt":"2027-03-14T05:41:07.123Z","organizerId":"eorg_1","eventId":"evt_1","data":{"registrationId":"erg_1"}}
v1        = aac48e25012eaea4e63d9f8b9b6d2ef938f392616c9ef101ff65cb2756d0b4f6
```

Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
export function verify(secrets, headers, rawBody, now = Math.floor(Date.now() / 1000)) {
  const ts = headers['x-fitflex-timestamp'];
  if (!/^\d+$/.test(ts ?? '') || Math.abs(now - Number(ts)) > 300) return false;
  const given = String(headers['x-fitflex-signature'] ?? '').split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  return secrets.some(secret => {
    const want = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    return given.some(g => g.length === want.length && timingSafeEqual(Buffer.from(g), Buffer.from(want)));
  });
}
```

Python:

```python
import hmac, hashlib, time
def verify(secrets, headers, raw_body: bytes, now=None):
    ts = headers.get("X-FitFlex-Timestamp", "")
    now = int(now if now is not None else time.time())
    if not ts.isdigit() or abs(now - int(ts)) > 300:
        return False
    given = [p[3:] for p in headers.get("X-FitFlex-Signature", "").split(",") if p.startswith("v1=")]
    for secret in secrets:
        want = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(g, want) for g in given):
            return True
    return False
```

PHP:

```php
function verify(array $secrets, array $headers, string $rawBody, ?int $now = null): bool {
    $ts = $headers['X-FitFlex-Timestamp'] ?? '';
    $now = $now ?? time();
    if (!ctype_digit($ts) || abs($now - (int)$ts) > 300) return false;
    $given = [];
    foreach (explode(',', $headers['X-FitFlex-Signature'] ?? '') as $p) if (str_starts_with($p, 'v1=')) $given[] = substr($p, 3);
    foreach ($secrets as $secret) {
        $want = hash_hmac('sha256', $ts . '.' . $rawBody, $secret);
        foreach ($given as $g) if (hash_equals($want, $g)) return true;
    }
    return false;
}
```

## Retries and failure

Any answer other than `2xx` (including `3xx`, `408`, `429`, `5xx`, a timeout, a TLS or network error) is retried after about 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours, 12 hours, then every 24 hours (±20 %), up to 10 attempts (about two to three days), then the delivery is a **dead letter** you can retry by hand (5 retries per delivery per day). `410 Gone` ends it at once and switches the endpoint off. After sustained failure (30 failed attempts in a row over 24 hours, or no success for 72 hours with at least 10 failed deliveries) the endpoint is **switched off**, the organizer's owner and admins are told, and events that happen while it is off are not sent to it; **Enable** it again (the handshake runs) and choose to send what it missed from the last 7 days. The **Delivery log** shows every attempt with the response code and a redacted excerpt of your answer; request headers and bodies are not stored.

## Test

**Send test** delivers one synthetic `<type>.test` event (`id` starts `obx_test_`, `data.test` is `true`). Ten per hour per endpoint.

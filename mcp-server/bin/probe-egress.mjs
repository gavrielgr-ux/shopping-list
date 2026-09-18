/**
 * Report whether the Realtime Database host is reachable from this machine.
 *
 * Prints two lines, so a shell caller can branch on the first and quote the second:
 *   line 1 - OK | DENIED | BLOCKED | UNREACHABLE
 *   line 2 - the host that was tried
 *
 * OK          the host answered normally
 * DENIED      the database itself refused, i.e. its security rules did
 * BLOCKED     something in between refused with a non-Firebase error, i.e. an egress policy
 * UNREACHABLE no answer at all: DNS, TLS, or a timeout
 *
 * An unauthenticated request is enough, because the question is only whether the host can be
 * reached. No credential is minted and no list is touched.
 */
import { DATABASE_URL } from "../dist/src/constants.js";

const host = new URL(DATABASE_URL).host;
let status = "UNREACHABLE";
let detail = "";

try {
  const response = await fetch(`${DATABASE_URL}/.json`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  // Any JSON-shaped answer, including an error, proves the host itself was reached.
  const fromFirebase = /^\s*[{[]/.test(body);
  if (response.ok) status = "OK";
  else if (fromFirebase) status = "DENIED";
  else status = "BLOCKED";
  detail = body.trim().slice(0, 300);
} catch (error) {
  detail = error instanceof Error ? error.message : String(error);
}

console.log(status);
console.log(host);
if (detail) console.error(detail);

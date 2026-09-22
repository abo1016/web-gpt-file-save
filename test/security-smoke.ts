import assert from "node:assert/strict";
import {
  isBlockedRemoteAddress,
  resolveSafeRemoteUrl,
  type LookupAll,
} from "../src/security.js";

assert.equal(isBlockedRemoteAddress("127.0.0.1", 4), true);
assert.equal(isBlockedRemoteAddress("169.254.169.254", 4), true);
assert.equal(isBlockedRemoteAddress("100.64.0.1", 4), true);
assert.equal(isBlockedRemoteAddress("93.184.216.34", 4), false);
assert.equal(isBlockedRemoteAddress("::1", 6), true);
assert.equal(isBlockedRemoteAddress("::ffff:127.0.0.1", 6), true);

await assert.rejects(
  () => resolveSafeRemoteUrl("https://127.0.0.1/file"),
  /Private or reserved-network/,
);
await assert.rejects(
  () => resolveSafeRemoteUrl("https://[::1]/file"),
  /Private or reserved-network/,
);

let lookupCalls = 0;
const stableLookup: LookupAll = async (hostname) => {
  assert.equal(hostname, "files.example.test");
  lookupCalls += 1;
  return lookupCalls === 1
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "127.0.0.1", family: 4 }];
};

const resolved = await resolveSafeRemoteUrl(
  "https://files.example.test/download?id=1",
  false,
  stableLookup,
);
assert.equal(lookupCalls, 1);
assert.equal(resolved.address, "93.184.216.34");
assert.equal(resolved.family, 4);
assert.equal(resolved.url.hostname, "files.example.test");

const mixedLookup: LookupAll = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "127.0.0.1", family: 4 },
];
await assert.rejects(
  () => resolveSafeRemoteUrl("https://files.example.test/file", false, mixedLookup),
  /private or reserved-network/,
);

const testLoopback = await resolveSafeRemoteUrl("http://127.0.0.1:8765/file", true);
assert.equal(testLoopback.address, "127.0.0.1");
assert.equal(testLoopback.family, 4);

console.log(JSON.stringify({
  ok: true,
  dnsResolutionPinned: true,
  mixedPublicPrivateAnswersRejected: true,
  privateAndReservedRangesBlocked: true,
}, null, 2));

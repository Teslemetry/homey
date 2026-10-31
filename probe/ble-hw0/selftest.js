'use strict';

// Offline checks for the probe's hand-built frames. No Homey, no car.
const assert = require('node:assert/strict');
const { RoutableMessage } = require('@teslemetry/tesla-protocol/command/universal_message');
const { SessionInfo } = require('@teslemetry/tesla-protocol/command/signatures');
const P = require('./lib/protocol');

// Name vector from protocol.md, section "BLE".
assert.equal(P.vinToName('5YJS0000000000000'), 'S1a87a5a75f3df858C');
assert.ok(P.nameMatchesVin('S1a87a5a75f3df858D', '5YJS0000000000000'));
assert.ok(!P.nameMatchesVin('S1a87a5a75f3df858X', '5YJS0000000000000'));

// Session-info request is 114 bytes with the length prefix (document 04, 3.3).
const { frame, routingAddress } = P.buildSessionInfoRequest();
assert.equal(frame.length, 114);
assert.equal(frame.readUInt16BE(0), 112);
const decoded = RoutableMessage.decode(frame.subarray(2));
assert.equal(decoded.toDestination.domain, 2);
assert.equal(decoded.sessionInfoRequest.publicKey.length, 65);
assert.deepEqual(Buffer.from(decoded.fromDestination.routingAddress), routingAddress);
assert.equal(P.chunk(frame, 20).length, 6);

// A key-not-on-whitelist reply, split over 20-byte notifications, reassembles and decodes.
const reply = RoutableMessage.encode(RoutableMessage.fromPartial({
  toDestination: { routingAddress },
  fromDestination: { domain: 2 },
  sessionInfo: SessionInfo.encode(SessionInfo.fromPartial({ status: 1 })).finish(),
})).finish();
const frames = [];
const buf = new P.ReassemblingBuffer((p) => frames.push(P.describeFrame(p)));
for (const part of P.chunk(Buffer.concat([P.prependLength(Buffer.from('0a021001', 'hex')), P.prependLength(reply)]), 20)) buf.receive(part);
assert.equal(frames.length, 2);
assert.equal(frames[0].kind, 'bare-vcsec');
assert.equal(frames[1].sessionInfo.status, 'SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST');
assert.equal(frames[1].toRouting, routingAddress.toString('hex'));

// UUID normalisation covers Homey's dashless form and short SIG ids.
assert.ok(P.uuidEquals('00000211-B2D1-43F0-9B88-960CEBF8B91E', P.UUIDS.service));
assert.ok(P.uuidEquals('00002a0000001000800000805f9b34fb', '2a00'));

console.log('selftest ok');

'use strict';

// Hand-built Tesla BLE framing for the HW-0 probe. No tesla-fleet-api.
// Facts from document 04, sections 3.1 to 3.5.

const crypto = require('node:crypto');
const {
  RoutableMessage,
  Domain,
} = require('@teslemetry/tesla-protocol/command/universal_message');
const {
  SessionInfo,
  sessionInfoStatusToJSON,
} = require('@teslemetry/tesla-protocol/command/signatures');
const { FromVCSECMessage } = require('@teslemetry/tesla-protocol/command/vcsec');

const UUIDS = {
  service: '00000211b2d143f09b88960cebf8b91e',
  vehicleWrite: '00000212b2d143f09b88960cebf8b91e',
  vehicleNotify: '00000213b2d143f09b88960cebf8b91e',
  version: '00000214b2d143f09b88960cebf8b91e',
  genericAccess: '1800',
  deviceName: '2a00',
};

const MAX_FRAME = 1024;
const STALE_CHUNK_MS = 1000;
const VALID_NAME = /^S[a-f0-9]{16}[CDRP]$/;

/** Homey (noble) uses lower case UUIDs with no dashes; SIG ids may be short. */
function normUuid(uuid) {
  const u = String(uuid || '').toLowerCase().replace(/-/g, '');
  const sig = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(u);
  return sig ? sig[1] : u;
}

function uuidEquals(a, b) {
  return normUuid(a) === normUuid(b);
}

function vinToName(vin) {
  return `S${crypto.createHash('sha1').update(vin, 'utf8').digest('hex').slice(0, 16)}C`;
}

/** 17-character prefix plus any suffix that passes valid_name (document 04, 3.2). */
function nameMatchesVin(advertised, vin) {
  return typeof advertised === 'string'
    && VALID_NAME.test(advertised)
    && advertised.slice(0, 17) === vinToName(vin).slice(0, 17);
}

function isTeslaName(name) {
  return typeof name === 'string' && VALID_NAME.test(name);
}

function prependLength(payload) {
  const out = Buffer.alloc(payload.length + 2);
  out.writeUInt16BE(payload.length, 0);
  Buffer.from(payload).copy(out, 2);
  return out;
}

/** A throwaway P-256 public key, uncompressed, 65 bytes. Never stored. */
function throwawayPublicKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey();
}

/** Unsigned VCSEC session-info request, length-prefixed. 114 bytes with a 65-byte key. */
function buildSessionInfoRequest({ publicKey = throwawayPublicKey(), domain = Domain.DOMAIN_VEHICLE_SECURITY } = {}) {
  const routingAddress = crypto.randomBytes(16);
  const message = RoutableMessage.fromPartial({
    toDestination: { domain },
    fromDestination: { routingAddress },
    sessionInfoRequest: { publicKey },
    uuid: crypto.randomBytes(16),
  });
  const payload = RoutableMessage.encode(message).finish();
  return { frame: prependLength(payload), routingAddress };
}

function hasKnownRoutableField(m) {
  return m.toDestination !== undefined
    || m.fromDestination !== undefined
    || m.protobufMessageAsBytes !== undefined
    || m.sessionInfoRequest !== undefined
    || m.sessionInfo !== undefined
    || m.signatureData !== undefined
    || m.signedMessageStatus !== undefined
    || m.messageFrame !== undefined
    || (m.uuid && m.uuid.length > 0)
    || (m.requestUuid && m.requestUuid.length > 0)
    || m.flags !== 0;
}

/** Decode one frame payload into a short, VIN-free description. */
function describeFrame(payload) {
  let message;
  try {
    message = RoutableMessage.decode(payload);
  } catch (error) {
    return { kind: 'undecodable', error: String(error && error.message), length: payload.length };
  }
  if (payload.length > 0 && !hasKnownRoutableField(message)) {
    try {
      const vcsec = FromVCSECMessage.decode(payload);
      const keys = Object.keys(vcsec).filter((k) => vcsec[k] !== undefined);
      if (keys.length) return { kind: 'bare-vcsec', subMessages: keys, length: payload.length };
    } catch {
      // fall through to the RoutableMessage description
    }
  }
  const out = {
    kind: 'routable',
    length: payload.length,
    fromDomain: message.fromDestination && message.fromDestination.domain,
    // Random per request, so safe to log. Replies to us carry it in toDestination.
    toRouting: message.toDestination && message.toDestination.routingAddress
      ? Buffer.from(message.toDestination.routingAddress).toString('hex')
      : null,
    signedMessageStatus: message.signedMessageStatus,
  };
  if (message.sessionInfo) {
    try {
      const info = SessionInfo.decode(message.sessionInfo);
      out.sessionInfo = {
        status: sessionInfoStatusToJSON(info.status),
        publicKeyLength: info.publicKey.length,
        epochLength: info.epoch.length,
        counter: info.counter,
        clockTime: info.clockTime,
      };
    } catch (error) {
      out.sessionInfo = { error: String(error && error.message) };
    }
  }
  if (message.protobufMessageAsBytes) {
    try {
      const vcsec = FromVCSECMessage.decode(message.protobufMessageAsBytes);
      out.vcsecSubMessages = Object.keys(vcsec).filter((k) => vcsec[k] !== undefined);
    } catch {
      out.vcsecSubMessages = ['<undecodable>'];
    }
  }
  return out;
}

/** Port of Python's ReassemblingBuffer (document 04, section 3.4). */
class ReassemblingBuffer {
  constructor(onFrame, now = () => Date.now()) {
    this.onFrame = onFrame;
    this.now = now;
    this.buffer = Buffer.alloc(0);
    this.expected = null;
    this.packetStarts = [];
    this.lastChunkAt = null;
    this.discarded = 0;
  }

  receive(chunk) {
    const now = this.now();
    if (this.buffer.length && this.lastChunkAt !== null && now - this.lastChunkAt > STALE_CHUNK_MS) {
      this.buffer = Buffer.alloc(0);
      this.expected = null;
      this.packetStarts = [];
    }
    this.lastChunkAt = now;
    this.packetStarts.push(this.buffer.length);
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    for (;;) {
      if (this.expected === null && this.buffer.length >= 2) {
        this.expected = this.buffer.readUInt16BE(0) + 2;
      }
      if (this.expected !== null && this.expected > MAX_FRAME) {
        this.discardPacket();
      } else if (this.expected !== null && this.buffer.length >= this.expected) {
        const end = this.expected;
        const payload = this.buffer.subarray(2, end);
        let decoded;
        try {
          RoutableMessage.decode(payload);
          decoded = true;
        } catch {
          decoded = false;
        }
        if (!decoded) {
          this.discardPacket();
          continue;
        }
        this.buffer = Buffer.from(this.buffer.subarray(end));
        this.packetStarts = this.packetStarts.filter((s) => s >= end).map((s) => s - end);
        this.expected = null;
        this.onFrame(Buffer.from(payload));
      } else {
        return;
      }
    }
  }

  discardPacket() {
    this.discarded += 1;
    this.packetStarts.shift();
    if (this.packetStarts.length) {
      const start = this.packetStarts[0];
      this.buffer = Buffer.from(this.buffer.subarray(start));
      this.packetStarts = this.packetStarts.map((s) => s - start);
    } else {
      this.buffer = Buffer.alloc(0);
      this.packetStarts = [];
    }
    this.expected = null;
  }
}

function chunk(buffer, size) {
  const out = [];
  for (let i = 0; i < buffer.length; i += size) out.push(buffer.subarray(i, i + size));
  return out;
}

module.exports = {
  UUIDS,
  normUuid,
  uuidEquals,
  vinToName,
  nameMatchesVin,
  isTeslaName,
  prependLength,
  buildSessionInfoRequest,
  describeFrame,
  ReassemblingBuffer,
  chunk,
};

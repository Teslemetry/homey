'use strict';

// HW-0 Homey Bluetooth probe (BLE-00). Document 06, section 4, steps 1 to 11.
// No pairing, no signed command, no change on the car. The only frame sent is an
// unsigned VCSEC session-info request with a throwaway key.
//
// Logs never carry the VIN, the BLE name, the peripheral uuid or the address.
// Peripherals are shown as a short hash so runs stay comparable.

const crypto = require('node:crypto');
const Homey = require('homey');
const P = require('./lib/protocol');

const DEFAULTS = {
  STEPS: '1-9,11',
  SCAN_RUNS: 20,
  CONNECT_RUNS: 10,
  UNSOLICITED_WINDOW_MS: 10000,
  REPLY_TIMEOUT_MS: 5000,
  WRITE_TIMEOUT_MS: 30000,
  IDLE_HOLD_MAX_MS: 300000,
  LOST_LINK_MAX_MS: 300000,
  LOST_LINK_INTERVAL_MS: 3000,
  ADV_WINDOW_MS: 1800000,
  ADV_RATE_LIMIT_MS: 0,
  FALLBACK_MAX_CANDIDATES: 5,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hashId(value) {
  if (!value) return '-';
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function parseSteps(spec) {
  const steps = new Set();
  for (const part of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b || a); i += 1) steps.add(i);
  }
  return steps;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: values.length,
    min: sorted[0],
    p50: pick(0.5),
    p90: pick(0.9),
    max: sorted[sorted.length - 1],
  };
}

function isIBeaconShaped(ad) {
  const m = ad.manufacturerData;
  return Buffer.isBuffer(m) && m.length >= 4 && m[0] === 0x4c && m[1] === 0x00 && m[2] === 0x02 && m[3] === 0x15;
}

class BleProbeApp extends Homey.App {

  async onInit() {
    const env = Homey.env || {};
    this.cfg = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (env[key] !== undefined && env[key] !== '') {
        this.cfg[key] = typeof DEFAULTS[key] === 'number' ? Number(env[key]) : env[key];
      }
    }
    this.vin = env.VIN;
    this.carState = env.CAR_STATE || 'unknown';
    this.steps = parseSteps(this.cfg.STEPS);
    this.results = { carState: this.carState, steps: {} };
    this.notifyLengths = [];

    if (!this.vin || this.vin.length !== 17) {
      this.out('config', 'VIN missing or not 17 characters in env.json. Nothing to do.');
      return;
    }
    this.out('config', {
      carState: this.carState,
      steps: [...this.steps],
      cfg: this.cfg,
      bleAdvertisementsFeature: this.hasAdvFeature(),
    });

    // Do not hold up onInit: the probe can run for half an hour.
    this.run().catch((error) => this.out('fatal', String(error && error.stack)));
  }

  async onUninit() {
    await this.dropLink();
  }

  hasAdvFeature() {
    try {
      return typeof this.homey.hasFeature === 'function' && this.homey.hasFeature('ble-advertisements');
    } catch {
      return false;
    }
  }

  out(tag, data) {
    const line = typeof data === 'string' ? data : JSON.stringify(data);
    this.log(`${new Date().toISOString()} [${tag}] ${line}`);
  }

  describeName(name) {
    if (!name) return '<none>';
    if (P.isTeslaName(name)) return P.nameMatchesVin(name, this.vin) ? `S<ours>${name.slice(-1)}` : `S<other>${name.slice(-1)}`;
    return `<non-tesla:${name.length}>`;
  }

  record(step, result) {
    this.results.steps[step] = result;
    this.out(`step${step}`, result);
  }

  async run() {
    const s = this.steps;
    if (s.has(1) || s.has(2)) await this.stepScan();
    if (!this.targetUuid) {
      this.out('stop', 'No target peripheral. Steps 3 to 11 need one. See step 2 result.');
      return this.summary();
    }
    if (s.has(3)) await this.stepConnectRepeat();
    if ([4, 5, 6, 7, 8, 9, 10].some((n) => s.has(n))) await this.openLink();
    if (this.link) {
      if (s.has(4)) this.record(4, this.link.discovery);
      if (s.has(5)) await this.stepUnsolicited();
      if (s.has(6)) await this.stepWrite(6, null);
      if (s.has(7)) await this.stepWrite(7, 20);
      if (s.has(8)) await this.stepReads();
      if (s.has(9)) await this.stepIdleHold();
      else if (s.has(10)) await this.stepLostLink();
    }
    await this.dropLink();
    if (s.has(11)) await this.stepLatencyAndAdverts();
    return this.summary();
  }

  // Steps 1 and 2: discover() runs, S-name share, and the blocker fallback.
  async stepScan() {
    const runs = [];
    let seen = 0;
    for (let i = 0; i < this.cfg.SCAN_RUNS; i += 1) {
      const t0 = Date.now();
      let ads = [];
      let error;
      try {
        ads = await this.homey.ble.discover(); // never pass a filter
      } catch (e) {
        error = String(e && e.message);
      }
      const ms = Date.now() - t0;
      const ours = ads.filter((ad) => P.nameMatchesVin(ad.localName, this.vin));
      if (ours.length) {
        seen += 1;
        this.targetUuid = this.targetUuid || ours[0].uuid;
      }
      const run = {
        run: i + 1,
        ms,
        error,
        total: ads.length,
        named: ads.filter((ad) => ad.localName).length,
        teslaNames: ads.filter((ad) => P.isTeslaName(ad.localName)).length,
        ours: ours.map((ad) => ({
          id: hashId(ad.uuid), name: this.describeName(ad.localName), connectable: ad.connectable, rssi: ad.rssi,
        })),
        ibeacons: ads.filter(isIBeaconShaped).map((ad) => ({
          id: hashId(ad.uuid), name: this.describeName(ad.localName), connectable: ad.connectable, rssi: ad.rssi,
        })),
      };
      runs.push(run);
      this.out('scan', run);
    }
    const scanMs = runs.map((r) => r.ms);
    this.record(1, {
      carState: this.carState,
      runs: runs.length,
      scanMs: stats(scanMs),
      errors: runs.filter((r) => r.error).length,
      rssiOurs: stats(runs.flatMap((r) => r.ours.map((o) => o.rssi)).filter((x) => typeof x === 'number')),
    });

    const step2 = {
      nameSeenScans: seen,
      share: `${seen}/${runs.length}`,
      pass: seen > 0,
      via: seen > 0 ? 'localName' : null,
    };
    if (!seen && this.carState === 'asleep') {
      // The fallback connects, and a link wakes the car. Run it in the awake run instead.
      step2.fallback = 'skipped: car asleep';
    } else if (!seen) {
      const fallback = await this.fallbackByService(runs);
      Object.assign(step2, { fallback, pass: !!fallback.found, via: fallback.found ? 'service-uuid' : null });
    }
    this.record(2, step2);
  }

  // Blocker path: connect to connectable iBeacon-shaped adverts and look for the Tesla service.
  // Without the name this cannot tell our car from a neighbour's; the result says so.
  async fallbackByService() {
    const ads = await this.homey.ble.discover();
    const candidates = ads
      .filter((ad) => ad.connectable && isIBeaconShaped(ad))
      .sort((a, b) => (b.rssi || -999) - (a.rssi || -999))
      .slice(0, this.cfg.FALLBACK_MAX_CANDIDATES);
    const tried = [];
    let found = null;
    for (const ad of candidates) {
      const entry = { id: hashId(ad.uuid), rssi: ad.rssi };
      const t0 = Date.now();
      let peripheral;
      try {
        peripheral = await withTimeout(ad.connect(), 20000, 'fallback connect');
        const services = await withTimeout(peripheral.discoverServices(), 10000, 'fallback discoverServices');
        entry.connectMs = Date.now() - t0;
        entry.teslaService = services.some((svc) => P.uuidEquals(svc.uuid, P.UUIDS.service));
        if (entry.teslaService && !found) found = ad.uuid;
      } catch (e) {
        entry.error = String(e && e.message);
      } finally {
        if (peripheral) await peripheral.disconnect().catch(() => undefined);
      }
      tried.push(entry);
    }
    if (found) this.targetUuid = found;
    const result = {
      candidates: candidates.length,
      tried,
      found: found ? hashId(found) : null,
      note: 'Strongest-RSSI Tesla service is assumed to be ours. Confirm only one Tesla is near the Homey.',
    };
    if (this.hasAdvFeature()) result.advertisements = await this.sampleAdverts(found || (candidates[0] && candidates[0].uuid), 30000);
    else result.advertisements = 'ble-advertisements feature not present';
    return result;
  }

  // Step 3: connect 10 times, timing find() and connect() separately.
  async stepConnectRepeat() {
    const runs = [];
    for (let i = 0; i < this.cfg.CONNECT_RUNS; i += 1) {
      const run = { run: i + 1 };
      const t0 = Date.now();
      let peripheral;
      try {
        const ad = await this.homey.ble.find(this.targetUuid);
        run.findMs = Date.now() - t0;
        run.connectable = ad.connectable;
        run.rssi = ad.rssi;
        const t1 = Date.now();
        peripheral = await withTimeout(ad.connect(), 30000, 'connect');
        run.connectMs = Date.now() - t1;
        run.ok = true;
      } catch (e) {
        run.ok = false;
        run.error = String(e && e.message);
        run.failedAfterMs = Date.now() - t0;
      } finally {
        if (peripheral) await peripheral.disconnect().catch(() => undefined);
      }
      runs.push(run);
      this.out('connect', run);
      await sleep(2000);
    }
    this.record(3, {
      ok: runs.filter((r) => r.ok).length,
      of: runs.length,
      findMs: stats(runs.map((r) => r.findMs).filter((x) => x !== undefined)),
      connectMs: stats(runs.filter((r) => r.ok).map((r) => r.connectMs)),
      errors: runs.filter((r) => !r.ok).map((r) => r.error),
    });
  }

  // Step 4 data is gathered here; step 5 subscription starts here.
  async openLink() {
    const ad = await this.homey.ble.find(this.targetUuid);
    const t0 = Date.now();
    let peripheral;
    try {
      peripheral = await withTimeout(ad.connect(), 30000, 'connect');
    } catch (e) {
      this.out('link', `connect failed: ${e && e.message}`);
      return;
    }
    const connectMs = Date.now() - t0;
    const link = {
      peripheral,
      connectMs,
      disconnectAt: null,
      frames: [],
      waiters: [],
    };
    peripheral.once('disconnect', () => {
      link.disconnectAt = Date.now();
      this.out('link', 'disconnect event fired');
    });
    try {
      const service = await peripheral.getService(P.UUIDS.service);
      const chars = await service.discoverCharacteristics();
      const byUuid = (u) => chars.find((c) => P.uuidEquals(c.uuid, u));
      link.write = byUuid(P.UUIDS.vehicleWrite);
      link.notify = byUuid(P.UUIDS.vehicleNotify);
      link.version = byUuid(P.UUIDS.version);
      link.discovery = {
        serviceFound: true,
        connectMs,
        characteristics: chars.map((c) => ({ uuid: P.normUuid(c.uuid), properties: c.properties })),
        writeFound: !!link.write,
        notifyFound: !!link.notify,
        versionFound: !!link.version,
        pass: !!(link.write && link.notify),
      };
      if (!link.write || !link.notify) throw new Error('write or notify characteristic missing');
      link.buffer = new P.ReassemblingBuffer((payload) => this.onFrame(link, payload));
      await link.notify.subscribeToNotifications((data) => {
        const now = Date.now();
        this.notifyLengths.push(data.length);
        link.lastNotifyAt = now;
        link.notifyCount = (link.notifyCount || 0) + 1;
        this.out('notify', { len: data.length });
        link.buffer.receive(data);
      });
      link.subscribedAt = Date.now();
      this.link = link;
    } catch (e) {
      link.discovery = { ...(link.discovery || { serviceFound: false }), pass: false, error: String(e && e.message) };
      if (this.steps.has(4) && !this.results.steps[4]) this.record(4, link.discovery);
      await peripheral.disconnect().catch(() => undefined);
    }
  }

  onFrame(link, payload) {
    const frame = { at: Date.now(), ...P.describeFrame(payload) };
    link.frames.push(frame);
    this.out('frame', frame);
    const { waiters } = link;
    link.waiters = [];
    for (const w of waiters) {
      if (w.match(frame)) w.resolve(frame);
      else link.waiters.push(w);
    }
  }

  waitForFrame(match, ms) {
    // Close over the link: the timer can outlive it (dropLink sets this.link to null).
    const { link } = this;
    return new Promise((resolve) => {
      const waiter = { match, timer: null };
      waiter.resolve = (frame) => {
        clearTimeout(waiter.timer);
        resolve(frame);
      };
      waiter.timer = setTimeout(() => {
        link.waiters = link.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, ms);
      link.waiters.push(waiter);
    });
  }

  // Step 5: count unsolicited frames after subscribe.
  async stepUnsolicited() {
    await sleep(this.cfg.UNSOLICITED_WINDOW_MS);
    const { link } = this;
    this.record(5, {
      windowMs: this.cfg.UNSOLICITED_WINDOW_MS,
      notifications: link.notifyCount || 0,
      lengths: [...this.notifyLengths],
      frames: link.frames.map((f) => f.kind + (f.subMessages ? `:${f.subMessages.join('+')}` : '')),
      subscribed: true,
      note: 'Pass needs at least one notification by the end of step 7. A quiet window here is not a fail on its own.',
    });
  }

  // Steps 6 and 7: write the 114-byte session-info request, whole or in chunks.
  async stepWrite(step, chunkSize) {
    const { frame, routingAddress } = P.buildSessionInfoRequest();
    const parts = chunkSize ? P.chunk(frame, chunkSize) : [frame];
    const result = { frameBytes: frame.length, writes: parts.length, chunkSize: chunkSize || 'full' };
    const ours = routingAddress.toString('hex');
    const isSessionInfo = (f) => f.kind === 'routable' && f.sessionInfo && f.toRouting === ours;
    const reply = this.waitForFrame(isSessionInfo, this.cfg.REPLY_TIMEOUT_MS + this.cfg.WRITE_TIMEOUT_MS * parts.length);
    const t0 = Date.now();
    const writeMs = [];
    try {
      for (const part of parts) {
        const tw = Date.now();
        await withTimeout(this.link.write.write(Buffer.from(part)), this.cfg.WRITE_TIMEOUT_MS, 'write');
        writeMs.push(Date.now() - tw);
      }
      result.writeMs = writeMs;
      result.allWritesMs = Date.now() - t0;
    } catch (e) {
      result.writeError = String(e && e.message);
      result.writeMs = writeMs;
    }
    const tReplyStart = Date.now();
    const got = result.writeError ? null : await Promise.race([reply, sleep(this.cfg.REPLY_TIMEOUT_MS).then(() => null)]);
    result.reply = got ? { sessionInfo: got.sessionInfo, msAfterLastWrite: got.at - tReplyStart, msTotal: got.at - t0 } : null;
    result.pass = !!got;
    this.record(step, result);
    await sleep(1000);
  }

  // Step 8: version characteristic, and Generic Access device name.
  async stepReads() {
    const result = {};
    try {
      const v = await withTimeout(this.link.version.read(), 5000, 'read 0214');
      result.version = { ok: true, length: v.length, hex: v.toString('hex') };
    } catch (e) {
      result.version = { ok: false, error: String(e && e.message) };
    }
    try {
      const ga = await withTimeout(this.link.peripheral.getService(P.UUIDS.genericAccess), 5000, 'service 1800');
      const chars = await ga.discoverCharacteristics();
      const dn = chars.find((c) => P.uuidEquals(c.uuid, P.UUIDS.deviceName));
      if (!dn) throw new Error(`2a00 not listed (${chars.map((c) => P.normUuid(c.uuid)).join(',')})`);
      const buf = await withTimeout(dn.read(), 5000, 'read 2a00');
      const text = buf.toString('utf8');
      // The display name is user-chosen: log only whether the key prefix is there.
      result.deviceName = { ok: true, length: buf.length, keyPrefix: text.startsWith('🔑') };
    } catch (e) {
      result.deviceName = { ok: false, error: String(e && e.message), verdict: 'mark display name unsupported' };
    }
    this.record(8, result);
  }

  // Step 9: hold the link idle until it drops or the window ends.
  async stepIdleHold() {
    const { link } = this;
    const t0 = Date.now();
    const samples = [];
    while (Date.now() - t0 < this.cfg.IDLE_HOLD_MAX_MS && !link.disconnectAt) {
      await sleep(5000);
      samples.push({ t: Date.now() - t0, isConnected: link.peripheral.isConnected, state: link.peripheral.state });
    }
    const result = {
      maxMs: this.cfg.IDLE_HOLD_MAX_MS,
      disconnectEventFired: !!link.disconnectAt,
      disconnectAfterMs: link.disconnectAt ? link.disconnectAt - t0 : null,
      isConnectedAtEnd: link.peripheral.isConnected,
      firstFalseAtMs: (samples.find((x) => !x.isConnected) || {}).t || null,
    };
    // One probe read at the end tells a silent drop from a live link.
    const tp = Date.now();
    try {
      await withTimeout(link.version.read(), 5000, 'probe read');
      result.probeRead = { ok: true, ms: Date.now() - tp };
    } catch (e) {
      result.probeRead = { ok: false, ms: Date.now() - tp, error: String(e && e.message) };
    }
    result.silentDrop = !result.probeRead.ok && !result.disconnectEventFired;
    this.record(9, result);
  }

  // Step 10: write repeatedly while the operator takes the car out of range. Time the failing write.
  async stepLostLink() {
    this.out('step10', 'Move the car out of range or switch its Bluetooth path off now.');
    const t0 = Date.now();
    const writes = [];
    let failure = null;
    while (Date.now() - t0 < this.cfg.LOST_LINK_MAX_MS) {
      const { frame } = P.buildSessionInfoRequest();
      const tw = Date.now();
      try {
        // Deliberately no short timeout: the point is to see how long Homey takes.
        await withTimeout(this.link.write.write(frame), 120000, 'lost-link write');
        writes.push(Date.now() - tw);
      } catch (e) {
        failure = { afterMs: Date.now() - tw, error: String(e && e.message), atMs: Date.now() - t0 };
        break;
      }
      await sleep(this.cfg.LOST_LINK_INTERVAL_MS);
    }
    this.record(10, {
      writesOk: writes.length,
      writeMs: stats(writes),
      failure,
      disconnectEventFired: !!this.link.disconnectAt,
      isConnectedAtEnd: this.link.peripheral.isConnected,
    });
  }

  // Step 11: scan-to-connect and connect-to-first-reply, then an advertisement subscription.
  async stepLatencyAndAdverts() {
    const runs = [];
    for (let i = 0; i < this.cfg.CONNECT_RUNS; i += 1) {
      const run = { run: i + 1 };
      const t0 = Date.now();
      try {
        await this.homey.ble.discover();
        run.scanMs = Date.now() - t0;
        await this.openLink();
        if (!this.link) throw new Error('link failed');
        run.scanToConnectMs = this.link.subscribedAt - t0;
        const { frame, routingAddress } = P.buildSessionInfoRequest();
        const ours = routingAddress.toString('hex');
        const reply = this.waitForFrame((f) => f.kind === 'routable' && f.sessionInfo && f.toRouting === ours, 10000);
        const tc = Date.now();
        for (const part of P.chunk(frame, 20)) await withTimeout(this.link.write.write(part), 10000, 'write');
        const got = await reply;
        run.connectToFirstReplyMs = got ? got.at - tc : null;
        run.totalMs = got ? got.at - t0 : null;
        run.ok = !!got;
      } catch (e) {
        run.ok = false;
        run.error = String(e && e.message);
      }
      await this.dropLink();
      runs.push(run);
      this.out('latency', run);
      await sleep(3000);
    }
    const connectOnly = runs.filter((r) => r.ok).map((r) => r.scanToConnectMs - r.scanMs);
    const result = {
      ok: runs.filter((r) => r.ok).length,
      of: runs.length,
      scanMs: stats(runs.map((r) => r.scanMs).filter((x) => x !== undefined)),
      connectMs: stats(connectOnly),
      connectUnder4s: `${connectOnly.filter((x) => x < 4000).length}/${runs.length}`,
      firstReplyMs: stats(runs.map((r) => r.connectToFirstReplyMs).filter((x) => typeof x === 'number')),
      totalMs: stats(runs.map((r) => r.totalMs).filter((x) => typeof x === 'number')),
    };
    if (this.hasAdvFeature()) {
      this.out('step11', `Advertisement subscription on for ${this.cfg.ADV_WINDOW_MS} ms. Leave the car alone and check it falls asleep (Teslemetry or the Tesla app).`);
      result.advertisements = await this.sampleAdverts(this.targetUuid, this.cfg.ADV_WINDOW_MS);
    } else {
      result.advertisements = 'ble-advertisements feature not present';
    }
    this.record(11, result);
  }

  async sampleAdverts(uuid, windowMs) {
    if (!uuid) return { error: 'no peripheral to subscribe to' };
    const times = [];
    const rssi = [];
    let manufacturerChanges = 0;
    let lastManufacturer = null;
    const t0 = Date.now();
    try {
      await this.homey.ble.subscribeToAdvertisements(uuid, { rateLimitMs: this.cfg.ADV_RATE_LIMIT_MS }, (ad) => {
        times.push(Date.now());
        if (typeof ad.rssi === 'number') rssi.push(ad.rssi);
        const m = ad.manufacturerData ? Buffer.from(ad.manufacturerData).toString('hex') : null;
        if (lastManufacturer !== null && m !== lastManufacturer) manufacturerChanges += 1;
        lastManufacturer = m;
        // Minute-level heartbeat so the log shows when adverts stop or slow (car asleep?).
        if (times.length === 1 || times.length % 60 === 0) this.out('advert', { n: times.length, rssi: ad.rssi, atMs: Date.now() - t0 });
      });
    } catch (e) {
      return { error: String(e && e.message) };
    }
    const perMinute = [];
    while (Date.now() - t0 < windowMs) {
      const before = times.length;
      await sleep(Math.min(60000, windowMs));
      perMinute.push(times.length - before);
    }
    await this.homey.ble.unsubscribeFromAdvertisements(uuid).catch(() => undefined);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    return {
      windowMs,
      count: times.length,
      perSecond: Number((times.length / (windowMs / 1000)).toFixed(2)),
      gapMs: stats(gaps),
      perMinute,
      rssi: stats(rssi),
      manufacturerChanges,
      carSleptDuringWindow: 'operator to record',
    };
  }

  async dropLink() {
    const { link } = this;
    this.link = null;
    if (!link) return;
    await link.notify?.unsubscribeFromNotifications().catch(() => undefined);
    await link.peripheral.disconnect().catch(() => undefined);
  }

  summary() {
    const st = this.results.steps;
    const maxNotify = this.notifyLengths.length ? Math.max(...this.notifyLengths) : null;
    const pass = (n) => (st[n] ? !!st[n].pass : null);
    const notifications = this.notifyLengths.length > 0;
    const summary = {
      carState: this.carState,
      gate: {
        step2: pass(2),
        step5: st[5] || st[6] || st[7] ? notifications : null,
        step6: pass(6),
        step7: pass(7),
        pass: pass(2) === true && notifications && (pass(6) === true || pass(7) === true),
      },
      mtuEstimate: maxNotify === null ? null : maxNotify + 3,
      maxNotificationBytes: maxNotify,
      notificationLengths: [...new Set(this.notifyLengths)].sort((a, b) => a - b),
    };
    this.out('HW0-SUMMARY', summary);
    this.out('HW0-RESULTS', this.results);
    return summary;
  }

}

module.exports = BleProbeApp;

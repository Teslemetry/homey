# HW-0 Homey Bluetooth probe (BLE-00, ENG-5)

Throwaway Homey app. It runs stage HW-0 from document 06, section 4. It lives on a
scratch branch, is never merged and is never published.

It sends one kind of frame only: an unsigned VCSEC session-info request with a
throwaway P-256 key, built by hand from `@teslemetry/tesla-protocol`. The car
answers `SESSION_INFO_STATUS_KEY_NOT_ON_WHITELIST`. There is no pairing, no signed
command and no change on the car.

## Run

```bash
cd probe/ble-hw0
npm install
npm run selftest                 # offline: name vector, 114-byte frame, reassembly
cp env.example.json env.json     # put the VIN in env.json (gitignored)
npx homey select                 # the Homey Pro next to the car
npx homey app run
```

Put the Homey where it will live, and park the car where it normally parks. Free
a BLE slot first: walk phones with a Tesla key out of range, or turn their
Bluetooth off. VCSEC holds about three links.

`env.json` keys (all optional except `VIN`):

| Key | Default | Use |
| -- | -- | -- |
| `VIN` | none | Only used to compute the BLE name. Never logged. |
| `CAR_STATE` | `unknown` | Label for the run: `awake` or `asleep`. |
| `STEPS` | `1-9,11` | Steps to run, for example `1-2` or `10`. |
| `SCAN_RUNS` | 20 | Step 1. |
| `CONNECT_RUNS` | 10 | Steps 3 and 11. |
| `IDLE_HOLD_MAX_MS` | 300000 | Step 9 upper bound. |
| `LOST_LINK_MAX_MS` | 300000 | Step 10 upper bound. |
| `ADV_WINDOW_MS` | 1800000 | Step 11 advertisement subscription window. |
| `ADV_RATE_LIMIT_MS` | 0 | `rateLimitMs` for `subscribeToAdvertisements`. |

## Runs to do

1. Car **awake**: `CAR_STATE=awake`, `STEPS=1-9,11`.
2. Car **asleep**: `CAR_STATE=asleep`, `STEPS=1-2`. This gives step 1 asleep. Do
   not connect, because a link wakes the car. With `CAR_STATE=asleep` the step 2
   fallback, which connects, is skipped.
3. Step 10 on its own: `STEPS=1,10`. When the log says so, take the car out of
   range or turn its Bluetooth off.
4. Step 11 sleep check: leave `ADV_WINDOW_MS` at 30 min or more after the car's
   last use. Check in Teslemetry or the Tesla app that the car fell asleep while
   the subscription was on. The log only shows advert counts per minute.

Steps 9 and 10 both end the link, so the probe never runs both in one run.

## Output

Every line has an ISO timestamp with milliseconds. Peripherals are an 8-character
hash of the Homey uuid, so they compare across runs without exposing it. Our car's
name shows as `S<ours>C`, other Teslas as `S<other>?`, and other devices only as
a name length.

The last two lines are `[HW0-SUMMARY]` (gate and MTU estimate) and
`[HW0-RESULTS]` (every step). Copy those into the Linear comment.

Before posting, check that the comment has no VIN, BLE name, uuid or MAC address.

| Step | Log tag | Main fields |
| -- | -- | -- |
| 1 | `scan`, `step1` | Per run: total, named, `teslaNames`, ours (rssi, connectable). Scan ms. |
| 2 | `step2` | `share` of scans with our name. On zero, the service-UUID fallback and an advertisement sample. |
| 3 | `connect`, `step3` | ok of 10, `findMs`, `connectMs`, errors |
| 4 | `step4` | characteristics with `properties` |
| 5 | `step5` | unsolicited notifications and lengths, bare VCSEC frames |
| 6 | `step6` | one 114-byte write: `writeMs`, reply status, reply ms |
| 7 | `step7` | six 20-byte writes: `writeMs` each, reply |
| 8 | `step8` | `0214` read, `2A00` read (only whether the key prefix is there) |
| 9 | `step9` | `disconnectAfterMs`, `disconnectEventFired`, `isConnected`, end probe read, `silentDrop` |
| 10 | `step10` | ms for the failing write, and the error |
| 11 | `latency`, `step11` | scan, connect, first reply, `connectUnder4s`, advertisement rate |

**Gate:** step 2 passes, at least one notification arrives (step 5), and step 6 or
step 7 gets a reply. **MTU estimate** = largest notification + 3. If every
notification is 20 bytes or less, the estimate is a lower bound only.

If step 2 fails and the fallback finds nothing, stop. Bluetooth enrolment on
Homey needs another design.

## Then update

* `HomeyBleTransport` default `maxWriteSize` (document 06, section 1.1): step 6
  pass means `null` (one write per frame) is possible. Otherwise keep 20, or use
  MTU estimate − 3 if larger.
* Document 06, section 2: replace the **Unknown** rows (scan name, full-frame
  write, display name, several vehicles) and add the MTU.
* Homey `connect_timeout_ms` and health window from step 11.

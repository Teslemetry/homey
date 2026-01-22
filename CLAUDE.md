# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homey app for Tesla integration via the Teslemetry service. Provides real-time control and monitoring of Tesla vehicles and energy products (Powerwall, Solar, Wall Connector, Gateway) using Server-Sent Events (no polling).

## Commands

```bash
npm run build          # Compile TypeScript to .homeybuild/
npm run lint           # ESLint check
npm run dev            # Run app on local Homey
npm run app:validate   # Validate app (required before commit)
```

Always run `npm run app:validate` before committing changes.

## Architecture

### Core Files

- `app.ts` - Main entry point. Initializes OAuth2 client and Teslemetry SDK connection. Manages `Products` instance containing all vehicles/energy sites.
- `api.ts` - OAuth status and token revocation endpoints
- `lib/TeslemetryOAuth2Client.ts` - PKCE OAuth2 flow, token storage/refresh
- `lib/TeslemetryDriver.ts` - Base driver class with OAuth2 pairing/repair flow
- `lib/TeslemetryDevice.ts` - Base device class with capability sync

### Driver Pattern

Each device type (vehicle, battery, solar, gateway, wall-connector) follows the same structure:
- `drivers/<type>/driver.ts` - Extends `TeslemetryDriver`, implements `onPairListDevices()`
- `drivers/<type>/device.ts` - Extends `TeslemetryDevice`, registers signal handlers and capability listeners

### Data Flow

1. `TeslemetryApp` creates `Products` from `@teslemetry/api`
2. Devices get their product instance (e.g., `this.homey.app.products.vehicles[vin]`)
3. Incoming data: `vehicle.sse.onSignal("SignalName", callback)` → `this.update(capability, value)`
4. Outgoing commands: `registerCapabilityListener` → `vehicle.api.methodName()`

### Homey Compose

Configuration lives in `.homeycompose/` - this generates `app.json` at build time:
- `.homeycompose/app.json` - Base app manifest (edit this, not `app.json`)
- `.homeycompose/capabilities/` - Custom capability definitions
- `.homeycompose/flow/` - Flow card definitions (triggers, actions)
- `.homeycompose/drivers/` - Driver capability configurations

## Key Patterns

### Capability Listeners

**Do not await vehicle SDK actions in `registerCapabilityListener`** - they can take up to a minute. Use `.catch()` instead:

```typescript
// Correct
this.registerCapabilityListener("locked", async (value) => {
  value
    ? this.vehicle.api.lockDoors().catch(this.handleApiError)
    : this.vehicle.api.unlockDoors().catch(this.handleApiError);
});

// Wrong - blocks the listener and will likely hit 10 second timeout
this.registerCapabilityListener("locked", async (value) => {
  await this.vehicle.api.lockDoors();  // Don't do this
});
```

### API Error Handling

Use the inherited `handleApiError` and `handleApiResponse` methods:

```typescript
this.vehicle.api.someCommand()
  .then(this.handleApiResponse)
  .catch(this.handleApiError);
```

### Signal-to-Capability Mapping

Some SSE signals use enum strings that need mapping:

```typescript
const chargePortLatchMap = new Map([
  ["ChargePortLatchEngaged", true],
  ["ChargePortLatchDisengaged", false],
]);

this.vehicle.sse.onSignal("ChargePortLatch", (value) =>
  this.update("locked.charge_latch", chargePortLatchMap.get(value))
);
```

### Capability Updates

Use the `update()` method which safely handles unsupported capabilities:

```typescript
this.update("measure_battery", value);  // No-op if capability not present
```

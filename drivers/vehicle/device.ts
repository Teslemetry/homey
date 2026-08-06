import {
  SseConnectivity,
  SseData,
  SseState,
  TeslemetryVehicleStream,
  VehicleDetails,
} from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";
import { checkVehicleEligibility } from "../../lib/TeslemetryDriver.js";
import {
  isCapabilitySupported,
  filterVehicleCapabilities,
  isMetadataGatedCapability,
} from "./capabilityGating.js";

/** Locale key for each way checkVehicleEligibility() can report a vehicle ineligible. */
const VEHICLE_INELIGIBILITY_MESSAGE_KEY = {
  access: "error.vehicle_access_required",
  telemetry: "error.vehicle_telemetry_unavailable",
  polling: "error.vehicle_polling_mode",
} as const;

const isBool = (x: any) => typeof x === "boolean";

const chargePortLatchMap = new Map<SseData["data"]["ChargePortLatch"], boolean>(
  [
    ["ChargePortLatchEngaged", true],
    ["ChargePortLatchDisengaged", false],
  ],
);

const defrostModeMap = new Map<SseData["data"]["DefrostMode"], boolean>([
  ["DefrostModeStateNormal", true],
  ["DefrostModeStateMax", true],
  ["DefrostModeStateOff", false],
]);

const windowMap = new Map<SseData["data"]["FdWindow"], boolean>([
  ["WindowStateOpened", true],
  ["WindowStatePartiallyOpen", true],
  ["WindowStateClosed", false],
]);

const tonneauPositionClosedMap = new Map<
  SseData["data"]["TonneauPosition"],
  boolean
>([
  ["TonneauPositionStateClosed", true],
  ["TonneauPositionStatePartiallyOpen", false],
  ["TonneauPositionStateFullyOpen", false],
]);

const copModeMap = new Map<
  SseData["data"]["CabinOverheatProtectionMode"],
  string
>([
  ["CabinOverheatProtectionModeStateOff", "off"],
  ["CabinOverheatProtectionModeStateOn", "on"],
  ["CabinOverheatProtectionModeStateFanOnly", "fan_only"],
]);

const copTemperatureLimitMap = new Map<
  SseData["data"]["CabinOverheatProtectionTemperatureLimit"],
  string
>([
  ["ClimateOverheatProtectionTempLimitLow", "low"],
  ["ClimateOverheatProtectionTempLimitMedium", "medium"],
  ["ClimateOverheatProtectionTempLimitHigh", "high"],
]);

const scheduledChargingModeMap = new Map<
  SseData["data"]["ScheduledChargingMode"],
  string
>([
  ["ScheduledChargingModeOff", "off"],
  ["ScheduledChargingModeStartAt", "start_at"],
  ["ScheduledChargingModeDepartBy", "depart_by"],
]);

// "...StateUnknown"/"...StatusUnknown" is intentionally left unmapped -
// mirrors the Teslemetry Home Assistant integration's own POWER_SHARE_*
// lookups, which likewise have no entry for the unknown variant and leave
// the entity at its prior value rather than inventing an "unknown" state.
const powershareStatusMap = new Map<SseData["data"]["PowershareStatus"], string>([
  ["PowershareStateInactive", "inactive"],
  ["PowershareStateHandshaking", "handshaking"],
  ["PowershareStateInit", "init"],
  ["PowershareStateEnabled", "enabled"],
  ["PowershareStateEnabledReconnectingSoon", "reconnecting"],
  ["PowershareStateStopped", "stopped"],
]);

const powershareStopReasonMap = new Map<
  SseData["data"]["PowershareStopReason"],
  string
>([
  ["PowershareStopReasonStatusNone", "none"],
  ["PowershareStopReasonStatusSOCTooLow", "soc_too_low"],
  ["PowershareStopReasonStatusRetry", "retry"],
  ["PowershareStopReasonStatusFault", "fault"],
  ["PowershareStopReasonStatusUser", "user"],
  ["PowershareStopReasonStatusReconnecting", "reconnecting"],
  ["PowershareStopReasonStatusAuthentication", "authentication"],
]);

const powershareTypeMap = new Map<SseData["data"]["PowershareType"], string>([
  ["PowershareTypeStatusNone", "none"],
  ["PowershareTypeStatusLoad", "load"],
  ["PowershareTypeStatusHome", "home"],
]);

const centerDisplayMap = new Map<SseData["data"]["CenterDisplay"], boolean>([
  ["DisplayStateOff", false],
  ["DisplayStateDim", false],
  ["DisplayStateCharging", false],
  ["DisplayStateLock", false],
  ["DisplayStateSentry", false],
  ["DisplayStateAccessory", true],
  ["DisplayStateOn", true],
  ["DisplayStateDriving", true],
  ["DisplayStateDog", true],
  ["DisplayStateEntertainment", true],
]);

/**
 * Homey's "time" Flow argument resolves to a 24-hour "HH:mm" string.
 * setScheduledCharging()/setScheduledDeparture() take Tesla's own
 * minutes-into-the-day encoding instead (the SDK's doc comment gives
 * "1:05 AM is represented as 65" as an example) - not epoch seconds and not
 * subject to the TPMS-style timezone defect elsewhere in this file, since
 * it's the vehicle's own local clock.
 */
function timeArgToMinutesOfDay(time: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    throw new Error(`Invalid time "${time}" - expected HH:mm`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

const MILES_TO_KILOMETERS = 1.609344;
const MPH_TO_METERS_PER_SECOND = 0.44704;
const ATM_TO_BAR = 1.01325;

const TPMS_WHEEL_FIELDS = [
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
] as const;

const ACTIVE_CHARGE_STATES = new Set<SseData["data"]["DetailedChargeState"]>([
  "DetailedChargeStateStarting",
  "DetailedChargeStateCharging",
]);

export default class VehicleDevice extends TeslemetryDevice {
  private vehicle!: VehicleDetails;
  private volumeMax: number = 10.333;
  /** Tesla's default step until MediaAudioVolumeIncrement is reported. */
  private volumeIncrement: number = 0.333;
  private muted: boolean = false;
  private lastVolume: number = 0.5 * 10.333;

  /**
   * The last DetailedChargeState signal value. Not exposed as a capability -
   * "plugged in" has no Homey capability of its own, so the raw enum is the
   * only way to detect the Disconnected <-> anything-else transition.
   */
  private previousDetailedChargeState?: SseData["data"]["DetailedChargeState"];

  private sseCleanup: Array<() => void> = [];

  private lastTpmsSoftWarnings?: SseData["data"]["TpmsSoftWarnings"];
  private lastTpmsHardWarnings?: SseData["data"]["TpmsHardWarnings"];
  private previousLocatedAtHome?: boolean;
  private previousVehicleState?: SseState["state"];

  /** Count of signal handlers that threw during registration/replay; see onSignal(). */
  private signalHandlerFailures = 0;

  /** hard beats soft beats off, aggregated across every tire. */
  private updateTpmsWarningLevel(): void {
    const anyHard = TPMS_WHEEL_FIELDS.some(
      (field) => this.lastTpmsHardWarnings?.[field],
    );
    const anySoft = TPMS_WHEEL_FIELDS.some(
      (field) => this.lastTpmsSoftWarnings?.[field],
    );
    let level: "off" | "soft" | "hard" = "off";
    if (anySoft) level = "soft";
    if (anyHard) level = "hard";
    this.update("tpms_warning", level);
  }

  /**
   * The SDK's onSignal() replays any cached value synchronously through
   * `callback` before returning, and only registers the live listener
   * afterwards. A throw from `callback` - during that replay or from a
   * later live event - must not skip that registration or escape to abort
   * whichever signal registerSignalListeners() calls next, so every
   * callback is wrapped to catch and log instead of propagating.
   */
  private readonly onSignal: TeslemetryVehicleStream["onSignal"] = (
    field,
    callback,
  ) => {
    const guarded: typeof callback = (value) => {
      try {
        callback(value);
      } catch (e) {
        this.signalHandlerFailures++;
        this.error(`Signal handler for "${field}" failed`, e);
      }
    };
    const off = this.vehicle.sse.onSignal(field, guarded);
    this.sseCleanup.push(off);
    return off;
  };

  /**
   * The vehicle's asleep/online/offline transitions are fired as woke/slept
   * triggers independent of the specific state exited/entered into (asleep
   * -> either online or offline is "woke", either -> asleep is "slept"),
   * mirroring the grid-outage-vs-test close-trigger pattern.
   */
  private readonly handleVehicleState = (value: SseState) => {
    if (!value?.state) return;
    const previous = this.previousVehicleState;
    this.previousVehicleState = value.state;
    this.update("vehicle_state", value.state);

    if (previous === undefined || previous === value.state) return;
    if (previous === "asleep") {
      this.triggerFlow("vehicle_woke_up");
    } else if (value.state === "asleep") {
      this.triggerFlow("vehicle_went_to_sleep");
    }
  };

  private readonly handleConnectivity = (value: SseConnectivity) => {
    if (value.networkInterface === "WiFi") {
      this.update("wifi_connected", value.status === "connected");
    } else if (value.networkInterface === "Cellular") {
      this.update("cellular_connected", value.status === "connected");
    }
  };

  async onInit() {
    await super.onInit();
    this.resolveAndBindVehicle();
  }

  /**
   * Re-resolves the vehicle and rebinds, torn down and re-registered exactly
   * like onInit(). See TeslemetryDevice.rebindProduct(). Re-registering the
   * command capability listeners here is harmless, not load-bearing - they
   * read `this.vehicle` dynamically on every call, so just reassigning it
   * below would already point them at the new vehicle's API client.
   */
  public rebindProduct(): void {
    this.vehicle?.sse.off("state", this.handleVehicleState);
    this.vehicle?.sse.off("connectivity", this.handleConnectivity);
    this.sseCleanup.forEach((off) => off());
    this.sseCleanup = [];
    this.resolveAndBindVehicle();
  }

  public getProductKey(): string | undefined {
    return this.vehicle ? `vehicle:${this.vehicle.vin}` : undefined;
  }

  public getVin(): string {
    return this.getData().vin;
  }

  private resolveAndBindVehicle(): void {
    let vehicle: VehicleDetails;
    try {
      const found = this.homey.app.products?.vehicles?.[this.getVin()];
      if (!found) throw new Error("No vehicle found");
      vehicle = found;
    } catch (e) {
      if (!(this.homey.app.isReady?.() ?? true)) {
        this.markUnavailable(
          "startup",
          this.homey.__("error.teslemetry_connecting"),
        );
        return;
      }
      this.log("Failed to initialize Vehicle device");
      this.error(e);
      this.markUnavailable("binding", this.homey.__("error.vehicle_not_found"));
      return;
    }

    // Present but ineligible (access/telemetry/polling): revalidated with
    // the exact predicate pairing uses, so an already-paired vehicle that
    // loses eligibility doesn't stay bound with a frozen last-known state.
    const eligibility = checkVehicleEligibility(vehicle.metadata);
    if (!eligibility.eligible) {
      this.vehicle = undefined!;
      this.log(
        `Vehicle ${this.getVin()} is present but not eligible (${eligibility.reason})`,
      );
      this.markUnavailable(
        "eligibility",
        this.homey.__(VEHICLE_INELIGIBILITY_MESSAGE_KEY[eligibility.reason]),
      );
      return;
    }

    this.vehicle = vehicle;
    this.clearAvailabilityReason("startup");
    this.clearAvailabilityReason("binding");
    this.clearAvailabilityReason("eligibility");

    this.setCapabilityOptions("onoff.frunk", {
      ...this.driver.manifest.capabilitiesOptions["onoff.frunk"],
      setable: !!this.vehicle.metadata.config?.can_actuate_trunks,
    }).catch(this.error);
    this.setCapabilityOptions("onoff.trunk", {
      ...this.driver.manifest.capabilitiesOptions["onoff.trunk"],
      setable: !!this.vehicle.metadata.config?.can_actuate_trunks,
    }).catch(this.error);
    this.setCapabilityOptions("cop_temperature_limit", {
      ...this.driver.manifest.capabilitiesOptions["cop_temperature_limit"],
      setable: !!this.vehicle.metadata.config?.cop_user_set_temp_supported,
    }).catch(this.error);

    // Essential behavior: state/connectivity SSE listeners and all command
    // capability listeners. Registered before the signal replay below so a
    // synchronous throw from a malformed cached signal (e.g.
    // handleBatteryLevel reading an unexpected capability value) can never
    // leave this device without them.
    this.vehicle.sse.on("state", this.handleVehicleState);
    this.vehicle.sse.on("connectivity", this.handleConnectivity);
    this.registerCommandCapabilityListeners();

    // --- Signals (Incoming Data) ---
    // Optional/fallible: registering a signal handler replays any cached
    // value synchronously, and per-signal handlers can throw on malformed
    // cached data (e.g. handleBatteryLevel reading an unexpected capability
    // value). Wrapped as a whole so a throw here can't undo the essential
    // registration above; onSignal() itself isolates one signal's failure
    // from the rest so this outer catch is only a last resort for a throw
    // outside a signal callback (e.g. building a field name to register).
    try {
      this.registerSignalListeners();
      if (this.signalHandlerFailures > 0) {
        this.log(
          `Vehicle device registered with ${this.signalHandlerFailures} signal handler failure(s); affected capabilities may be stale until their next live update`,
        );
      }
    } catch (e) {
      this.error("Failed to register Vehicle signal listeners", e);
    }
  }

  private registerSignalListeners(): void {
    this.signalHandlerFailures = 0;

    // Battery & Range
    this.onSignal("BatteryLevel", (value) =>
      this.handleBatteryLevel(value),
    );
    this.onSignal("EstBatteryRange", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_distance.range", value * MILES_TO_KILOMETERS);
      }
    });

    // Charging
    this.onSignal("DetailedChargeState", (value) =>
      this.handleDetailedChargeState(value),
    );
    this.onSignal("ChargerVoltage", (value) =>
      this.update("measure_voltage", value),
    );
    this.onSignal("ChargeCurrentRequest", (value) =>
      this.update("measure_current", value),
    );
    this.onSignal("ChargeLimitSoc", (value) => {
      if (value !== undefined && value !== null) {
        this.update("charge_limit", value / 100);
      }
    });
    this.onSignal("ChargeAmps", (value) => this.update("charging_amps", value));
    this.onSignal("TimeToFullCharge", (value) => {
      if (value !== undefined && value !== null) {
        this.update("time_to_full_charge", value * 60);
      }
    });
    this.onSignal("ScheduledChargingMode", (value) =>
      this.update("scheduled_charging_mode", scheduledChargingModeMap.get(value)),
    );
    this.onSignal("ScheduledChargingPending", (value) =>
      this.update("scheduled_charging_pending", value),
    );

    // AC Charging
    this.onSignal("ACChargingEnergyIn", (value) =>
      this.update("meter_power", value),
    );
    this.onSignal("ACChargingPower", (value) =>
      this.update("measure_power", value ? value * 1000 : value),
    );

    // DC Charging
    this.onSignal("DCChargingEnergyIn", (value) =>
      this.update("meter_power", value),
    );
    this.onSignal("DCChargingPower", (value) =>
      this.update("measure_power", value ? value * 1000 : value),
    );

    // Lifetime Energy
    this.onSignal("LifetimeEnergyGainedRegen", (value) => {
      if (value !== undefined && value !== null) {
        this.update("meter_power.regen", value);
      }
    });

    // Lock & Sentry & Security
    this.onSignal("Locked", (value) => this.update("locked", value));
    this.onSignal("SentryMode", (value) => {
      this.update("onoff.sentry", value !== "SentryModeStateOff");
      this.update("alarm_motion", value === "SentryModeStatePanic");
    });
    this.onSignal("PinToDriveEnabled", (value) => {
      if (value !== undefined && value !== null) {
        this.update("alarm_generic.pin_to_drive", value);
      }
    });
    this.onSignal("ValetModeEnabled", (value) => {
      if (value !== undefined && value !== null) {
        this.update("alarm_generic.valet_mode", value);
      }
    });

    this.onSignal("ChargePortLatch", (value) =>
      // 'Engaged' -> Locked?
      this.update("locked.charge_latch", chargePortLatchMap.get(value)),
    );
    this.onSignal("ChargePortDoorOpen", (value) =>
      this.update("onoff.charge_port", value),
    );

    // Climate
    const handleThermostatMode = (
      key: "HvacPower" | "DefrostMode" | "ClimateKeeperMode",
      value: SseData["data"][typeof key],
    ) => {
      // Figure out the latest states of the vehicle
      const signals = {
        HvacPower:
          key === "HvacPower"
            ? (value as SseData["data"]["HvacPower"])
            : this.vehicle.sse.cache.data?.HvacPower,
        DefrostMode: defrostModeMap.get(
          key === "DefrostMode"
            ? (value as SseData["data"]["DefrostMode"])
            : this.vehicle.sse.cache.data?.DefrostMode,
        ),
        ClimateKeeperMode:
          key === "ClimateKeeperMode"
            ? (value as SseData["data"]["ClimateKeeperMode"])
            : this.vehicle.sse.cache.data?.ClimateKeeperMode,
      };

      if (signals.DefrostMode) {
        return this.update("thermostat_mode", "defrost");
      }
      if (signals.ClimateKeeperMode === "ClimateKeeperModeStateOn") {
        return this.update("thermostat_mode", "keep_mode");
      }
      if (signals.ClimateKeeperMode === "ClimateKeeperModeStateDog") {
        return this.update("thermostat_mode", "dog_mode");
      }
      if (signals.ClimateKeeperMode === "ClimateKeeperModeStateParty") {
        return this.update("thermostat_mode", "camp_mode");
      }
      if (signals.HvacPower === "HvacPowerStateOn") {
        return this.update("thermostat_mode", "auto");
      }
      return this.update("thermostat_mode", "off");
    };

    this.onSignal("HvacPower", (value) =>
      handleThermostatMode("HvacPower", value),
    );
    this.onSignal("DefrostMode", (value) =>
      handleThermostatMode("DefrostMode", value),
    );
    this.onSignal("ClimateKeeperMode", (value) =>
      handleThermostatMode("ClimateKeeperMode", value),
    );
    this.onSignal("RearDefrostEnabled", (value) =>
      this.update("alarm_generic.rear_defrost", value),
    );
    this.onSignal("CabinOverheatProtectionMode", (value) =>
      this.update("cop_mode", copModeMap.get(value)),
    );
    this.onSignal("CabinOverheatProtectionTemperatureLimit", (value) =>
      this.update("cop_temperature_limit", copTemperatureLimitMap.get(value)),
    );

    // Software Update - derived from stream fields only (no REST-polled raw
    // status enum is available here), mirroring the Teslemetry HA
    // integration's streaming update entity: download/install percentage and
    // scheduled-start-time presence, not a literal status string.
    this.onSignal("SoftwareUpdateDownloadPercentComplete", () =>
      this.recomputeSoftwareUpdateStatus(),
    );
    this.onSignal("SoftwareUpdateInstallationPercentComplete", () =>
      this.recomputeSoftwareUpdateStatus(),
    );
    this.onSignal("SoftwareUpdateScheduledStartTime", () =>
      this.recomputeSoftwareUpdateStatus(),
    );
    this.onSignal("SoftwareUpdateVersion", () =>
      this.recomputeSoftwareUpdateStatus(),
    );
    this.onSignal("Version", () => this.recomputeSoftwareUpdateStatus());

    this.onSignal(
      this.vehicle.metadata.config?.rhd
        ? "HvacRightTemperatureRequest"
        : "HvacLeftTemperatureRequest",
      (value) => this.update("target_temperature", value),
    );
    this.onSignal("InsideTemp", (value) =>
      this.update("measure_temperature", value),
    );
    this.onSignal("OutsideTemp", (value) =>
      this.update("measure_temperature.outside", value),
    );
    this.onSignal("HvacSteeringWheelHeatLevel", (value) =>
      this.update("steering_wheel_heater", String(value)),
    );
    this.onSignal("HvacSteeringWheelHeatAuto", (value) =>
      this.update("onoff.auto_steering_wheel_heat", value),
    );
    this.onSignal("AutoSeatClimateLeft", (value) =>
      this.update("onoff.auto_seat_climate_left", value),
    );
    this.onSignal("AutoSeatClimateRight", (value) =>
      this.update("onoff.auto_seat_climate_right", value),
    );
    this.onSignal("SeatHeaterLeft", (value) =>
      this.update("seat_heater.front_left", String(value)),
    );
    this.onSignal("SeatHeaterRight", (value) =>
      this.update("seat_heater.front_right", String(value)),
    );
    this.onSignal("SeatHeaterRearLeft", (value) =>
      this.update("seat_heater.rear_left", String(value)),
    );
    this.onSignal("SeatHeaterRearRight", (value) =>
      this.update("seat_heater.rear_right", String(value)),
    );
    this.onSignal("SeatHeaterRearCenter", (value) =>
      this.update("seat_heater.rear_center", String(value)),
    );
    this.onSignal("ClimateSeatCoolingFrontLeft", (value) =>
      this.update("seat_cooler.front_left", String(value)),
    );
    this.onSignal("ClimateSeatCoolingFrontRight", (value) =>
      this.update("seat_cooler.front_right", String(value)),
    );

    // Doors & Windows (Assuming Signal names)
    this.onSignal("DoorState", (value) => {
      if (isBool(value?.DriverFront)) {
        this.update("alarm_contact.fl", value.DriverFront);
      }
      if (isBool(value?.PassengerFront)) {
        this.update("alarm_contact.fr", value.PassengerFront);
      }
      if (isBool(value?.DriverRear)) {
        this.update("alarm_contact.rl", value.DriverRear);
      }
      if (isBool(value?.PassengerRear)) {
        this.update("alarm_contact.rr", value.PassengerRear);
      }
      if (isBool(value?.TrunkFront)) {
        this.update("onoff.frunk", value.TrunkFront);
      }
      if (isBool(value?.TrunkRear)) this.update("onoff.trunk", value.TrunkRear);
    });

    const handleWindow = () => {
      const { FdWindow, FpWindow, RdWindow, RpWindow } =
        this.vehicle.sse.cache?.data ?? {};
      const anyOpen =
        windowMap.get(FdWindow) ||
        windowMap.get(FpWindow) ||
        windowMap.get(RdWindow) ||
        windowMap.get(RpWindow);
      this.update("windowcoverings_closed", !anyOpen);
    };

    this.onSignal("FdWindow", handleWindow);
    this.onSignal("FpWindow", handleWindow);
    this.onSignal("RdWindow", handleWindow);
    this.onSignal("RpWindow", handleWindow);

    // Cybertruck Tonneau
    this.onSignal("TonneauPosition", (value) =>
      this.update(
        "windowcoverings_closed.tonneau",
        tonneauPositionClosedMap.get(value),
      ),
    );
    this.onSignal("TonneauOpenPercent", (value) => {
      if (value !== undefined && value !== null) {
        this.update("windowcoverings_set.tonneau", value / 100);
      }
    });

    // Cybertruck Powershare (vehicle-to-home)
    this.onSignal("PowershareStatus", (value) =>
      this.update("powershare_status", powershareStatusMap.get(value)),
    );
    this.onSignal("PowershareStopReason", (value) =>
      this.update("powershare_stop_reason", powershareStopReasonMap.get(value)),
    );
    this.onSignal("PowershareType", (value) =>
      this.update("powershare_type", powershareTypeMap.get(value)),
    );
    this.onSignal("PowershareHoursLeft", (value) =>
      this.update("powershare_hours_left", value),
    );
    this.onSignal("PowershareInstantaneousPowerKW", (value) =>
      this.update("measure_power.powershare", value ? value * 1000 : value),
    );

    // Tire Pressure (TPMS)
    this.onSignal("TpmsPressureFl", (value) =>
      this.update(
        "measure_pressure.fl",
        value !== undefined && value !== null ? value * ATM_TO_BAR : value,
      ),
    );
    this.onSignal("TpmsPressureFr", (value) =>
      this.update(
        "measure_pressure.fr",
        value !== undefined && value !== null ? value * ATM_TO_BAR : value,
      ),
    );
    this.onSignal("TpmsPressureRl", (value) =>
      this.update(
        "measure_pressure.rl",
        value !== undefined && value !== null ? value * ATM_TO_BAR : value,
      ),
    );
    this.onSignal("TpmsPressureRr", (value) =>
      this.update(
        "measure_pressure.rr",
        value !== undefined && value !== null ? value * ATM_TO_BAR : value,
      ),
    );

    // HV battery pack diagnostics
    this.onSignal("BrickVoltageMax", (value) =>
      this.update("measure_voltage.brick_max", value),
    );
    this.onSignal("BrickVoltageMin", (value) =>
      this.update("measure_voltage.brick_min", value),
    );
    this.onSignal("ModuleTempMax", (value) =>
      this.update("measure_temperature.module_max", value),
    );
    this.onSignal("ModuleTempMin", (value) =>
      this.update("measure_temperature.module_min", value),
    );

    this.onSignal("TpmsSoftWarnings", (value) => {
      this.lastTpmsSoftWarnings = value ?? undefined;
      this.updateTpmsWarningLevel();
    });
    this.onSignal("TpmsHardWarnings", (value) => {
      this.lastTpmsHardWarnings = value ?? undefined;
      this.updateTpmsWarningLevel();
    });

    // Vehicle Status
    this.onSignal("Odometer", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_distance.odometer", value * MILES_TO_KILOMETERS);
      }
    });
    this.onSignal("VehicleSpeed", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_speed", value * MPH_TO_METERS_PER_SECOND);
      }
    });
    this.onSignal("Gear", (value) => {
      if (value === "ShiftStateP") this.update("gear", "P");
      else if (value === "ShiftStateR") this.update("gear", "R");
      else if (value === "ShiftStateN") this.update("gear", "N");
      else if (value === "ShiftStateD") this.update("gear", "D");
    });
    this.onSignal("MilesSinceReset", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_distance.since_reset", value * MILES_TO_KILOMETERS);
      }
    });
    this.onSignal("SelfDrivingMilesSinceReset", (value) => {
      if (value !== undefined && value !== null) {
        this.update(
          "measure_distance.fsd_since_reset",
          value * MILES_TO_KILOMETERS,
        );
      }
    });

    // Navigation
    this.onSignal("DestinationName", (value) =>
      this.update("navigation_destination", value ?? ""),
    );
    this.onSignal("MinutesToArrival", (value) =>
      this.updateWithThresholdTriggers(
        "minutes_to_arrival",
        value,
        "minutes_to_arrival_above",
        "minutes_to_arrival_below",
        "minutes",
      ),
    );
    this.onSignal("MilesToArrival", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_distance.arrival", value * MILES_TO_KILOMETERS);
      }
    });
    this.onSignal("RouteTrafficMinutesDelay", (value) =>
      this.updateWithThresholdTriggers(
        "route_traffic_delay",
        value,
        "route_traffic_delay_above",
        "route_traffic_delay_below",
        "minutes",
      ),
    );
    this.onSignal("ExpectedEnergyPercentAtTripArrival", (value) =>
      this.updateWithThresholdTriggers(
        "measure_battery.arrival",
        value,
        "energy_at_arrival_above",
        "energy_at_arrival_below",
        "percentage",
      ),
    );

    // Presence (native vehicle-reported at-home/at-work, not derived from
    // raw coordinates). Only ever updates if the account has granted the
    // vehicle_location scope and the vehicle has resolved a location - see
    // handleLocatedAtHome()/handleLocatedAtWork() for the degrade-gracefully
    // behavior when it hasn't.
    this.onSignal("LocatedAtHome", (value) => this.handleLocatedAtHome(value));
    this.onSignal("LocatedAtWork", (value) => this.handleLocatedAtWork(value));

    // Guest Mode
    this.onSignal("GuestModeEnabled", (value) =>
      this.update("onoff.guest_mode", value),
    );

    // Media Volume
    this.onSignal("MediaAudioVolume", (value) => {
      if (value !== undefined && value !== null) {
        this.lastVolume = value;
        if (!this.muted) {
          this.update("volume_set", value / this.volumeMax);
        }
      }
    });

    this.onSignal("MediaAudioVolumeMax", (value) => {
      if (value !== undefined && value !== null) {
        this.volumeMax = value;
      }
    });

    this.onSignal("MediaAudioVolumeIncrement", (value) => {
      if (value !== undefined && value !== null) {
        this.volumeIncrement = value;
      }
    });

    // Media Playback Status
    const handlePlaybackStatus = (
      value:
        | SseData["data"]["CenterDisplay"]
        | SseData["data"]["MediaPlaybackStatus"],
    ) => {
      if (!value) return;
      const display = centerDisplayMap.get(
        value?.startsWith("CenterDisplay")
          ? (value as SseData["data"]["CenterDisplay"])
          : this.vehicle.sse.cache.data?.CenterDisplay,
      );
      const playback =
        (value?.startsWith("MediaStatus")
          ? value
          : this.vehicle.sse.cache.data?.MediaPlaybackStatus) ===
        "MediaStatusPlaying";

      this.update("speaker_playing", display && playback);
    };

    this.onSignal("MediaPlaybackStatus", handlePlaybackStatus);
    this.onSignal("CenterDisplay", handlePlaybackStatus);

    // Media Track Information
    this.onSignal("MediaNowPlayingTitle", (value) => {
      this.update("speaker_track", value ?? "");
    });

    this.onSignal("MediaNowPlayingArtist", (value) => {
      this.update("speaker_artist", value ?? "");
    });

    this.onSignal("MediaNowPlayingAlbum", (value) => {
      this.update("speaker_album", value ?? "");
    });

    // Media Duration and Position (convert ms to seconds)
    this.onSignal("MediaNowPlayingDuration", (value) => {
      if (value !== undefined && value !== null) {
        this.update("speaker_duration", value / 1000);
      }
    });

    this.onSignal("MediaNowPlayingElapsed", (value) => {
      if (value !== undefined && value !== null) {
        this.update("speaker_position", value / 1000);
      }
    });
  }

  /**
   * Routes every vehicle command through action()'s 9s timeout race after
   * first validating Tesla's `{ response: { result, reason } }` envelope, so
   * an explicit `result: false` always surfaces as a rejected capability/Flow
   * promise instead of resolving as success. The generic constraint means a
   * command whose response shape lacks `result` (e.g. wakeUp()) won't compile
   * here - call action() directly for those instead.
   */
  private vehicleAction<
    T extends { response: { result: boolean; reason?: string } },
  >(promise: Promise<T>): Promise<void> {
    return this.action(promise.then(this.handleApiResponse));
  }

  // --- Capability Listeners (Actions) ---
  private registerCommandCapabilityListeners(): void {
    // Locked
    this.registerCapabilityListener("locked", async (value) => {
      return this.vehicleAction(
        value
          ? this.vehicle.api.lockDoors()
          : this.vehicle.api.unlockDoors(),
      );
    });

    // Climate
    this.registerCapabilityListener("thermostat_mode", async (value) => {
      await this.setThermostatMode(value);
    });

    this.registerCapabilityListener("cop_mode", async (value) => {
      await this.setCopMode(value);
    });

    this.registerCapabilityListener("cop_temperature_limit", async (value) => {
      await this.setCopTemperatureLimit(value);
    });

    this.registerCapabilityListener("target_temperature", async (value) => {
      return this.vehicleAction(this.vehicle.api.setTemps(value, value));
    });

    this.registerCapabilityListener("steering_wheel_heater", async (value) => {
      switch (value) {
        case "0":
          return this.vehicleAction(
            this.vehicle.api.setSteeringWheelHeater(false),
          );
        case "1":
          return this.vehicleAction(
            this.vehicle.api.setSteeringWheelHeatLevel(1),
          );
        case "3":
          return this.vehicleAction(
            this.vehicle.api.setSteeringWheelHeatLevel(3),
          );
        default:
          throw new Error("Invalid level");
      }
    });
    this.registerCapabilityListener("seat_heater.front_left", async (value) => {
      return this.vehicleAction(
        this.vehicle.api.setSeatHeater("front_left", Number(value)),
      );
    });

    this.registerCapabilityListener(
      "seat_heater.front_right",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.setSeatHeater("front_right", Number(value)),
        );
      },
    );
    this.registerCapabilityListener("seat_heater.rear_left", async (value) => {
      return this.vehicleAction(
        this.vehicle.api.setSeatHeater("rear_left", Number(value)),
      );
    });
    this.registerCapabilityListener("seat_heater.rear_right", async (value) => {
      return this.vehicleAction(
        this.vehicle.api.setSeatHeater("rear_right", Number(value)),
      );
    });
    this.registerCapabilityListener(
      "seat_heater.rear_center",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.setSeatHeater("rear_center", Number(value)),
        );
      },
    );
    this.registerCapabilityListener("seat_cooler.front_left", async (value) => {
      return this.vehicleAction(
        this.vehicle.api.setSeatCooler("front_left", Number(value)),
      );
    });
    this.registerCapabilityListener(
      "seat_cooler.front_right",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.setSeatCooler("front_right", Number(value)),
        );
      },
    );

    // Charge
    this.registerCapabilityListener("evcharger_charging", async (value) => {
      return this.vehicleAction(
        value
          ? this.vehicle.api.startCharging()
          : this.vehicle.api.stopCharging(),
      );
    });

    this.registerCapabilityListener("charge_limit", async (value: number) => {
      return this.vehicleAction(
        this.vehicle.api.setChargeLimit(Math.round(value * 100)),
      );
    });

    this.registerCapabilityListener("charging_amps", async (value: number) => {
      return this.vehicleAction(this.vehicle.api.setChargingAmps(value));
    });

    this.registerCapabilityListener("onoff.charge_port", async (value) => {
      return this.vehicleAction(
        value
          ? this.vehicle.api.openChargePort()
          : this.vehicle.api.closeChargePort(),
      );
    });

    // Sentry & Valet
    this.registerCapabilityListener("onoff.sentry", async (value) => {
      return this.vehicleAction(this.vehicle.api.setSentryMode(value));
    });

    // Guest Mode
    this.registerCapabilityListener("onoff.guest_mode", async (value) => {
      return this.vehicleAction(this.vehicle.api.setGuestMode(value));
    });

    // Auto seat climate & auto steering wheel heat
    this.registerCapabilityListener(
      "onoff.auto_seat_climate_left",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.setAutoSeatClimate("front_left", value),
        );
      },
    );
    this.registerCapabilityListener(
      "onoff.auto_seat_climate_right",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.setAutoSeatClimate("front_right", value),
        );
      },
    );
    this.registerCapabilityListener(
      "onoff.auto_steering_wheel_heat",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.setAutoSteeringWheelHeat(value),
        );
      },
    );

    // Doors/Frunk/Trunk
    this.registerCapabilityListener("onoff.frunk", async (value) => {
      if (value) {
        await this.vehicleAction(this.vehicle.api.actuateTrunk("front"));
      }
      // Cannot be closed
    });

    this.registerCapabilityListener("onoff.trunk", async (_value) => {
      return this.vehicleAction(this.vehicle.api.actuateTrunk("rear"));
    });

    this.registerCapabilityListener("windowcoverings_closed", async (value) => {
      const { latitude, longitude } = this.vehicle.sse.cache?.data
        ?.Location || { latitude: 0, longitude: 0 };
      return this.vehicleAction(
        value
          ? this.vehicle.api.windowControl("close", latitude, longitude)
          : this.vehicle.api.windowControl("vent", latitude, longitude),
      );
    });

    // Cybertruck tonneau: closure() only supports the open/close endpoints,
    // not an arbitrary position, so this is the sole settable tonneau control.
    this.registerCapabilityListener(
      "windowcoverings_closed.tonneau",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.closure({ tonneau: value ? "close" : "open" }),
        );
      },
    );

    // Legacy S/X sunroof: sunRoofControl only supports vent/close/stop
    // endpoints, not an arbitrary position, so this is the sole settable
    // sunroof control (no continuous position telemetry exists to read back).
    this.registerCapabilityListener(
      "windowcoverings_closed.sunroof",
      async (value) => {
        return this.vehicleAction(
          this.vehicle.api.sunRoofControl(value ? "close" : "vent"),
        );
      },
    );

    // Buttons
    this.registerCapabilityListener("button.flash", async () => {
      return this.vehicleAction(this.vehicle.api.flashLights());
    });

    this.registerCapabilityListener("button.honk", async () => {
      return this.vehicleAction(this.vehicle.api.honkHorn());
    });

    this.registerCapabilityListener("button.keyless", async () => {
      return this.vehicleAction(this.vehicle.api.remoteStart());
    });

    this.registerCapabilityListener("button.homelink", async () => {
      const { latitude, longitude } = this.vehicle.sse.cache?.data
        ?.Location || { latitude: 0, longitude: 0 };
      return this.vehicleAction(
        this.vehicle.api.triggerHomelink(latitude, longitude),
      );
    });

    // wakeUp()'s response shape is the vehicle's own state payload, not a
    // { result, reason } envelope - route it through action() directly.
    this.registerCapabilityListener("button.wakeup", async () => {
      return this.action(this.vehicle.api.wakeUp());
    });

    // Media Play/Pause Toggle
    this.registerCapabilityListener("speaker_playing", async () => {
      return this.vehicleAction(this.vehicle.api.mediaTogglePlayback());
    });

    // Media Next Track
    this.registerCapabilityListener("speaker_next", async () => {
      return this.vehicleAction(this.vehicle.api.mediaNextTrack());
    });

    // Media Previous Track
    this.registerCapabilityListener("speaker_prev", async () => {
      return this.vehicleAction(this.vehicle.api.mediaPreviousTrack());
    });

    // Media Volume Control
    this.registerCapabilityListener("volume_set", async (value: number) => {
      this.muted = false;
      const volume = value * this.volumeMax;
      this.lastVolume = volume;
      return this.vehicleAction(this.vehicle.api.adjustVolume(volume));
    });

    // Media Mute Toggle
    this.registerCapabilityListener("volume_mute", async (value: boolean) => {
      this.muted = value;
      if (value) {
        // Mute: set volume to 0
        this.update("volume_set", 0);
        return this.vehicleAction(this.vehicle.api.adjustVolume(0));
      }
      // Unmute: restore last volume
      const volume = this.lastVolume;
      this.update("volume_set", volume / this.volumeMax);
      return this.vehicleAction(this.vehicle.api.adjustVolume(volume));
    });

    // Media Volume Step (relative, using Tesla's own reported increment)
    this.registerCapabilityListener("volume_up", async () => {
      this.muted = false;
      const volume = Math.min(
        this.volumeMax,
        this.lastVolume + this.volumeIncrement,
      );
      this.lastVolume = volume;
      return this.vehicleAction(this.vehicle.api.adjustVolume(volume));
    });

    this.registerCapabilityListener("volume_down", async () => {
      this.muted = false;
      const volume = Math.max(
        0,
        this.lastVolume - this.volumeIncrement,
      );
      this.lastVolume = volume;
      return this.vehicleAction(this.vehicle.api.adjustVolume(volume));
    });
  }

  async onUninit() {
    await super.onUninit();
    this.vehicle?.sse.off("state", this.handleVehicleState);
    this.vehicle?.sse.off("connectivity", this.handleConnectivity);
    this.sseCleanup.forEach((off) => off());
    this.sseCleanup = [];
  }

  /**
   * Filters the manifest capability list down to this vehicle's actual
   * hardware (Cybertruck tonneau and Powershare, rear seat heaters, third-row
   * heater, seat coolers) via the same predicate pairing uses. `this.vehicle`
   * isn't bound yet when this runs (called from super.onInit(), before
   * resolveAndBindVehicle()), so metadata is read directly from
   * homey.app.products instead. If that product isn't resolvable yet, VIN-
   * gated capabilities (Cybertruck hardware - VIN is always known) still
   * filter normally, but metadata-gated seat capabilities keep whatever the
   * device already has rather than widening back to the manifest default.
   */
  protected getExpectedCapabilities(): string[] {
    const capabilities = super.getExpectedCapabilities();
    const vin = this.getVin();
    const config = this.homey.app.products?.vehicles?.[vin]?.metadata?.config;
    if (config) {
      return filterVehicleCapabilities(capabilities, vin, config);
    }
    const current = new Set(this.getCapabilities());
    return capabilities.filter((cap) =>
      isMetadataGatedCapability(cap)
        ? current.has(cap)
        : isCapabilitySupported(cap, vin, undefined),
    );
  }

  /**
   * Fires charging_started/complete/stopped and plugged_in/unplugged off
   * real DetailedChargeState transitions (old != new), mirroring the
   * TeslemetryDevice.update() *_changed pattern for the cases that need
   * value-specific branching a single generic capability comparison can't
   * express.
   */
  private handleDetailedChargeState(
    value: SseData["data"]["DetailedChargeState"],
  ): void {
    if (value === undefined || value === null) return;
    const previous = this.previousDetailedChargeState;
    this.previousDetailedChargeState = value;
    this.update("evcharger_charging", ACTIVE_CHARGE_STATES.has(value));

    if (previous === undefined || previous === value) return;

    if (ACTIVE_CHARGE_STATES.has(value) && !ACTIVE_CHARGE_STATES.has(previous)) {
      this.triggerFlow("charging_started");
    } else if (value === "DetailedChargeStateComplete") {
      this.triggerFlow("charging_complete");
    } else if (value === "DetailedChargeStateStopped") {
      this.triggerFlow("charging_stopped");
    }

    if (value === "DetailedChargeStateDisconnected") {
      this.triggerFlow("unplugged");
    } else if (previous === "DetailedChargeStateDisconnected") {
      this.triggerFlow("plugged_in");
    }
  }

  /**
   * Updates measure_battery and fires the threshold-crossing triggers that
   * depend on it. battery_below carries a per-flow-card numeric argument, so
   * it always fires with {previous, current} state and lets its
   * registerRunListener (app.ts) decide whether that specific card's
   * threshold was actually crossed - charge_limit_reached has no argument,
   * so the crossing check happens here instead.
   */
  private handleBatteryLevel(value: number | undefined | null): void {
    if (value === undefined || value === null) return;
    const previous = this.getCapabilityValue("measure_battery") as
      | number
      | null;
    this.update("measure_battery", value);
    if (previous === null || previous === undefined || previous === value) {
      return;
    }

    if (this.isLive()) {
      this.homey.flow
        .getDeviceTriggerCard("battery_below")
        .trigger(this, { battery: value }, { previous, current: value })
        .catch(this.error);
    }

    const chargeLimit = this.getCapabilityValue("charge_limit") as
      | number
      | null;
    if (
      chargeLimit !== null &&
      chargeLimit !== undefined &&
      previous < chargeLimit * 100 &&
      value >= chargeLimit * 100
    ) {
      this.triggerFlow("charge_limit_reached", { battery: value });
    }
  }

  /**
   * Updates alarm_presence directly from the vehicle's own LocatedAtHome
   * signal - the Tesla-computed "is the vehicle at the active driver
   * profile's saved home location" boolean, the same field the Teslemetry
   * Home Assistant integration surfaces. No coordinates are read or
   * computed here.
   *
   * If the account hasn't granted the vehicle_location scope,
   * LocatedAtHome never arrives (cached or live) and this never runs, so
   * alarm_presence just stays at its unset/null value - an honest
   * "unknown", not a thrown error or a device marked unavailable.
   *
   * The previous value is tracked in `previousLocatedAtHome` rather than
   * read back via getCapabilityValue(), since update() writes it
   * asynchronously - a second signal arriving before the first write
   * settles would otherwise see the same stale value and could double- or
   * mis-fire the arrived/left-home triggers.
   */
  private handleLocatedAtHome(value: boolean | null | undefined): void {
    if (value === undefined || value === null) return;
    const previous = this.previousLocatedAtHome;
    this.previousLocatedAtHome = value;
    this.update("alarm_presence", value);

    if (previous === undefined || previous === value) return;
    this.triggerFlow(value ? "vehicle_arrived_home" : "vehicle_left_home");
  }

  /**
   * Updates alarm_generic.at_work from the vehicle's own LocatedAtWork
   * signal, mirroring handleLocatedAtHome. Its arrived/left-work triggers
   * (`alarm_generic.at_work_true`/`_false`) are auto-fired by Homey's
   * platform straight off this update() call - see the "Boolean system
   * capabilities" pattern in AGENTS.md - so no explicit triggerFlow() call
   * is needed here.
   */
  private handleLocatedAtWork(value: boolean | null | undefined): void {
    if (value === undefined || value === null) return;
    this.update("alarm_generic.at_work", value);
  }

  private triggerFlow(
    cardId: string,
    tokens: Record<string, unknown> = {},
  ): void {
    if (!this.isLive()) return;
    this.homey.flow
      .getDeviceTriggerCard(cardId)
      .trigger(this, tokens)
      .catch(this.error);
  }

  /** Whether the vehicle currently has a charge cable connected. */
  public isPluggedIn(): boolean {
    return (
      this.previousDetailedChargeState !== undefined &&
      this.previousDetailedChargeState !== "DetailedChargeStateDisconnected"
    );
  }

  /**
   * Shared by the thermostat_mode capability listener and the
   * set_climate_mode flow action - both drive the same underlying
   * climate/defrost/keeper commands off the same target value.
   */
  private async setThermostatMode(value: string): Promise<void> {
    const climateState =
      this.vehicle.sse.cache.data?.HvacPower === "HvacPowerStateOn";
    if (value === "off") {
      await this.vehicleAction(this.vehicle.api.stopAutoConditioning());
      return;
    }
    if (value === "auto" && !climateState) {
      await this.vehicleAction(this.vehicle.api.startAutoConditioning());
      return;
    } // else climates on, so we need to check which other state to turn off

    // Handle Defrost
    const defrostValue = defrostModeMap.get(
      this.vehicle.sse.cache.data?.DefrostMode,
    );
    if (value === "defrost") {
      if (!defrostValue) {
        await this.vehicleAction(
          this.vehicle.api.setPreconditioningMax(true, true),
        );
      }
      return;
    }
    if (defrostValue) {
      // Awaited so a failure here rejects setThermostatMode() instead of
      // becoming an unhandled rejection, and the keeper-mode command below
      // can't race a defrost-exit that hasn't actually landed yet.
      await this.vehicleAction(
        this.vehicle.api.setPreconditioningMax(false, false),
      );
    }

    // Handle Keeper
    const climateKeep = this.vehicle.sse.cache.data?.ClimateKeeperMode;
    switch (value) {
      case "keep_mode":
        if (climateKeep !== "ClimateKeeperModeStateOn") {
          await this.vehicleAction(this.vehicle.api.setClimateKeeperMode(1));
        }
        return;
      case "dog_mode":
        if (climateKeep !== "ClimateKeeperModeStateDog") {
          await this.vehicleAction(this.vehicle.api.setClimateKeeperMode(2));
        }
        return;
      case "camp_mode":
        if (climateKeep !== "ClimateKeeperModeStateParty") {
          await this.vehicleAction(this.vehicle.api.setClimateKeeperMode(3));
        }
        return;
      default:
        if (climateKeep !== "ClimateKeeperModeStateOff") {
          await this.vehicleAction(this.vehicle.api.setClimateKeeperMode(0));
        }
    }
  }

  /**
   * Shared by the cop_mode capability listener and the set_cop_mode flow
   * action - both drive the same underlying setCabinOverheatProtection()
   * command off the same target value.
   */
  private async setCopMode(value: string): Promise<void> {
    switch (value) {
      case "off":
        return this.vehicleAction(
          this.vehicle.api.setCabinOverheatProtection({
            on: false,
            fan_only: false,
          }),
        );
      case "on":
        return this.vehicleAction(
          this.vehicle.api.setCabinOverheatProtection({
            on: true,
            fan_only: false,
          }),
        );
      case "fan_only":
        return this.vehicleAction(
          this.vehicle.api.setCabinOverheatProtection({
            on: true,
            fan_only: true,
          }),
        );
      default:
        throw new Error("Invalid cabin overheat protection mode");
    }
  }

  /**
   * Shared by the cop_temperature_limit capability listener and the
   * set_cop_temperature_limit flow action. Only meaningful on vehicles with
   * config.cop_user_set_temp_supported - the capability is otherwise
   * read-only (see resolveAndBindVehicle's setCapabilityOptions call).
   */
  private async setCopTemperatureLimit(value: string): Promise<void> {
    if (!this.vehicle.metadata.config?.cop_user_set_temp_supported) {
      throw new Error(
        "Cabin overheat protection temperature limit is not supported",
      );
    }

    switch (value) {
      case "low":
        return this.vehicleAction(this.vehicle.api.setCopTemp(0));
      case "medium":
        return this.vehicleAction(this.vehicle.api.setCopTemp(1));
      case "high":
        return this.vehicleAction(this.vehicle.api.setCopTemp(2));
      default:
        throw new Error("Invalid cabin overheat protection temperature limit");
    }
  }

  /**
   * Derives software_update_status/software_update_progress from the raw
   * stream fields, mirroring the Teslemetry HA integration's streaming
   * update entity (TeslemetryStreamingUpdateEntity._async_update_progress):
   * an active download/install percentage wins, then a non-null scheduled
   * start time, then a latest version that differs from the installed one,
   * else idle. Always reads the merged cache rather than the single field
   * that just changed - the SDK updates its per-vehicle cache synchronously
   * before this signal callback runs, so every other field is already
   * current.
   */
  private recomputeSoftwareUpdateStatus(): void {
    const { data } = this.vehicle.sse.cache;
    const download = data?.SoftwareUpdateDownloadPercentComplete;
    const install = data?.SoftwareUpdateInstallationPercentComplete;
    const scheduledStartTime = data?.SoftwareUpdateScheduledStartTime;
    const installedVersion = data?.Version?.split(" ")[0];
    const latestVersion =
      data?.SoftwareUpdateVersion && data.SoftwareUpdateVersion !== " "
        ? data.SoftwareUpdateVersion
        : installedVersion;

    if (download !== undefined && download !== null && download > 0 && download < 100) {
      this.update("software_update_status", "downloading");
      this.update("software_update_progress", download / 100);
      return;
    }
    if (install !== undefined && install !== null && install > 10 && install < 100) {
      this.update("software_update_status", "installing");
      this.update("software_update_progress", install / 100);
      return;
    }
    if (scheduledStartTime !== undefined && scheduledStartTime !== null) {
      this.update("software_update_status", "scheduled");
      this.update("software_update_progress", null);
      return;
    }
    if (latestVersion && installedVersion && latestVersion !== installedVersion) {
      this.update("software_update_status", "available");
      this.update("software_update_progress", null);
      return;
    }
    this.update("software_update_status", "idle");
    this.update("software_update_progress", null);
  }

  // Public action methods for Flow cards
  public async flowFlashLights(): Promise<void> {
    await this.vehicleAction(this.vehicle.api.flashLights());
  }

  public async flowHonkHorn(): Promise<void> {
    await this.vehicleAction(this.vehicle.api.honkHorn());
  }

  public async flowStartKeylessDriving(): Promise<void> {
    await this.vehicleAction(this.vehicle.api.remoteStart());
  }

  public async flowTriggerHomelink(): Promise<void> {
    const { latitude, longitude } = this.vehicle.sse.cache?.data?.Location || {
      latitude: 0,
      longitude: 0,
    };
    await this.vehicleAction(
      this.vehicle.api.triggerHomelink(latitude, longitude),
    );
  }

  // wakeUp()'s response shape is the vehicle's own state payload, not a
  // { result, reason } envelope - route it through action() directly.
  public async flowWakeUp(): Promise<void> {
    await this.action(this.vehicle.api.wakeUp());
  }

  public async flowSetSteeringWheelHeater(level: string): Promise<void> {
    switch (level) {
      case "0":
        await this.vehicleAction(
          this.vehicle.api.setSteeringWheelHeater(false),
        );
        break;
      case "1":
        await this.vehicleAction(
          this.vehicle.api.setSteeringWheelHeatLevel(1),
        );
        break;
      case "3":
        await this.vehicleAction(
          this.vehicle.api.setSteeringWheelHeatLevel(3),
        );
        break;
      default:
        break;
    }
  }

  public async flowStartCharging(): Promise<void> {
    await this.vehicleAction(this.vehicle.api.startCharging());
  }

  public async flowStopCharging(): Promise<void> {
    await this.vehicleAction(this.vehicle.api.stopCharging());
  }

  public async flowSetChargeLimit(percentage: number): Promise<void> {
    await this.vehicleAction(
      this.vehicle.api.setChargeLimit(Math.round(percentage)),
    );
  }

  public async flowSetChargingAmps(amps: number): Promise<void> {
    await this.vehicleAction(this.vehicle.api.setChargingAmps(amps));
  }

  public async flowEnableScheduledCharging(time: string): Promise<void> {
    await this.vehicleAction(
      this.vehicle.api.setScheduledCharging(true, timeArgToMinutesOfDay(time)),
    );
  }

  public async flowDisableScheduledCharging(): Promise<void> {
    await this.vehicleAction(this.vehicle.api.setScheduledCharging(false, 0));
  }

  public async flowEnableScheduledDeparture(args: {
    departureTime: string;
    preconditioningEnabled: boolean;
    preconditioningWeekdaysOnly: boolean;
    offPeakChargingEnabled: boolean;
    offPeakChargingWeekdaysOnly: boolean;
    endOffPeakTime: string;
  }): Promise<void> {
    await this.vehicleAction(
      this.vehicle.api.setScheduledDeparture({
        enable: true,
        departure_time: timeArgToMinutesOfDay(args.departureTime),
        preconditioning_enabled: args.preconditioningEnabled,
        preconditioning_weekdays_only: args.preconditioningWeekdaysOnly,
        off_peak_charging_enabled: args.offPeakChargingEnabled,
        off_peak_charging_weekdays_only: args.offPeakChargingWeekdaysOnly,
        end_off_peak_time: timeArgToMinutesOfDay(args.endOffPeakTime),
      }),
    );
  }

  public async flowDisableScheduledDeparture(): Promise<void> {
    await this.vehicleAction(
      this.vehicle.api.setScheduledDeparture({
        enable: false,
        departure_time: 0,
      }),
    );
  }

  // PIN arguments are handed straight to the Teslemetry SDK call and never
  // otherwise touched - never pass `pin` to this.log/this.error or any other
  // string built from these methods.
  public async flowEnableValetMode(pin: string): Promise<void> {
    await this.vehicleAction(this.vehicle.api.setValetMode(true, pin));
  }

  public async flowDisableValetMode(pin: string): Promise<void> {
    await this.vehicleAction(this.vehicle.api.setValetMode(false, pin));
  }

  public async flowActivateSpeedLimit(pin: string): Promise<void> {
    await this.vehicleAction(this.vehicle.api.speedLimitActivate(pin));
  }

  public async flowDeactivateSpeedLimit(pin: string): Promise<void> {
    await this.vehicleAction(this.vehicle.api.speedLimitDeactivate(pin));
  }

  public async flowNavigateToAddress(address: string): Promise<void> {
    await this.vehicleAction(
      this.vehicle.api.navigationRequest({ value: address }),
    );
  }

  public async flowSetCabinTemperature(temperature: number): Promise<void> {
    await this.vehicleAction(
      this.vehicle.api.setTemps(temperature, temperature),
    );
  }

  public async flowSetClimateMode(mode: string): Promise<void> {
    await this.setThermostatMode(mode);
  }

  public async flowSetCopMode(mode: string): Promise<void> {
    await this.setCopMode(mode);
  }

  public async flowSetCopTemperatureLimit(limit: string): Promise<void> {
    await this.setCopTemperatureLimit(limit);
  }

  public async flowSetSeatHeater(
    seat: "front_left" | "front_right" | "rear_left" | "rear_right" | "rear_center",
    level: string,
  ): Promise<void> {
    await this.vehicleAction(this.vehicle.api.setSeatHeater(seat, Number(level)));
  }

  public async flowSetSeatCooler(
    seat: "front_left" | "front_right",
    level: string,
  ): Promise<void> {
    await this.vehicleAction(this.vehicle.api.setSeatCooler(seat, Number(level)));
  }

  /**
   * Gated on the current software_update_status, not just Tesla's own
   * command rejection - mirrors the Teslemetry HA integration's update
   * entity, which only offers install while status is "available" or
   * "scheduled". An offset of 0 means "install now" (HA's async_install
   * does the same).
   */
  public async flowInstallSoftwareUpdate(): Promise<void> {
    const status = this.getCapabilityValue("software_update_status");
    if (status !== "available" && status !== "scheduled") {
      throw new Error(
        "No software update is available or scheduled to install",
      );
    }
    return this.vehicleAction(this.vehicle.api.scheduleSoftwareUpdate(0));
  }

  /**
   * Gated on the current software_update_status: Tesla only accepts a
   * cancel while a download is in progress or an install is scheduled but
   * not yet running, mirroring flowInstallSoftwareUpdate's gate above.
   */
  public async flowCancelSoftwareUpdate(): Promise<void> {
    const status = this.getCapabilityValue("software_update_status");
    if (status !== "downloading" && status !== "scheduled") {
      throw new Error(
        "No software update is downloading or scheduled to cancel",
      );
    }
    return this.vehicleAction(this.vehicle.api.cancelSoftwareUpdate());
  }
}

import {
  SseConnectivity,
  SseData,
  SseState,
  TeslemetryVehicleStream,
  VehicleDetails,
} from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

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

const MILES_TO_KILOMETERS = 1.609344;
const MPH_TO_METERS_PER_SECOND = 0.44704;
const ATM_TO_BAR = 1.01325;

const ACTIVE_CHARGE_STATES = new Set<SseData["data"]["DetailedChargeState"]>([
  "DetailedChargeStateStarting",
  "DetailedChargeStateCharging",
]);

export default class VehicleDevice extends TeslemetryDevice {
  private vehicle!: VehicleDetails;
  private volumeMax: number = 10.333;
  private muted: boolean = false;
  private lastVolume: number = 0.5;

  /**
   * The last DetailedChargeState signal value. Not exposed as a capability -
   * "plugged in" has no Homey capability of its own, so the raw enum is the
   * only way to detect the Disconnected <-> anything-else transition.
   */
  private previousDetailedChargeState?: SseData["data"]["DetailedChargeState"];

  private sseCleanup: Array<() => void> = [];

  private readonly onSignal: TeslemetryVehicleStream["onSignal"] = (
    field,
    callback,
  ) => {
    const off = this.vehicle.sse.onSignal(field, callback);
    this.sseCleanup.push(off);
    return off;
  };

  private readonly handleVehicleState = (value: SseState) => {
    if (value?.state) this.update("vehicle_state", value.state);
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

    try {
      const vehicle = this.homey.app.products?.vehicles?.[this.getData().vin];
      if (!vehicle) throw new Error("No vehicle found");
      this.vehicle = vehicle;

      this.setCapabilityOptions("onoff.frunk", {
        ...this.driver.manifest.capabilitiesOptions["onoff.frunk"],
        setable: !!this.vehicle.metadata.config?.can_actuate_trunks,
      }).catch(this.error);
      this.setCapabilityOptions("onoff.trunk", {
        ...this.driver.manifest.capabilitiesOptions["onoff.trunk"],
        setable: !!this.vehicle.metadata.config?.can_actuate_trunks,
      }).catch(this.error);
    } catch (e) {
      this.log("Failed to initialize Vehicle device");
      this.error(e);
      this.setUnavailable(this.homey.__("error.invalid_refresh_token")).catch(
        this.error,
      );
      return;
    }

    // --- Signals (Incoming Data) ---

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

    // Lock & Sentry & Security
    this.onSignal("Locked", (value) => this.update("locked", value));
    this.onSignal("SentryMode", (value) => {
      this.update("onoff.sentry", value !== "SentryModeStateOff");
      this.update("alarm_motion", value === "SentryModeStatePanic");
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

    this.onSignal(
      this.vehicle.metadata.config!.rhd
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

    // Navigation
    this.onSignal("DestinationName", (value) =>
      this.update("navigation_destination", value ?? ""),
    );
    this.onSignal("MinutesToArrival", (value) =>
      this.update("minutes_to_arrival", value),
    );

    // Guest Mode
    this.onSignal("GuestModeEnabled", (value) =>
      this.update("onoff.guest_mode", value),
    );

    // Vehicle State & Connectivity
    this.vehicle.sse.on("state", this.handleVehicleState);
    this.vehicle.sse.on("connectivity", this.handleConnectivity);

    // Media Volume
    this.onSignal("MediaAudioVolume", (value) => {
      if (value !== undefined && value !== null) {
        const normalizedVolume = value / this.volumeMax;
        this.lastVolume = normalizedVolume;
        if (!this.muted) {
          this.update("volume_set", normalizedVolume);
        }
      }
    });

    this.onSignal("MediaAudioVolumeMax", (value) => {
      if (value !== undefined && value !== null) {
        this.volumeMax = value;
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

    // --- Capability Listeners (Actions) ---

    // Locked
    this.registerCapabilityListener("locked", async (value) => {
      return this.action(
        value
          ? this.vehicle.api.lockDoors()
          : this.vehicle.api.unlockDoors(),
      );
    });

    // Climate
    this.registerCapabilityListener("thermostat_mode", async (value) => {
      // Handle Climate
      const climateState =
        this.vehicle.sse.cache.data?.HvacPower === "HvacPowerStateOn";
      if (value === "off") {
        await this.action(
          this.vehicle.api
            .stopAutoConditioning()
            .then(this.handleApiResponse),
        );
        return;
      }
      if (value === "auto" && !climateState) {
        await this.action(
          this.vehicle.api
            .startAutoConditioning()
            .then(this.handleApiResponse),
        );
        return;
      } // else climates on, so we need to check which other state to turn off

      // Handle Defrost
      const defrostValue = defrostModeMap.get(
        this.vehicle.sse.cache.data?.DefrostMode,
      );
      if (value === "defrost") {
        if (!defrostValue) {
          await this.action(
            this.vehicle.api
              .setPreconditioningMax(true, true)
              .then(this.handleApiResponse),
          );
        }
        return;
      }
      if (defrostValue) {
        this.action(
          this.vehicle.api
            .setPreconditioningMax(false, false)
            .then(this.handleApiResponse),
        );
      }

      // Handle Keeper
      const climateKeep = this.vehicle.sse.cache.data?.ClimateKeeperMode;
      switch (value) {
        case "keep_mode":
          if (climateKeep !== "ClimateKeeperModeStateOn") {
            await this.action(
              this.vehicle.api
                .setClimateKeeperMode(1)
                .then(this.handleApiResponse),
            );
          }
          return;
        case "dog_mode":
          if (climateKeep !== "ClimateKeeperModeStateDog") {
            await this.action(
              this.vehicle.api
                .setClimateKeeperMode(2)
                .then(this.handleApiResponse),
            );
          }
          return;
        case "camp_mode":
          if (climateKeep !== "ClimateKeeperModeStateParty") {
            await this.action(
              this.vehicle.api
                .setClimateKeeperMode(3)
                .then(this.handleApiResponse),
            );
          }
          return;
        default:
          if (climateKeep !== "ClimateKeeperModeStateOff") {
            await this.action(
              this.vehicle.api
                .setClimateKeeperMode(0)
                .then(this.handleApiResponse),
            );
          }
      }
    });

    this.registerCapabilityListener("target_temperature", async (value) => {
      return this.action(
        this.vehicle.api.setTemps(value, value).then(this.handleApiResponse),
      );
    });

    this.registerCapabilityListener("steering_wheel_heater", async (value) => {
      switch (value) {
        case "0":
          return this.action(this.vehicle.api.setSteeringWheelHeater(false));
        case "1":
          return this.action(this.vehicle.api.setSteeringWheelHeatLevel(1));
        case "3":
          return this.action(this.vehicle.api.setSteeringWheelHeatLevel(3));
        default:
          throw new Error("Invalid level");
      }
    });
    this.registerCapabilityListener("seat_heater.front_left", async (value) => {
      return this.action(
        this.vehicle.api.setSeatHeater("front_left", Number(value)),
      );
    });

    this.registerCapabilityListener(
      "seat_heater.front_right",
      async (value) => {
        return this.action(
          this.vehicle.api.setSeatHeater("front_right", Number(value)),
        );
      },
    );
    this.registerCapabilityListener("seat_heater.rear_left", async (value) => {
      return this.action(
        this.vehicle.api.setSeatHeater("rear_left", Number(value)),
      );
    });
    this.registerCapabilityListener("seat_heater.rear_right", async (value) => {
      return this.action(
        this.vehicle.api.setSeatHeater("rear_right", Number(value)),
      );
    });
    this.registerCapabilityListener(
      "seat_heater.rear_center",
      async (value) => {
        return this.action(
          this.vehicle.api.setSeatHeater("rear_center", Number(value)),
        );
      },
    );
    this.registerCapabilityListener("seat_cooler.front_left", async (value) => {
      return this.action(
        this.vehicle.api.setSeatCooler("front_left", Number(value)),
      );
    });
    this.registerCapabilityListener(
      "seat_cooler.front_right",
      async (value) => {
        return this.action(
          this.vehicle.api.setSeatCooler("front_right", Number(value)),
        );
      },
    );

    // Charge
    this.registerCapabilityListener("evcharger_charging", async (value) => {
      return this.action(
        value
          ? this.vehicle.api.startCharging()
          : this.vehicle.api.stopCharging(),
      );
    });

    this.registerCapabilityListener("charge_limit", async (value: number) => {
      return this.action(
        this.vehicle.api.setChargeLimit(Math.round(value * 100)),
      );
    });

    this.registerCapabilityListener("charging_amps", async (value: number) => {
      return this.action(this.vehicle.api.setChargingAmps(value));
    });

    this.registerCapabilityListener("onoff.charge_port", async (value) => {
      return this.action(
        value
          ? this.vehicle.api.openChargePort()
          : this.vehicle.api.closeChargePort(),
      );
    });

    // Sentry & Valet
    this.registerCapabilityListener("onoff.sentry", async (value) => {
      return this.action(this.vehicle.api.setSentryMode(value));
    });

    // Guest Mode
    this.registerCapabilityListener("onoff.guest_mode", async (value) => {
      return this.action(this.vehicle.api.setGuestMode(value));
    });

    // Doors/Frunk/Trunk
    this.registerCapabilityListener("onoff.frunk", async (value) => {
      if (value) {
        await this.action(this.vehicle.api.actuateTrunk("front"));
      }
      // Cannot be closed
    });

    this.registerCapabilityListener("onoff.trunk", async (_value) => {
      return this.action(this.vehicle.api.actuateTrunk("rear"));
    });

    this.registerCapabilityListener("windowcoverings_closed", async (value) => {
      const { latitude, longitude } = this.vehicle.sse.cache?.data
        ?.Location || { latitude: 0, longitude: 0 };
      return this.action(
        value
          ? this.vehicle.api.windowControl("close", latitude, longitude)
          : this.vehicle.api.windowControl("vent", latitude, longitude),
      );
    });

    // Buttons
    this.registerCapabilityListener("button.flash", async () => {
      return this.action(this.vehicle.api.flashLights());
    });

    this.registerCapabilityListener("button.honk", async () => {
      return this.action(this.vehicle.api.honkHorn());
    });

    this.registerCapabilityListener("button.keyless", async () => {
      return this.action(this.vehicle.api.remoteStart());
    });

    this.registerCapabilityListener("button.homelink", async () => {
      const { latitude, longitude } = this.vehicle.sse.cache?.data
        ?.Location || { latitude: 0, longitude: 0 };
      return this.action(
        this.vehicle.api.triggerHomelink(latitude, longitude),
      );
    });

    this.registerCapabilityListener("button.wakeup", async () => {
      return this.action(this.vehicle.api.wakeUp());
    });

    // Media Play/Pause Toggle
    this.registerCapabilityListener("speaker_playing", async () => {
      return this.action(this.vehicle.api.mediaTogglePlayback());
    });

    // Media Next Track
    this.registerCapabilityListener("speaker_next", async () => {
      return this.action(this.vehicle.api.mediaNextTrack());
    });

    // Media Previous Track
    this.registerCapabilityListener("speaker_prev", async () => {
      return this.action(this.vehicle.api.mediaPreviousTrack());
    });

    // Media Volume Control
    this.registerCapabilityListener("volume_set", async (value: number) => {
      this.muted = false;
      const volume = value * this.volumeMax;
      return this.action(this.vehicle.api.adjustVolume(volume));
    });

    // Media Mute Toggle
    this.registerCapabilityListener("volume_mute", async (value: boolean) => {
      this.muted = value;
      if (value) {
        // Mute: set volume to 0
        this.update("volume_set", 0);
        return this.action(this.vehicle.api.adjustVolume(0));
      }
      // Unmute: restore last volume
      const volume = this.lastVolume * this.volumeMax;
      this.update("volume_set", this.lastVolume);
      return this.action(this.vehicle.api.adjustVolume(volume));
    });
  }

  async onUninit() {
    await super.onUninit();
    this.vehicle.sse.off("state", this.handleVehicleState);
    this.vehicle.sse.off("connectivity", this.handleConnectivity);
    this.sseCleanup.forEach((off) => off());
    this.sseCleanup = [];
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

    this.homey.flow
      .getDeviceTriggerCard("battery_below")
      .trigger(this, { battery: value }, { previous, current: value })
      .catch(this.error);

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

  private triggerFlow(
    cardId: string,
    tokens: Record<string, unknown> = {},
  ): void {
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

  // Public action methods for Flow cards
  public async flowFlashLights(): Promise<void> {
    await this.action(this.vehicle.api.flashLights());
  }

  public async flowHonkHorn(): Promise<void> {
    await this.action(this.vehicle.api.honkHorn());
  }

  public async flowStartKeylessDriving(): Promise<void> {
    await this.action(this.vehicle.api.remoteStart());
  }

  public async flowTriggerHomelink(): Promise<void> {
    const { latitude, longitude } = this.vehicle.sse.cache?.data?.Location || {
      latitude: 0,
      longitude: 0,
    };
    await this.action(this.vehicle.api.triggerHomelink(latitude, longitude));
  }

  public async flowWakeUp(): Promise<void> {
    await this.action(this.vehicle.api.wakeUp());
  }

  public async flowSetSteeringWheelHeater(level: string): Promise<void> {
    switch (level) {
      case "0":
        await this.action(this.vehicle.api.setSteeringWheelHeater(false));
        break;
      case "1":
        await this.action(this.vehicle.api.setSteeringWheelHeatLevel(1));
        break;
      case "3":
        await this.action(this.vehicle.api.setSteeringWheelHeatLevel(3));
        break;
      default:
        break;
    }
  }

  public async flowStartCharging(): Promise<void> {
    await this.action(this.vehicle.api.startCharging());
  }

  public async flowStopCharging(): Promise<void> {
    await this.action(this.vehicle.api.stopCharging());
  }

  public async flowSetChargeLimit(percentage: number): Promise<void> {
    await this.action(this.vehicle.api.setChargeLimit(Math.round(percentage)));
  }

  public async flowSetChargingAmps(amps: number): Promise<void> {
    await this.action(this.vehicle.api.setChargingAmps(amps));
  }
}

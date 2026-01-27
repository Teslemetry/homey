import { SseData, VehicleDetails } from "@teslemetry/api";
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

export default class VehicleDevice extends TeslemetryDevice {
  private vehicle!: VehicleDetails;
  private volumeMax: number = 10.333;
  private muted: boolean = false;
  private lastVolume: number = 0.5;

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
      return;
    }

    // --- Signals (Incoming Data) ---

    // Battery & Range
    this.vehicle.sse.onSignal("BatteryLevel", (value) =>
      this.update("measure_battery", value),
    );
    this.vehicle.sse.onSignal("EstBatteryRange", (value) =>
      this.update("measure_distance.range", value),
    );

    // Charging
    this.vehicle.sse.onSignal("DetailedChargeState", (value) =>
      this.update(
        "evcharger_charging",
        value === "DetailedChargeStateStarting" ||
          value === "DetailedChargeStateCharging",
      ),
    );
    this.vehicle.sse.onSignal("ChargerVoltage", (value) =>
      this.update("measure_voltage", value),
    );
    this.vehicle.sse.onSignal("ChargeCurrentRequest", (value) =>
      this.update("measure_current", value),
    );
    this.vehicle.sse.onSignal("ChargeLimitSoc", (value) => {
      if (value !== undefined && value !== null) {
        this.update("charge_limit", value / 100);
      }
    });
    this.vehicle.sse.onSignal("ChargeAmps", (value) =>
      this.update("charging_amps", value),
    );
    this.vehicle.sse.onSignal("TimeToFullCharge", (value) => {
      if (value !== undefined && value !== null) {
        this.update("time_to_full_charge", value * 60);
      }
    });

    // AC Charging
    this.vehicle.sse.onSignal("ACChargingEnergyIn", (value) =>
      this.update("meter_power", value),
    );
    this.vehicle.sse.onSignal("ACChargingPower", (value) =>
      this.update("measure_power", value ? value * 1000 : value),
    );

    // DC Charging
    this.vehicle.sse.onSignal("DCChargingEnergyIn", (value) =>
      this.update("meter_power", value),
    );
    this.vehicle.sse.onSignal("DCChargingPower", (value) =>
      this.update("measure_power", value ? value * 1000 : value),
    );

    // Lock & Sentry & Security
    this.vehicle.sse.onSignal("Locked", (value) =>
      this.update("locked", value),
    );
    this.vehicle.sse.onSignal("SentryMode", (value) => {
      this.update("onoff.sentry", value !== "SentryModeStateOff");
      this.update("alarm_motion", value === "SentryModeStatePanic");
    });

    this.vehicle.sse.onSignal("ChargePortLatch", (value) =>
      // 'Engaged' -> Locked?
      this.update("locked.charge_latch", chargePortLatchMap.get(value)),
    );
    this.vehicle.sse.onSignal("ChargePortDoorOpen", (value) =>
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

    this.vehicle.sse.onSignal("HvacPower", (value) =>
      handleThermostatMode("HvacPower", value),
    );
    this.vehicle.sse.onSignal("DefrostMode", (value) =>
      handleThermostatMode("DefrostMode", value),
    );
    this.vehicle.sse.onSignal("ClimateKeeperMode", (value) =>
      handleThermostatMode("ClimateKeeperMode", value),
    );

    this.vehicle.sse.onSignal(
      this.vehicle.metadata.config!.rhd
        ? "HvacRightTemperatureRequest"
        : "HvacLeftTemperatureRequest",
      (value) => this.update("target_temperature", value),
    );
    this.vehicle.sse.onSignal("InsideTemp", (value) =>
      this.update("measure_temperature", value),
    );
    this.vehicle.sse.onSignal("OutsideTemp", (value) =>
      this.update("measure_temperature.outside", value),
    );
    this.vehicle.sse.onSignal("HvacSteeringWheelHeatLevel", (value) =>
      this.update("steering_wheel_heater", String(value)),
    );
    this.vehicle.sse.onSignal("SeatHeaterLeft", (value) =>
      this.update("seat_heater.front_left", String(value)),
    );
    this.vehicle.sse.onSignal("SeatHeaterRight", (value) =>
      this.update("seat_heater.front_right", String(value)),
    );
    this.vehicle.sse.onSignal("SeatHeaterRearLeft", (value) =>
      this.update("seat_heater.rear_left", String(value)),
    );
    this.vehicle.sse.onSignal("SeatHeaterRearRight", (value) =>
      this.update("seat_heater.rear_right", String(value)),
    );
    this.vehicle.sse.onSignal("SeatHeaterRearCenter", (value) =>
      this.update("seat_heater.rear_center", String(value)),
    );
    this.vehicle.sse.onSignal("ClimateSeatCoolingFrontLeft", (value) =>
      this.update("seat_cooler.front_left", String(value)),
    );
    this.vehicle.sse.onSignal("ClimateSeatCoolingFrontRight", (value) =>
      this.update("seat_cooler.front_right", String(value)),
    );

    // Doors & Windows (Assuming Signal names)
    this.vehicle.sse.onSignal("DoorState", (value) => {
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

    this.vehicle.sse.onSignal("FdWindow", handleWindow);
    this.vehicle.sse.onSignal("FpWindow", handleWindow);
    this.vehicle.sse.onSignal("RdWindow", handleWindow);
    this.vehicle.sse.onSignal("RpWindow", handleWindow);

    // Tire Pressure (TPMS)
    this.vehicle.sse.onSignal("TpmsPressureFl", (value) =>
      this.update("measure_pressure.fl", value),
    );
    this.vehicle.sse.onSignal("TpmsPressureFr", (value) =>
      this.update("measure_pressure.fr", value),
    );
    this.vehicle.sse.onSignal("TpmsPressureRl", (value) =>
      this.update("measure_pressure.rl", value),
    );
    this.vehicle.sse.onSignal("TpmsPressureRr", (value) =>
      this.update("measure_pressure.rr", value),
    );

    // Vehicle Status
    this.vehicle.sse.onSignal("Odometer", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_distance.odometer", value * 1000); // km to m
      }
    });
    this.vehicle.sse.onSignal("VehicleSpeed", (value) => {
      if (value !== undefined && value !== null) {
        this.update("measure_speed", value / 3.6); // km/h to m/s
      }
    });
    this.vehicle.sse.onSignal("Gear", (value) => {
      if (value === "ShiftStateP") this.update("gear", "P");
      else if (value === "ShiftStateR") this.update("gear", "R");
      else if (value === "ShiftStateN") this.update("gear", "N");
      else if (value === "ShiftStateD") this.update("gear", "D");
    });

    // Navigation
    this.vehicle.sse.onSignal("DestinationName", (value) =>
      this.update("navigation_destination", value ?? ""),
    );
    this.vehicle.sse.onSignal("MinutesToArrival", (value) =>
      this.update("minutes_to_arrival", value),
    );

    // Guest Mode
    this.vehicle.sse.onSignal("GuestModeEnabled", (value) =>
      this.update("onoff.guest_mode", value),
    );

    // Vehicle State & Connectivity
    this.vehicle.sse.on("state", (value) => {
      if (value?.state) this.update("vehicle_state", value.state);
    });
    this.vehicle.sse.on("connectivity", (value) => {
      if (value.networkInterface === "WiFi") {
        this.update("wifi_connected", value.status === "connected");
      } else if (value.networkInterface === "Cellular") {
        this.update("cellular_connected", value.status === "connected");
      }
    });

    // Media Volume
    this.vehicle.sse.onSignal("MediaAudioVolume", (value) => {
      if (value !== undefined && value !== null) {
        const normalizedVolume = value / this.volumeMax;
        this.lastVolume = normalizedVolume;
        if (!this.muted) {
          this.update("volume_set", normalizedVolume);
        }
      }
    });

    this.vehicle.sse.onSignal("MediaAudioVolumeMax", (value) => {
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

    this.vehicle.sse.onSignal("MediaPlaybackStatus", handlePlaybackStatus);
    this.vehicle.sse.onSignal("CenterDisplay", handlePlaybackStatus);

    // Media Track Information
    this.vehicle.sse.onSignal("MediaNowPlayingTitle", (value) => {
      this.update("speaker_track", value ?? "");
    });

    this.vehicle.sse.onSignal("MediaNowPlayingArtist", (value) => {
      this.update("speaker_artist", value ?? "");
    });

    this.vehicle.sse.onSignal("MediaNowPlayingAlbum", (value) => {
      this.update("speaker_album", value ?? "");
    });

    // Media Duration and Position (convert ms to seconds)
    this.vehicle.sse.onSignal("MediaNowPlayingDuration", (value) => {
      if (value !== undefined && value !== null) {
        this.update("speaker_duration", value / 1000);
      }
    });

    this.vehicle.sse.onSignal("MediaNowPlayingElapsed", (value) => {
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
    this.vehicle.sse.data.removeAllListeners();
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
}

import { VehicleDetails } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

export default class MediaDevice extends TeslemetryDevice {
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
    } catch (e) {
      this.log("Failed to initialize Media device");
      this.error(e);
      return;
    }

    // --- Signals (Incoming Data) ---

    // Volume
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

    // Playback Status
    this.vehicle.sse.onSignal("MediaPlaybackStatus", (value) => {
      // MediaPlaybackStatus enum: MediaStatusUnknown, MediaStatusStopped, MediaStatusPlaying, MediaStatusPaused
      const isPlaying = value === "MediaStatusPlaying";
      this.update("speaker_playing", isPlaying);
    });

    // Track Information
    this.vehicle.sse.onSignal("MediaNowPlayingTitle", (value) => {
      this.update("speaker_track", value ?? "");
    });

    this.vehicle.sse.onSignal("MediaNowPlayingArtist", (value) => {
      this.update("speaker_artist", value ?? "");
    });

    this.vehicle.sse.onSignal("MediaNowPlayingAlbum", (value) => {
      this.update("speaker_album", value ?? "");
    });

    // Duration and Position (convert ms to seconds)
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

    // --- Capability Listeners (Outgoing Commands) ---

    // Play/Pause Toggle
    this.registerCapabilityListener("speaker_playing", async () => {
      await this.vehicle.api.mediaTogglePlayback().catch(this.handleApiError);
    });

    // Next Track
    this.registerCapabilityListener("speaker_next", async () => {
      await this.vehicle.api.mediaNextTrack().catch(this.handleApiError);
    });

    // Previous Track
    this.registerCapabilityListener("speaker_prev", async () => {
      await this.vehicle.api.mediaPreviousTrack().catch(this.handleApiError);
    });

    // Volume Control
    this.registerCapabilityListener("volume_set", async (value: number) => {
      this.muted = false;
      const volume = value * this.volumeMax;
      await this.vehicle.api.adjustVolume(volume).catch(this.handleApiError);
    });

    // Mute Toggle
    this.registerCapabilityListener("volume_mute", async (value: boolean) => {
      this.muted = value;
      if (value) {
        // Mute: set volume to 0
        await this.vehicle.api.adjustVolume(0).catch(this.handleApiError);
        this.update("volume_set", 0);
      } else {
        // Unmute: restore last volume
        const volume = this.lastVolume * this.volumeMax;
        await this.vehicle.api.adjustVolume(volume).catch(this.handleApiError);
        this.update("volume_set", this.lastVolume);
      }
    });
  }

  async onUninit() {
    this.vehicle?.sse?.data?.removeAllListeners();
  }
}

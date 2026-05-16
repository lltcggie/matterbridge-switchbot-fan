/**
 * Copyright 2026 lltcggie
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import AsyncLock from 'async-lock';
import { bridgedNode, fanDevice, MatterbridgeDynamicPlatform, MatterbridgeEndpoint } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { FanControl, PowerSource } from 'matterbridge/matter/clusters';
import { SwitchbotDevice } from 'node-switchbot';

import { SwitchBotMatterDevice } from './SwitchBotMatterDevice.js';

// SwitchBot Circulator Fan preset modes (from node-switchbot OpenAPI / pyswitchbot constants).
const FAN_MODE_NORMAL = 1;
const FAN_MODE_NATURAL = 2;
const FAN_MODE_SLEEP = 3;
const FAN_MODE_BABY = 4;

// Command bytes for the SwitchBot Circulator Fan (BLE).
// Layout: 0x57 0x0F 0x41 <opcode> [args...]
const CMD_TURN_ON = Buffer.from([0x57, 0x0f, 0x41, 0x01, 0x01]);
const CMD_TURN_OFF = Buffer.from([0x57, 0x0f, 0x41, 0x01, 0x02]);
const CMD_START_OSCILLATION = Buffer.from([0x57, 0x0f, 0x41, 0x02, 0x01, 0x01, 0xff]);
const CMD_STOP_OSCILLATION = Buffer.from([0x57, 0x0f, 0x41, 0x02, 0x01, 0x02, 0xff]);

function buildSetModeCommand(mode: number): Buffer {
  // SLEEP/BABY use a 4-byte payload (no trailing 0xFF) in pyswitchbot.
  if (mode === FAN_MODE_SLEEP || mode === FAN_MODE_BABY) {
    return Buffer.from([0x57, 0x0f, 0x41, 0x03, 0x01, mode]);
  }
  return Buffer.from([0x57, 0x0f, 0x41, 0x03, 0x01, mode, 0xff]);
}

function buildSetPercentageCommand(percentage: number): Buffer {
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  return Buffer.from([0x57, 0x0f, 0x41, 0x03, 0x02, clamped]);
}

interface FanAdvertisementState {
  isOn: boolean;
  mode: number; // 1..4
  oscillating: boolean;
  oscillatingHorizontal: boolean;
  oscillatingVertical: boolean;
  battery: number; // 0..100
  speed: number; // 0..100
}

/**
 * Parses the Circulator Fan manufacturer data into a state object.
 *
 * Input layout (raw `peripheral.advertisement.manufacturerData` from noble):
 *   [0..1] manufacturer/company ID (0x0969 → 2409, SwitchBot)
 *   [2..7] device MAC address (6 bytes)
 *   [8..]  device-specific payload
 *
 * pyswitchbot operates on `mfr_data[6:]`, which corresponds to the bytes
 * starting at offset 8 here because Home Assistant's bluetooth integration
 * already strips the 2-byte company ID before handing the buffer over.
 *
 * Device-specific payload layout (offset 8+ in the raw buffer):
 *   [0] sequence number
 *   [1] bit 7  = isOn
 *       bits 6..4 = mode
 *       bits 3..2 = nightLight (unused for Circulator Fan)
 *       bit 1  = oscillate left/right
 *       bit 0  = oscillate up/down
 *   [2] bits 6..0 = battery percentage
 *   [3] bits 6..0 = speed percentage
 *
 * @param {Buffer | undefined | null} mfrData - Manufacturer-data buffer from the BLE advertisement (company ID included).
 * @returns {FanAdvertisementState | null} Parsed state, or null if the buffer is too short.
 */
function parseFanManufacturerData(mfrData: Buffer | undefined | null): FanAdvertisementState | null {
  if (!mfrData || mfrData.length < 12) return null;
  const deviceData = mfrData.subarray(8);
  if (deviceData.length < 4) return null;

  const byte1 = deviceData[1];
  const isOn = (byte1 & 0b10000000) !== 0;
  const mode = (byte1 & 0b01110000) >> 4;
  const oscillatingHorizontal = (byte1 & 0b00000010) !== 0;
  const oscillatingVertical = (byte1 & 0b00000001) !== 0;
  const battery = deviceData[2] & 0b01111111;
  const speed = deviceData[3] & 0b01111111;

  return {
    isOn,
    mode,
    oscillating: oscillatingHorizontal || oscillatingVertical,
    oscillatingHorizontal,
    oscillatingVertical,
    battery,
    speed,
  };
}

function fanModeFromSpeed(speed: number, isOn: boolean): FanControl.FanMode {
  if (!isOn || speed === 0) return FanControl.FanMode.Off;
  if (speed <= 33) return FanControl.FanMode.Low;
  if (speed <= 66) return FanControl.FanMode.Medium;
  return FanControl.FanMode.High;
}

class SwitchBotFanMatterDevice implements SwitchBotMatterDevice {
  private device: SwitchbotDevice;
  private startScan: () => Promise<void>;
  private log: AnsiLogger;
  private readonly address: string;
  public readonly name: string;

  public RootEndpoint!: MatterbridgeEndpoint;
  public Endpoint!: MatterbridgeEndpoint;

  private refreshLock = new AsyncLock({ timeout: 1000 * 4 });
  private commandLock = new AsyncLock({ timeout: 1000 * 10 });

  // Mirror the last advertised state so that we can decide which BLE command
  // a Matter attribute write should translate to.
  private lastState: FanAdvertisementState | null = null;

  // Track whether the device is currently in a wind-emulating mode (NATURAL or
  // SLEEP). Matter's percentSetting writes should not override these modes
  // unless the user explicitly clears the wind setting.
  private currentWindSetting: { sleepWind: boolean; naturalWind: boolean } = { sleepWind: false, naturalWind: false };

  constructor(device: SwitchbotDevice, address: string, startScan: () => Promise<void>, log: AnsiLogger) {
    this.device = device;
    this.address = address.toLowerCase();
    this.startScan = startScan;
    this.log = log;

    this.name = `Circulator Fan ${this.address}`;
  }

  public async createEndpoint(platform: MatterbridgeDynamicPlatform) {
    const idKey = `switchbot-fan-${this.name}`;

    const hash = createHash('sha256').update(idKey).digest('hex');
    const serial = hash.substring(0, 16);

    this.RootEndpoint = new MatterbridgeEndpoint([bridgedNode], { id: idKey }, platform.config.debug as boolean)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        this.name,
        serial,
        platform.matterbridge.aggregatorVendorId,
        platform.matterbridge.aggregatorVendorName,
        `SwitchBot Circulator Fan`,
        parseInt(platform.version.replace(/\D/g, '')),
        platform.version === '' ? 'Unknown' : platform.version,
        parseInt(platform.matterbridge.matterbridgeVersion.replace(/\D/g, '')),
        platform.matterbridge.matterbridgeVersion,
      );
    this.RootEndpoint.addRequiredClusterServers();

    this.Endpoint = this.RootEndpoint.addChildDeviceType('main', [fanDevice], { id: `${idKey}-main` }, platform.config.debug as boolean);

    // fanDevice requires Identify, Groups, FanControl. Register them
    // explicitly so we can install the *complete* FanControl variant (with
    // the MultiSpeed/Rocking/Wind/AirflowDirection features). Calling
    // addRequiredClusterServers() here would install the default FanControl
    // implementation first, which then conflicts with the complete one
    // ("incompatible implementation already exists").
    this.Endpoint.createDefaultIdentifyClusterServer()
      .createDefaultGroupsClusterServer()
      // createCompleteFanControlClusterServer constructs the cluster with the
      // Auto feature always enabled, so the FanModeSequence MUST include
      // Auto (OffLowMedHighAuto / OffLowHighAuto / OffHighAuto). Passing
      // OffLowMedHigh here fails with an enum-value-conformance error.
      .createCompleteFanControlClusterServer(
        FanControl.FanMode.Off,
        FanControl.FanModeSequence.OffLowMedHighAuto,
        0, // percentSetting
        0, // percentCurrent
        100, // speedMax
        0, // speedSetting
        0, // speedCurrent
        { rockLeftRight: true, rockUpDown: false, rockRound: false }, // rockSupport
        { rockLeftRight: false, rockUpDown: false, rockRound: false }, // rockSetting
        { sleepWind: true, naturalWind: true }, // windSupport
        { sleepWind: false, naturalWind: false }, // windSetting
        FanControl.AirflowDirection.Forward,
      )
      .createDefaultPowerSourceBatteryClusterServer(100 * 2, PowerSource.BatChargeLevel.Ok);

    this.Endpoint.addCommandHandler('identify', async ({ request: { identifyTime } }) => {
      this.log.debug(`Command identify called identifyTime: ${identifyTime}`);
    });
  }

  public async registerWithPlatform(platform: MatterbridgeDynamicPlatform) {
    platform.setSelectDevice(this.RootEndpoint.serialNumber ?? '', this.RootEndpoint.deviceName ?? '', undefined, 'hub');

    if (platform.validateDevice(this.RootEndpoint.deviceName ?? '')) {
      await platform.registerDevice(this.RootEndpoint);
    }

    // Subscriptions have to be installed *after* the endpoint has been
    // registered with Matterbridge — only then does the underlying matter.js
    // endpoint reach the Active lifecycle state and expose its event emitters
    // through `endpoint.events[clusterName][attribute]`. Subscribing before
    // that silently no-ops because the events map does not contain the
    // fanControl cluster yet.
    await this.installSubscriptions();
  }

  private async installSubscriptions() {
    const okFanMode = await this.Endpoint.subscribeAttribute(
      'fanControl',
      'fanMode',
      (newValue: FanControl.FanMode, oldValue: FanControl.FanMode, context: { offline?: boolean }) => {
        this.log.info(`Fan fanMode attribute changed: ${oldValue} -> ${newValue} (offline=${context.offline === true})`);
        if (context.offline === true) return;
        if (newValue === oldValue) return;
        void this.handleFanModeChange(newValue);
      },
      this.Endpoint.log,
    );
    this.log.debug(`subscribe fanMode -> ${okFanMode}`);

    const okPercent = await this.Endpoint.subscribeAttribute(
      'fanControl',
      'percentSetting',
      (newValue: number | null, oldValue: number | null, context: { offline?: boolean }) => {
        this.log.info(`Fan percentSetting attribute changed: ${oldValue} -> ${newValue} (offline=${context.offline === true})`);
        if (context.offline === true) return;
        if (newValue === oldValue) return;
        if (newValue === null) return;
        void this.handlePercentChange(newValue);
      },
      this.Endpoint.log,
    );
    this.log.debug(`subscribe percentSetting -> ${okPercent}`);

    const okRock = await this.Endpoint.subscribeAttribute(
      'fanControl',
      'rockSetting',
      (
        newValue: { rockLeftRight: boolean; rockUpDown: boolean; rockRound: boolean },
        oldValue: { rockLeftRight: boolean; rockUpDown: boolean; rockRound: boolean },
        context: { offline?: boolean },
      ) => {
        this.log.info(`Fan rockSetting attribute changed: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)} (offline=${context.offline === true})`);
        if (context.offline === true) return;
        const newOsc = newValue?.rockLeftRight === true;
        const oldOsc = oldValue?.rockLeftRight === true;
        if (newOsc === oldOsc) return;
        void this.handleOscillationChange(newOsc);
      },
      this.Endpoint.log,
    );
    this.log.debug(`subscribe rockSetting -> ${okRock}`);

    const okWind = await this.Endpoint.subscribeAttribute(
      'fanControl',
      'windSetting',
      (newValue: { sleepWind: boolean; naturalWind: boolean }, oldValue: { sleepWind: boolean; naturalWind: boolean }, context: { offline?: boolean }) => {
        this.log.info(`Fan windSetting attribute changed: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)} (offline=${context.offline === true})`);
        if (context.offline === true) return;
        const newSleep = newValue?.sleepWind === true;
        const newNatural = newValue?.naturalWind === true;
        const oldSleep = oldValue?.sleepWind === true;
        const oldNatural = oldValue?.naturalWind === true;
        if (newSleep === oldSleep && newNatural === oldNatural) return;
        this.currentWindSetting = { sleepWind: newSleep, naturalWind: newNatural };
        void this.handleWindSettingChange(newSleep, newNatural);
      },
      this.Endpoint.log,
    );
    this.log.debug(`subscribe windSetting -> ${okWind}`);
  }

  public async destroy() {}

  public async handleAdvertisement(ad: any) {
    // For Circulator Fan node-switchbot's parser returns null, so the platform
    // passes the raw advertisement shape with `manufacturerData` to us. Be
    // permissive about the input shape.
    const mfrData: Buffer | undefined = ad?.manufacturerData ?? ad?.serviceData?.manufacturerData;
    if (mfrData) {
      this.log.debug(`SwitchBot Fan (${this.address}) raw manufacturerData (${mfrData.length}B): ${mfrData.toString('hex')}`);
    }
    const state = parseFanManufacturerData(mfrData);
    if (!state) return;
    this.log.debug(
      `SwitchBot Fan (${this.address}) parsed: isOn=${state.isOn} mode=${state.mode} speed=${state.speed} battery=${state.battery} oscH=${state.oscillatingHorizontal} oscV=${state.oscillatingVertical}`,
    );

    await this.refreshLock.acquire('refresh', async () => {
      this.lastState = state;
      const promises: Promise<unknown>[] = [];

      const fanMode = fanModeFromSpeed(state.speed, state.isOn);
      const percent = state.isOn ? state.speed : 0;

      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'fanMode', fanMode, this.Endpoint.log));
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', percent, this.Endpoint.log));
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'percentCurrent', percent, this.Endpoint.log));
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'speedSetting', percent, this.Endpoint.log));
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'speedCurrent', percent, this.Endpoint.log));

      promises.push(
        this.Endpoint.updateAttribute(FanControl.Cluster.id, 'rockSetting', { rockLeftRight: state.oscillatingHorizontal, rockUpDown: false, rockRound: false }, this.Endpoint.log),
      );

      const sleepWind = state.mode === FAN_MODE_SLEEP;
      const naturalWind = state.mode === FAN_MODE_NATURAL;
      this.currentWindSetting = { sleepWind, naturalWind };
      promises.push(this.Endpoint.updateAttribute(FanControl.Cluster.id, 'windSetting', { sleepWind, naturalWind }, this.Endpoint.log));

      const battery = state.battery;
      const batteryValue = battery * 2;
      promises.push(this.Endpoint.updateAttribute(PowerSource.Cluster.id, 'batPercentRemaining', batteryValue, this.Endpoint.log));
      const chargeLevel = battery >= 20 ? PowerSource.BatChargeLevel.Ok : battery >= 10 ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Critical;
      promises.push(this.Endpoint.updateAttribute(PowerSource.Cluster.id, 'batChargeLevel', chargeLevel, this.Endpoint.log));

      await Promise.all(promises);
    });
  }

  private async sendCommand(label: string, buf: Buffer): Promise<void> {
    await this.commandLock.acquire('command', async () => {
      this.log.debug(`SwitchBot Fan (${this.address}) sending ${label}: ${buf.toString('hex')}`);
      try {
        await this.device.command(buf);
      } catch (e) {
        this.log.error(`SwitchBot Fan (${this.address}) failed to send ${label}: ${(e as Error).message ?? e}`);
      } finally {
        // noble stops scanning automatically once we connect to a peripheral.
        // Restart it so we keep getting advertisement updates.
        await this.startScan();
      }
    });
  }

  private async handleFanModeChange(fanMode: FanControl.FanMode): Promise<void> {
    if (fanMode === FanControl.FanMode.Off) {
      await this.sendCommand('TURN_OFF', CMD_TURN_OFF);
      return;
    }

    // Make sure the fan is on, then translate the Matter fan mode into a
    // percentage. We avoid changing the SwitchBot preset mode here so that
    // users can keep NATURAL/SLEEP active via the wind setting.
    const wasOn = this.lastState?.isOn === true;
    if (!wasOn) {
      await this.sendCommand('TURN_ON', CMD_TURN_ON);
    }

    let targetPercent: number | null = null;
    switch (fanMode) {
      case FanControl.FanMode.Low:
        targetPercent = 33;
        break;
      case FanControl.FanMode.Medium:
        targetPercent = 66;
        break;
      case FanControl.FanMode.High:
      case FanControl.FanMode.Auto:
        // SwitchBot circulator fans have no real Auto mode, so we just leave
        // them running at full speed when the controller requests Auto.
        targetPercent = 100;
        break;
      default:
        break;
    }
    if (targetPercent !== null) {
      await this.sendCommand(`SET_PERCENTAGE(${targetPercent})`, buildSetPercentageCommand(targetPercent));
    }
  }

  private async handlePercentChange(percent: number): Promise<void> {
    if (percent <= 0) {
      await this.sendCommand('TURN_OFF', CMD_TURN_OFF);
      return;
    }
    const wasOn = this.lastState?.isOn === true;
    if (!wasOn) {
      await this.sendCommand('TURN_ON', CMD_TURN_ON);
    }
    await this.sendCommand(`SET_PERCENTAGE(${percent})`, buildSetPercentageCommand(percent));
  }

  private async handleOscillationChange(oscillating: boolean): Promise<void> {
    await this.sendCommand(oscillating ? 'START_OSCILLATION' : 'STOP_OSCILLATION', oscillating ? CMD_START_OSCILLATION : CMD_STOP_OSCILLATION);
  }

  private async handleWindSettingChange(sleepWind: boolean, naturalWind: boolean): Promise<void> {
    // The Matter spec allows only one of sleepWind / naturalWind to be set at
    // a time in practice; if both are off, restore the SwitchBot NORMAL mode.
    let mode: number;
    if (sleepWind) {
      mode = FAN_MODE_SLEEP;
    } else if (naturalWind) {
      mode = FAN_MODE_NATURAL;
    } else {
      mode = FAN_MODE_NORMAL;
    }
    await this.sendCommand(`SET_MODE(${mode})`, buildSetModeCommand(mode));
  }
}

export { SwitchBotFanMatterDevice, parseFanManufacturerData, FanAdvertisementState };

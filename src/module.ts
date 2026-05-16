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

import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { SwitchBotBLE, SwitchbotDevice } from 'node-switchbot';

import { SwitchBotMatterDevice } from './SwitchBotMatterDevice.js';
import switchBotMatterFactory from './SwitchBotMatterFactory.js';

// Service-data prefix bytes that identify a SwitchBot Circulator Fan.
//   '~' (0x7E) — battery / standalone version (W3800510)
//   '^' (0x5E) — rechargeable / AC version    (W3800511)
const CIRCULATOR_FAN_MODEL_BYTES = new Set<number>([0x7e, 0x5e]);

/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 *
 * @param {PlatformMatterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger. This is used for logging messages in a format that can be displayed with ANSI color codes and in the frontend.
 * @param {PlatformConfig} config - The platform configuration.
 * @returns {SwitchBotPlatform} - An instance of the MatterbridgeAccessory or MatterbridgeDynamicPlatform class. This is the main interface for interacting with the Matterbridge system.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): SwitchBotPlatform {
  return new SwitchBotPlatform(matterbridge, log, config);
}

interface CircFanInfo {
  serviceDataModel: string;
  manufacturerData: Buffer | null;
}

function inspectPeripheralForCircFan(peripheral: any): CircFanInfo | null {
  const ad = peripheral?.advertisement;
  if (!ad) return null;

  const sdEntries: Array<{ uuid: string; data: Buffer }> = ad.serviceData ?? [];
  for (const entry of sdEntries) {
    const data: Buffer | undefined = entry?.data;
    if (!data || data.length < 1) continue;
    const firstByte = data.readUInt8(0);
    if (CIRCULATOR_FAN_MODEL_BYTES.has(firstByte)) {
      return {
        serviceDataModel: data.subarray(0, 1).toString('utf8'),
        manufacturerData: ad.manufacturerData ?? null,
      };
    }
  }
  return null;
}

function normalizePeripheralAddress(peripheral: any): string {
  const raw: string = peripheral?.address ?? '';
  if (raw !== '') return raw.replace(/-/g, ':').toLowerCase();

  // Fallback: derive from manufacturer data (matches node-switchbot's logic).
  const mfr: Buffer | undefined = peripheral?.advertisement?.manufacturerData;
  if (mfr && mfr.length >= 8) {
    const hex = mfr.toString('hex').slice(4, 16);
    if (hex !== '') {
      return (hex.match(/.{1,2}/g)?.join(':') ?? '').toLowerCase();
    }
  }
  return '';
}

export class SwitchBotPlatform extends MatterbridgeDynamicPlatform {
  private deviceList: Record<string, SwitchBotMatterDevice> = {};
  private isConfigValid = false;
  private switchBotBLE: SwitchBotBLE | null = null;

  private switchBotDeviceAddresses: string[] = [];
  private nobleDiscoverHandler: ((peripheral: any) => void) | null = null;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    if (config.switchBotDeviceAddresses) {
      this.switchBotDeviceAddresses = config.switchBotDeviceAddresses as string[];
      // 小文字に統一
      this.switchBotDeviceAddresses = this.switchBotDeviceAddresses.map((addr) => addr.toLowerCase());
    }

    // Verify that Matterbridge is the correct version
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.3.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.3.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.isConfigValid = true;
  }

  override async onStart(reason?: string) {
    this.log.debug(`onStart called with reason: ${reason ?? 'none'}`);

    this.switchBotBLE = new SwitchBotBLE();

    if (!this.isConfigValid) {
      throw new Error('Plugin not configured yet, configure first, then restart.');
    }

    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.debug(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);

    this.log.debug(`onShutdown called with reason: ${reason ?? 'none'}`);

    if (this.switchBotBLE?.noble && this.nobleDiscoverHandler) {
      try {
        this.switchBotBLE.noble.removeListener('discover', this.nobleDiscoverHandler);
      } catch {
        // ignore
      }
      this.nobleDiscoverHandler = null;
    }

    for (const device of Object.values(this.deviceList)) {
      await device.destroy();
    }

    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async discoverDevices() {
    this.log.debug('Discovering devices...');

    try {
      // SwitchBot Circulator Fan advertisements are not parsed by node-switchbot,
      // so its high-level discover() returns nothing for them. We listen on
      // noble's raw 'discover' event instead. Awaiting nobleInitialized makes
      // sure the noble instance has been created and powered on.
      await this.switchBotBLE!.nobleInitialized;
      const noble: any = this.switchBotBLE!.noble;
      if (!noble) {
        throw new Error('Noble BLE library failed to initialize.');
      }

      this.nobleDiscoverHandler = (peripheral: any) => {
        void this.handleNoblePeripheral(peripheral);
      };
      noble.on('discover', this.nobleDiscoverHandler);

      await this.startScan();
    } catch (e: any) {
      this.log.error(`Failed to start BLE scanning, Error: ${e.message ?? e}`);
    }
  }

  private async handleNoblePeripheral(peripheral: any) {
    const fanInfo = inspectPeripheralForCircFan(peripheral);
    if (!fanInfo) return;

    const address = normalizePeripheralAddress(peripheral);
    if (address === '') return;

    if (!this.switchBotDeviceAddresses.includes(address)) {
      // Only log the skip once per unknown address to avoid log spam.
      if (!this.skippedAddresses.has(address)) {
        this.skippedAddresses.add(address);
        this.log.info(`Skipping SwitchBot device not in configured addresses: ${address}`);
      }
      // Forward to existing devices keyed by address; if not registered yet,
      // there is nothing more to do.
      return;
    }

    let matterDevice = this.deviceList[address];
    if (!matterDevice) {
      try {
        this.log.debug(`Creating SwitchBot device: ${address}`);
        const startScan = this.startScan.bind(this);
        const switchbotDevice = new SwitchbotDevice(peripheral, this.switchBotBLE!.noble);
        matterDevice = (await switchBotMatterFactory(switchbotDevice, fanInfo.serviceDataModel, address, startScan, this.log)) as SwitchBotMatterDevice;
        if (matterDevice === undefined) {
          this.log.error(`Failed to create SwitchBot device: ${address}`);
          return;
        }

        await matterDevice.createEndpoint(this);
        this.deviceList[address] = matterDevice;
        await matterDevice.registerWithPlatform(this);
      } catch (error) {
        this.log.error(`Error discovering device ${address}: ${(error as Error).message}`);
        return;
      }
    }

    // Push the latest advertisement into the device for state updates.
    await matterDevice.handleAdvertisement({
      address,
      manufacturerData: fanInfo.manufacturerData,
      serviceData: { model: fanInfo.serviceDataModel },
    });
  }

  public async startScan() {
    await this.switchBotBLE!.nobleInitialized;
    const noble: any = this.switchBotBLE!.noble;
    if (!noble) return;
    try {
      await noble.startScanningAsync([], true);
    } catch (e: any) {
      this.log.error(`Failed to startScanning: ${e.message ?? e}`);
    }
  }

  private skippedAddresses = new Set<string>();
}

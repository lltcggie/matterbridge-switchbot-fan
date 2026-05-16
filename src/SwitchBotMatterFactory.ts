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

import { AnsiLogger } from 'matterbridge/logger';
import { SwitchbotDevice } from 'node-switchbot';

import { SwitchBotFanMatterDevice } from './SwitchBotFanMatterDevice.js';
import { SwitchBotMatterDevice } from './SwitchBotMatterDevice.js';

// Service-data prefix characters used by SwitchBot Circulator Fans. These come
// from the SwitchBot BLE protocol — '~' (0x7E) for the battery / standalone
// version and '^' (0x5E) for the rechargeable / AC version. node-switchbot's
// own model enum does not (yet) cover these, which is why we detect them by
// the raw character here.
const CIRCULATOR_FAN_MODELS = new Set<string>(['~', '^']);

export default async function switchBotMatterFactory(
  device: SwitchbotDevice,
  serviceDataModel: string,
  address: string,
  startScan: () => Promise<void>,
  log: AnsiLogger,
): Promise<SwitchBotMatterDevice | undefined> {
  if (CIRCULATOR_FAN_MODELS.has(serviceDataModel)) {
    log.debug(`SwitchBot - switchBotMatterFactory: Detected device type: 'SwitchBotFanMatterDevice' (model='${serviceDataModel}')`);
    return new SwitchBotFanMatterDevice(device, address, startScan, log);
  }
  throw new Error(`SwitchBot - switchBotMatterFactory('${address}'): Unknown device type: '${serviceDataModel}'`);
}

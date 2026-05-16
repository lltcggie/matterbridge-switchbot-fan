# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 言語ポリシー

このリポジトリで作業するときは、思考(reasoning / thinking)とユーザーへの応答の両方を **日本語** で行ってください。コード内のコメントやコミットメッセージも、既存のスタイルに合わせて日本語を基本とします(英語の固有名詞・API 名・ログメッセージはそのまま英語で構いません)。

## このリポジトリの概要

[Matterbridge](https://github.com/Luligu/matterbridge) のプラグインで、SwitchBot サーキュレーター(W3800510 / W3800511、たとえば サーキュレーター Lite)を BLE 経由で Matter ファブリックに公開します。BLE 広告の受信と GATT 書き込みのみで動作し、SwitchBot クラウドは使用しません。

## よく使うコマンド

```bash
npm install                  # 依存パッケージのインストール(matterbridge 本体は依存に含めない)
npm link matterbridge        # 型解決のためグローバルインストール済みの matterbridge にリンク
npm run build                # tsc -> dist/
npm run watch                # tsc --watch
npm run lint                 # eslint(--max-warnings=0 のゼロ警告ポリシー)
npm run lint:fix             # eslint --fix
npm run format               # prettier --write .
npm run test                 # jest(現状テストファイルなし。--passWithNoTests 無しでは exit 1)

npm run matterbridge:add     # このプラグインを matterbridge に登録(matterbridge -add .)
npm run matterbridge:remove
npm run matterbridge:enable
npm run matterbridge:disable
npm run matterbridge:list
```

`matterbridge` は **`dependencies` / `devDependencies` のいずれにも入れてはいけません**。Matterbridge のプラグインマネージャは同梱されたプラグインを拒否し、CLI が `package.json not found` を返します。常にグローバルインストール済みの `matterbridge` に `npm link matterbridge` でリンクしてください。

開発サイクル: TypeScript を編集 → `npm run build` → matterbridge を再起動。ホットリロードはありません。

## ランタイム要件

- Node ≥ 20(`engines` で範囲を指定)
- Linux + BlueZ。非 root プロセスで動かす場合は `cap_net_raw` ケーパビリティが必要(`sudo setcap cap_net_raw+eip $(readlink -f $(which node))` もしくは systemd の `AmbientCapabilities=CAP_NET_RAW`)
- 設定の `switchBotDeviceAddresses` に BLE MAC が列挙されているデバイスのみを対象とします。それ以外のデバイスは初回のみ `Skipping SwitchBot device not in configured addresses: …` とログに出して以降無視します。

## アーキテクチャ

`src/` 配下の 4 ファイルが層構造を成しています。初見の場合はこの順に読んでください:

1. **[src/module.ts](src/module.ts)** — `SwitchBotPlatform`(Matterbridge の `MatterbridgeDynamicPlatform` サブクラス)。ライフサイクルと BLE 検出ループを担います。
2. **[src/SwitchBotMatterFactory.ts](src/SwitchBotMatterFactory.ts)** — 周辺機器のサービスデータ先頭バイトから具体的な Matter デバイスラッパーを返します。
3. **[src/SwitchBotMatterDevice.ts](src/SwitchBotMatterDevice.ts)** — 各デバイスラッパーが実装するインタフェース: `createEndpoint` / `registerWithPlatform` / `handleAdvertisement` / `destroy`。
4. **[src/SwitchBotFanMatterDevice.ts](src/SwitchBotFanMatterDevice.ts)** — サーキュレーターの実装(Matter `fanDevice` + `FanControl` クラスタの complete 版 + バッテリーの `PowerSource`)。サーキュレーターの BLE プロトコル知識はすべてここに集約されています。

### node-switchbot の高レベル API をバイパスしている理由

`node-switchbot` の `Advertising.parseServiceData()` はサービスデータ先頭バイトが `~`(0x7E、W3800510)/ `^`(0x5E、W3800511)の広告を `null` として返します。そのため `discover()` も `startScan()` + `onadvertisement` もサーキュレーターを拾えません。プラットフォームは以下の手順で回避しています:

- `switchBotBLE.nobleInitialized` を await してから、`switchBotBLE.noble.on('discover', …)` に独自リスナを直接アタッチ
- `noble.startScanningAsync([], true)` を呼ぶ(サービス UUID フィルタなし、重複許可)。これで OS から全広告パケットを受け取ります
- サービスデータ先頭バイトが `~` / `^` の peripheral については手動で `SwitchbotDevice(peripheral, noble)` を生成し、その `command(buffer)`(接続→書き込み→通知待ち→切断 を一括で行うヘルパー)を利用。広告本体は `handleAdvertisement` に流して状態を更新します

### BLE 広告のバイトレイアウト

サーキュレーターの状態は `peripheral.advertisement.manufacturerData` から解析しますが、ここには pyswitchbot の Home Assistant 連携が解析前に剥がしている **企業 ID 2 バイト** が含まれています。よって pyswitchbot の `mfr_data[6:]` 相当はここでは `mfrData.subarray(8)` です(企業 ID 2 B + MAC 6 B = 8 B)。デバイス固有ペイロードのレイアウト:

```
[0] シーケンス番号
[1] bit 7   電源 ON
    bits 6..4 SwitchBot プリセットモード(1=NORMAL, 2=NATURAL, 3=SLEEP, 4=BABY)
    bit 1   左右首振り
    bit 0   上下首振り(サーキュレーターでは未使用)
[2] bits 6..0 バッテリー残量(%)
[3] bits 6..0 風速(%)
```

新しいファームウェアで解析がズレた場合は、まずデバッグログから `manufacturerData` の生 16 進列をダンプしてください。オフセットを当てずっぽうで信用しないこと。

### BLE コマンドの形式

コマンドは [SwitchBotFanMatterDevice.ts](src/SwitchBotFanMatterDevice.ts) 内でインラインに構築し、`SwitchbotDevice.command(buf)` で送信します。レイアウトは `57 0F 41 <opcode> [args…]`:

| 操作          | バイト列                       |
|---------------|--------------------------------|
| 電源 ON       | `57 0F 41 01 01`               |
| 電源 OFF      | `57 0F 41 01 02`               |
| 首振り開始    | `57 0F 41 02 01 01 FF`         |
| 首振り停止    | `57 0F 41 02 01 02 FF`         |
| モード設定 N  | `57 0F 41 03 01 <mode> [FF]`   |
| 風量設定      | `57 0F 41 03 02 <0..100>`      |

SLEEP / BABY モードは末尾の `FF` を付けません(4 バイトペイロード)。NORMAL / NATURAL は付けます。これは pyswitchbot に倣ったものです。

### Matter ↔ SwitchBot の対応

- `fanMode`(`Off/Low/Medium/High/Auto`)→ 電源 ON/OFF + `SET_PERCENTAGE` を 33/66/100。`Auto` はデバイスに真の自動モードがないため 100% 扱いです。
- `percentSetting` 0..100 → 0 で `TURN_OFF`、それ以外は必要に応じて `TURN_ON` を打ってから `SET_PERCENTAGE`。
- `rockSetting.rockLeftRight` → `START/STOP_OSCILLATION`。サーキュレーターは 1 軸のみのため `rockUpDown` / `rockRound` は非対応として広告します。
- `windSetting.sleepWind` / `windSetting.naturalWind` → SwitchBot の SLEEP / NATURAL プリセット。両方 off で NORMAL に戻します。
- 広告から得たバッテリー残量は `PowerSource.batPercentRemaining`(Matter は半パーセント単位なので 2 倍)と `batChargeLevel`(20% / 10% 閾値で Ok / Warning / Critical)に反映します。

### 間違いやすい落とし穴

- **`createCompleteFanControlClusterServer` は Auto feature を常時有効にする。** `FanModeSequence.OffLowMedHigh`(Auto 非対応)を渡すと Matter の conformance チェックで `[!AUT].a` エラーになります。`*Auto` 系列(現状 `OffLowMedHighAuto`)を使ってください。
- **子エンドポイントで `Endpoint.addRequiredClusterServers()` を complete 版 FanControl の登録より先に呼ばないこと。** 先に呼ぶとデフォルト(Auto+Step のみ)の FanControl サーバが登録され、その後の complete 版が `Cannot require … because incompatible implementation already exists` で衝突します。必須クラスタ(Identify, Groups, FanControl)は手動で登録してください。
- **`subscribeAttribute` は `createEndpoint` 内ではなく `registerDevice` の解決後に呼ぶこと。** 登録前は matter.js 側のエンドポイントが `Active` 状態になっておらず、`endpoint.events[clusterName][attribute$Changed]` が未生成のため、購読は黙って no-op になります。現コードでは `platform.registerDevice(this.RootEndpoint)` の後に `installSubscriptions()` で購読を仕掛けています。
- **電源 ON 状態は BLE 広告とは別にローカルで追跡する必要がある。** Matter から `percentSetting=0` → `percentSetting=50` と立て続けに書かれると、2 つ目のコールバック発火時にはまだ次の広告が届いておらず `lastState.isOn` は `true` のままになります。`localIsOn` シャドウフラグが無いと `TURN_ON` をスキップしてしまい、ファンが止まったままになります。`TURN_ON` / `TURN_OFF` を送ったらその場で `localIsOn` を更新してください。
- **`TURN_ON` と直後の `SET_PERCENTAGE` の間には 400 ms 以上のウェイトを入れる。** これがないとファームウェアが速度コマンドを取りこぼします。`sendCommand` は `postDelayMs` 引数を受け取れます。
- **noble は周辺機器に接続している間スキャンを止める。** したがってコマンドを送る経路はすべて `sendCommand` の `finally` で `startScan()` を呼んでパッシブスキャンを再開させています。

## スキーマとパッケージング

- `matterbridge-switchbot-fan.schema.json` は Matterbridge UI で表示される設定スキーマです。ファイル名は [package.json](package.json) の `name` と一致している必要があります。
- `prepublishOnly` は `tsconfig.production.json` でビルドし直し、`package.json` から devDependencies/scripts/types を削り、`npm shrinkwrap` を実行します。リリース時にこれを迂回しないでください。

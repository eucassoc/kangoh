# walife

**顧客データベースを持たないリワードバウチャー。**

店舗は購入後にバウチャーを発行します。額面固定の署名付きクレデンシャルで、
顧客のエージェントが持つ鍵に紐づき、有効期限があります。同じプログラムの
どの店舗でも受け取れて、確認するのは公開されたプログラムに照らした発行者の
署名、保持者の署名、有効期限だけです。受け取った店舗は提示されたバウチャーを
発行店への請求の根拠として保管し、運営者は各店舗の記録から店舗間を精算します。
誰も顧客台帳を持たず、画面もありません。顧客側にあるのは鍵とウォレットで、
それはAIエージェントがもともと持っているものです。

[English](README.md)

## バウチャーとは

バウチャーは選択的開示を使わない [SD-JWT VC](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/)
です。Ed25519で署名したJWTに `vct`、`iss`、`jti`、`iat`、`exp`、`cnf`(保持者の鍵)、
`program`、`value` を載せ、末尾に `~` を付けたものです。提示するときは保持者が
署名したキーバインディングJWTを続け、そこに店舗(`aud`)と店舗のチャレンジ(`nonce`)
を入れます。コピーしたバウチャーは保持者の鍵なしでは無価値で、提示を別の店舗で
使い回すこともできません。

プログラムは運営者が公開するJSONで、参加店舗とその発行鍵、バウチャーの額面、
有効日数を書きます。

```json
{
  "name": "arcade.example",
  "value": 100,
  "validDays": 7,
  "stores": [
    { "id": "bakery.example", "key": { "kty": "OKP", "crv": "Ed25519", "x": "..." } },
    { "id": "cafe.example", "key": { "kty": "OKP", "crv": "Ed25519", "x": "..." } }
  ]
}
```

## 使い方

```sh
npm install walife
```

```ts
import { generateKey, JsonlRecorder, parseProgram, Store, Wallet, settle } from 'walife';

const programJson = await readFile('program.json', 'utf8');
const program = parseProgram(programJson);

// 店舗: 鍵、プログラム、自分の行動の追記専用の記録
const bakery = new Store({ id: 'bakery.example', privateJwk, program, programJson, recorder: new JsonlRecorder('bakery.jsonl') });
await bakery.join();                                 // 最初に一度だけ

// 購入後、レジがエージェントの鍵にバウチャーを発行する
const voucher = await bakery.issue(agentPublicJwk);  // バウチャーはエージェントへ。記録に残るのはダイジェストだけ

// 別の店舗で、エージェントがチャレンジに対して提示する
const wallet = new Wallet(agentPrivateJwk, agentPublicJwk);
const presentation = await wallet.present(voucher, 'cafe.example', cafe.challenge());
await cafe.redeem(presentation);                     // 検証し、記録し、提示内容を保管する

// 期間の終わりに、運営者が各店舗の請求から精算する
const { findings, statements } = await settle(program, programJson, [await bakery.claim(), await cafe.claim()]);
```

`settle` は各バウチャーを一度だけ、全店舗を通した時刻順で最初に記録した店舗に
支払います。それ以外はすべて、店舗の記録に紐づいた指摘になります。二つの店舗で
提示されたバウチャー、店舗の鍵で署名されているのにその店舗が発行を記録して
いないバウチャー、有効期限後に受け取られたバウチャー、記録と一致しない提示内容です。

店舗が持つのは署名鍵、記録、受け取った提示内容の三つだけで、どれも顧客を
特定しません。記録は精算のために提出するものなので、後から変更できない場所に
置きます。追記専用ファイルや、署名付きチェックポイントを持つ証跡ログは
`Recorder` インターフェイスで差し込めます。

## コマンドライン

```sh
walife keygen > bakery.json                                # 鍵ペア(秘密に保管し、公開側をプログラムに載せる)
walife issue -p program.json -k bakery.json -h agent.json  # バウチャーを標準出力へ
walife present -k agent.json --aud cafe.example --nonce N voucher.txt
walife verify -p program.json --aud cafe.example --nonce N presentation.txt
walife settle -p program.json bakery-claim.json cafe-claim.json
```

## エージェントのウォレット(MCPサーバー)

`walife-mcp` は顧客のウォレットをMCPで提供し、買い物をするエージェント自身が
バウチャーを持てるようにします。ウォレットは鍵とバウチャーを入れたファイル
(`WALIFE_WALLET`、既定は `~/.walife/wallet.json`)で、店舗には一切見えません。

```json
{ "mcpServers": { "walife": { "command": "walife-mcp" } } }
```

| ツール | 内容 |
|---|---|
| `receiving_key` | 会計時に店舗へ渡す公開鍵。店舗はこの鍵にバウチャーを発行する |
| `add_voucher` | 発行されたバウチャーを保管する。プログラムを渡せば検証してから保管する |
| `list_vouchers` | 保有バウチャーの一覧(発行店、額面、期限) |
| `present_voucher` | 店舗のチャレンジに対して提示に署名する |
| `remove_voucher` | 店舗が受領した後にバウチャーを捨てる |

## 開発

```sh
npm install
npm test
```

## ライセンス

Apache-2.0

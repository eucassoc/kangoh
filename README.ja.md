# kangoh

**顧客データベースを持たないリワードバウチャー。**

勘合(かんごう)は、日明貿易で使われた割符です。文書を二つに割って双方が
片方ずつ持ち、突き合わせて一致したときだけ正規の取引と認めました。kangoh の
バウチャーも同じで、ある店舗が発行し、別の店舗が受け取り、双方の記録を
照合して精算されます。

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
npm install kangoh
```

```ts
import { generateKey, JsonlRecorder, parseProgram, Store, Wallet, settle } from 'kangoh';

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

## 使う時点で二重使用を止める

何もしなければ、二つの店舗で提示されたバウチャーは精算で見つかり、一度だけ
支払われます。運営者の**照合サービス(registry)**があれば、二つ目の店舗はその場で
断ります。店舗はバウチャーを受け取る前に照合サービスに問い合わせ、照合サービスは
受け取り済みバウチャーのダイジェストと受け取った店舗だけを保持します。誰の
情報も持ちません。

```sh
kangoh registry --port 8788 --file claims.jsonl --token SECRET   # 運営者が動かす
```

店舗は `store.json` に `"registry": {"url": "https://...", "token": "SECRET"}` と
書くか、`StoreOptions.registry` で指定します。照合サービスに届かないときは
受け取って精算に委ね、`"required": true` なら断ります。照合サービスは記録の
上に載る便宜であって代替ではなく、精算は変わらず全店舗の記録を突き合わせます。

店舗が持つのは署名鍵、記録、受け取った提示内容の三つだけで、どれも顧客を
特定しません。記録は精算のために提出するものなので、後から変更できない場所に
置きます。追記専用ファイルや、署名付きチェックポイントを持つ証跡ログは
`Recorder` インターフェイスで差し込めます。

## コマンドライン

```sh
kangoh keygen > bakery.json                                # 鍵ペア(秘密に保管し、公開側をプログラムに載せる)
kangoh issue -p program.json -k bakery.json -h agent.json  # バウチャーを標準出力へ
kangoh present -k agent.json --aud cafe.example --nonce N voucher.txt
kangoh verify -p program.json --aud cafe.example --nonce N presentation.txt
kangoh settle -p program.json bakery-claim.json cafe-claim.json
```

## MCPサーバー

`kangoh-mcp` は三つの役割をそれぞれエージェントに提供します(1プロセスに1役割)。
画面はなく、エージェントがインターフェイスです。

```json
{
  "mcpServers": {
    "kangoh": { "command": "kangoh-mcp" },
    "kangoh-store": { "command": "kangoh-mcp", "args": ["store"], "env": { "KANGOH_STORE": "/path/to/store" } },
    "kangoh-operator": { "command": "kangoh-mcp", "args": ["operator"] }
  }
}
```

**ウォレット**(`kangoh-mcp`): 顧客のエージェントがバウチャーを持ちます。
ウォレットは鍵とバウチャーを入れたファイル(`KANGOH_WALLET`、既定は
`~/.kangoh/wallet.json`)で、店舗には一切見えません。

| ツール | 内容 |
|---|---|
| `receiving_key` | 会計時に店舗へ渡す公開鍵。店舗はこの鍵にバウチャーを発行する |
| `add_voucher` | 発行されたバウチャーを保管する。プログラムを渡せば検証してから保管する |
| `list_vouchers` | 保有バウチャーの一覧(発行店、額面、期限) |
| `present_voucher` | 店舗のチャレンジに対して提示に署名する |
| `remove_voucher` | 店舗が受領した後にバウチャーを捨てる |

**店舗**(`kangoh-mcp store`): 店舗のディレクトリ(`KANGOH_STORE`)に
`store.json`(`{"id", "privateJwk"}`)と公開されたままの `program.json` を置きます。
サーバーが `records.jsonl` と `presentations.jsonl` をそこに書きます。
このディレクトリが店舗の状態のすべてです。

| ツール | 内容 |
|---|---|
| `issue_voucher` | 購入後、顧客の受取鍵にバウチャーを発行する |
| `challenge` | 提示1回分のチャレンジ |
| `redeem_voucher` | 提示を受領する。検証し、記録し、請求の根拠として保管する |
| `claim` | 運営者に送る記録と提示内容 |

**運営者**(`kangoh-mcp operator`): 状態を持ちません。

| ツール | 内容 |
|---|---|
| `settle` | プログラムと各店舗の請求(JSONまたはファイルパス)から期間を精算する。店舗ごとの明細と、支払われない受領の指摘 |

## 開発

```sh
npm install
npm test
```

## ライセンス

Apache-2.0

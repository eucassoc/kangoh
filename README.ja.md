# kangoh

**顧客データベースを持たないリワードバウチャー。**

勘合(かんごう)は、日明貿易で使われた割符です。文書を二つに割って双方が
片方ずつ持ち、突き合わせて一致したときだけ正規の取引と認めました。kangoh の
バウチャーも同じで、ある店舗が発行し、別の店舗が受け取り、双方の記録を
照合して精算されます。

店舗は購入後にバウチャーを発行します。署名付きクレデンシャルで、顧客の
ウォレットが持つ鍵に紐づき、有効期限があります。額面は固定か、レシートに
応じて決まります。顧客のアプリがレシートを読み取り、店舗は1日分の申請を
売上と照らして署名するか、レシートに印字したQRで事前に承認しておきます。同じプログラムの
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

## なぜブロックチェーンではないのか

kangoh は、ブロックチェーンで共通ポイントを作る RaaS から生まれました。目的は
同じで、どこか一社を信じなくても、お店どうしがポイントを発行し合い精算できる
ことです。お客さまのポイントを AIエージェントやスマホのウォレットが持つなら、
そのために台帳を共有する必要はありません。

| | ブロックチェーン型 | kangoh |
|---|---|---|
| ポイント | チェーン上のトークン | お店が署名し、持ち主の鍵に結び付く VC |
| 二重使用 | 合意形成と確定待ち | 使う時点で運営者の照合サービス、事後は精算 |
| 書き換え | 合意形成と台帳の公開 | 運営者の記録を [deedlog](https://github.com/eucassoc/deedlog) の証跡にし、ウィットネスが副署(レシート申請は対応済み、照合、お釣り、精算は次の版) |
| お釣り | トランザクションで出る | 運営者が発行し精算で検証。運営者はポイントを作れない |
| 取引の見え方 | すべて公開 | 見えない。公開するのはハッシュと申請の結果だけ |
| 手数料、速さ | 手数料、確定待ち | なし、一瞬 |
| お客さまに必要なもの | 暗号資産のウォレット | エージェントのウォレット、パスキーで守るアプリ |
| 運営者が止まったら | 動き続ける | ポイントを丸ごと使うことはでき、二重使用は精算で見つかる |

手放したのは「運営者がいなくても動く」こと、得たのは速さ、手数料のなさ、
取引が誰にも見えないことです。

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
kangoh registry -p program.json --port 8788 --file claims.jsonl   # 運営者が動かす
```

店舗が使用済みにできるのは、お客さまがその店舗に提示したバウチャーだけです。
問い合わせには、お客さまがその店舗あてに署名した提示と、店舗が自分の鍵で署名した
短時間だけ有効なトークンが付き、照合サービスはどちらもプログラムに照らして
確かめます。提示されていないバウチャーは誰も使用済みにできず、発行した店舗が
自分のバウチャーを使用済みにして他店で使えなくし、支払いを逃れることもできません。

店舗は `store.json` に `"registry": {"url": "https://..."}` と
書くか、`StoreOptions.registry` で指定します。照合サービスに届かないときは
受け取って精算に委ね、`"required": true` なら断ります。照合サービスは記録の
上に載る便宜であって代替ではなく、精算は変わらず全店舗の記録を突き合わせます。

店舗が持つのは署名鍵、記録、受け取った提示内容の三つだけで、どれも顧客を
特定しません。記録は精算のために提出するものなので、後から変更できない場所に
置きます。追記専用ファイルや、署名付きチェックポイントを持つ証跡ログは
`Recorder` インターフェイスで差し込めます。

## ポイントの一部を使う(お釣り)

バウチャーは硬貨のように丸ごと使います。一部だけ使うときは、提示に使う
ポイント数と残りを受け取る新しい鍵を入れます。店舗はいつもどおり受け取り、
店舗がもともと問い合わせる運営者の照合サービスが、残りを**お釣り**として
発行します。お釣りは運営者の鍵(プログラムの `operator`)で署名され、額面は
残りの分、期限は元のバウチャーと同じで、元のバウチャーと発行した店舗を
記載しています。店舗はそれを顧客に返すだけで、受け取り損ねたウォレットは
照合サービスから取り寄せます。店舗の作業は増えません。

```sh
kangoh registry -p program.json --key operator.json   # 運営者の鍵でお釣りを発行する照合サービス
```

お釣りは店舗のバウチャーを分けるだけで、ポイントを生み出しません。元の
バウチャーを発行した店舗がすべての部分を支払い、精算は、店舗が一部受け取った
バウチャーの残りちょうどを、保持者が指定した鍵あてに一度だけ発行したお釣りだけを
認めます。運営者が勝手に署名したお釣りは指摘されます。照合サービスに届かないときは
一部の利用は断られ、丸ごとなら使えます。

## レシートからポイントを発行する

多くの店舗にはレジでクレデンシャルを手渡す手段がありませんが、レシートは
どの店舗でも出ます。プログラムに `earn` を書くと、レシートを購入の証拠にし、
署名は変わらず店舗が行います。

```json
{
  "name": "arcade.example",
  "earn": { "per": 100, "points": 1, "max": 500 },
  "validDays": 180,
  "receiptDays": 7,
  "service": "https://points.arcade.example",
  "operator": { "id": "operator.arcade.example", "key": { "...": "..." } },
  "stores": [
    { "id": "bakery.example", "key": { "...": "..." } },
    { "id": "cafe.example", "key": { "...": "..." }, "receipts": "signed" }
  ]
}
```

1. **顧客が申請する。** アプリがレシート(店舗、日時、番号、合計)を読み取り、
   申請ごとに新しい鍵を添えて運営者のレシート窓口に申請します。申請どうしは
   結び付けられません。レシートは一度しか使えず、同じ店舗、同じ日、同じ番号の
   申請は先着が有効で、後からのものはその場で重複として断られます。
2. **店舗が1日1回まとめて確認する。** その日の申請を一覧し(重複は先頭に
   エラー行として出ます)、残りを売上と照らして承認します。承認すると店舗の鍵で
   申請の鍵あてにバウチャーが署名され、レジでの発行と同じく記録されます。
   読み取り違いの金額は訂正でき、断るときは顧客に見える理由を付けます。
3. **確認が要らない店舗。** レシートに署名付きQRを印字できる店舗
   (`"receipts": "signed"`)は、印字した時点で承認しています。QRでの申請は
   店舗の次の同期で発行され、その店舗のレシートを手入力した申請は断られます。
4. **顧客がポイントを受け取り**、これまでどおりプログラム内のどの店舗でも
   使います。精算は変わらず、額面で支払われます。

バウチャーに署名した店舗がその分を支払うので、自店の売上でない申請を承認しても
店舗は得をしません。重複として断られた顧客が本物のレシートを持っていれば、
店舗に持ち込み、店舗が窓口で発行します(`issue_voucher` に額面を指定)。

窓口は運営者のサービスの中で、照合サービスと並んで動きます。

```sh
KANGOH_DESK_SECRET=... kangoh registry -p program.json --state receipts.jsonl --chain receipts.chain.jsonl
```

窓口は何にも署名せず、誰の情報も持ちません。`receipts.jsonl` にあるのは
レシート、申請の鍵、受け取られるまでのバウチャーだけです。申請の結果(受付、
重複による拒否、発行、却下)はすべて `receipts.chain.jsonl` に追記されます。
これは [deedlog](https://github.com/eucassoc/deedlog) のチェーンで、申請、店舗、
レシートの HMAC だけを持ち、金額、番号、鍵を含まないので公開できます。
`dlog` でチェックポイントを作り、副署をもらって公開すれば、顧客は自分の申請が
断られたことが公開記録にあり、後から書き換えられていないことを確かめられます。

| エンドポイント | 呼ぶ側 | 内容 |
|---|---|---|
| `POST /receipts` | アプリ | レシートを申請する(`{receipt, holder}` か `{token, holder}`)。201、重複は409、受付不可は422 |
| `GET /receipts/ID` | アプリ | 申請の状態。発行後はバウチャー |
| `GET /receipts?from=DATE` | 店舗 | 自店の申請。店舗の鍵で署名した `Authorization: Store <token>` |
| `POST /receipts/ID/issue`、`/reject` | 店舗 | バウチャーを渡す、または理由を付けて断る |

## コマンドライン

```sh
kangoh keygen > bakery.json                                # 鍵ペア(秘密に保管し、公開側をプログラムに載せる)
kangoh issue -p program.json -k bakery.json -h agent.json  # バウチャーを標準出力へ
kangoh present -k agent.json --aud cafe.example --nonce N voucher.txt
kangoh verify -p program.json --aud cafe.example --nonce N presentation.txt
kangoh settle -p program.json bakery-claim.json cafe-claim.json

# レシート(店舗のディレクトリは KANGOH_STORE)
kangoh receipt-qr -p program.json -k cafe.json --number 0007 --total 640   # レジがレシートに印字するQR
kangoh receipts                                            # その日の申請。重複をエラーとして先頭に、続いて確認待ち
kangoh receipts approve                                    # 確認待ちをすべて承認。IDを指定し --total ID=880 で金額を訂正
kangoh receipts reject ID --reason "該当するレシート番号がありません"
kangoh receipts sync                                       # 署名付きQRで申請された分を発行する
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
| `claim_receipt` | レシートでポイントを申請する。QR、または印字された店舗、日時、番号、合計 |
| `check_claims` | 店舗が発行したバウチャーを受け取る。断られた申請は理由とともに返す。受け取り損ねたお釣りも取り寄せる |
| `add_voucher` | 発行されたバウチャーを保管する。プログラムを渡せば検証してから保管する |
| `list_vouchers` | 保有バウチャーの一覧(発行店、額面、期限) |
| `present_voucher` | 店舗のチャレンジに対して提示に署名する。丸ごと、または一部 |
| `remove_voucher` | 店舗が受領した後にバウチャーを捨てる |

**店舗**(`kangoh-mcp store`): 店舗のディレクトリ(`KANGOH_STORE`)に
`store.json`(`{"id", "privateJwk"}`)と公開されたままの `program.json` を置きます。
サーバーが `records.jsonl` と `presentations.jsonl` をそこに書きます。
このディレクトリが店舗の状態のすべてです。

| ツール | 内容 |
|---|---|
| `issue_voucher` | 窓口で顧客の受取鍵にバウチャーを発行する。レシート型のプログラムでは額面を指定 |
| `challenge` | 提示1回分のチャレンジ |
| `redeem_voucher` | 提示を受領する。検証し、記録し、請求の根拠として保管する。一部利用ならお釣りを返す |
| `claim` | 運営者に送る記録と提示内容 |
| `receipts` | その日のレシート申請。重複による拒否を先頭に、続いて確認待ち |
| `approve_receipts` | 売上と合う申請にバウチャーを署名する。必要なら金額を訂正 |
| `reject_receipt` | 顧客に見える理由を付けて申請を断る |
| `sync_receipts` | 署名付きレシートQRでの申請を、確認なしで発行する |

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

# kangoh

**Reward vouchers without a customer database.**

Kangoh (勘合, "kan-go") were the tallies of Japan's medieval trade with
Ming China: a document split in two, one half held by each side, and a
shipment honoured only when the halves met. A kangoh voucher works the
same way: issued by one store, accepted by another, and settled when the
records of both are matched.

A store issues a voucher after a purchase: a signed credential, bound to a
key the customer's wallet holds, valid for a limited time. The value is fixed,
or follows the receipt: the customer's app reads the receipt, and the store
confirms the day's claims against its sales and signs them, or approved them
in advance with a QR it printed on the receipt. Any store
in the same program accepts it, checking only the issuer's signature, the
holder's signature and the expiry against the published program. The
redeeming store keeps the presentation as its claim on the issuer, and the
program operator settles between stores from the stores' records. Nobody
keeps a customer record: the customer's side is a key and a wallet, in an
app on their phone.

[日本語](README.ja.md)

## What a voucher is

A voucher is an [SD-JWT VC](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/)
with no selective disclosures: an Ed25519-signed JWT with `vct`, `iss`,
`jti`, `iat`, `exp`, `cnf` (the holder's key), `program` and `value`,
followed by `~`. A presentation adds a key binding JWT signed by the holder,
naming the store (`aud`) and the store's challenge (`nonce`). A copied
voucher is worthless without the holder's key, and a presentation cannot be
replayed to another store.

The program is a JSON document the operator publishes: the stores, the keys
they issue with, the value of a voucher or the points a receipt earns, and
how many days a voucher is valid.

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

## Why not a blockchain

Kangoh grew out of RaaS, a shared reward program built on a blockchain. The
aim is the same: shops issuing points to each other and settling without
trusting any one company. With customers' points held in a wallet on their
phone, a shared ledger is no longer needed for it:

| | On a blockchain | kangoh |
|---|---|---|
| A point | A token on the chain | A VC signed by the shop, bound to the holder's key |
| Double spend | Consensus, then finality | The operator's registry at the moment of use; settlement afterwards |
| Rewrites | Consensus and a public ledger | The operator's records as a [deedlog](https://github.com/eucassoc/deedlog) trail, cosigned by witnesses (receipt claims now; registry, change and settlement next) |
| Change | Out of the transaction | Issued by the operator, checked at settlement; the operator cannot create points |
| Visibility | Every transaction public | None; only hashes and claim outcomes are published |
| Fees, speed | Fees, waiting | None, instant |
| The customer needs | A crypto wallet | A wallet app whose key a passkey protects |
| Without the operator | Keeps running | Whole points still spend; double spends are found at settlement |

What kangoh gives up is running with no operator at all. What it gains is
speed, no fees and transactions nobody can see.

## Use

```sh
npm install kangoh
```

```ts
import { generateKey, JsonlRecorder, parseProgram, Store, Wallet, settle } from 'kangoh';

const programJson = await readFile('program.json', 'utf8');
const program = parseProgram(programJson);

// The store: its key, its program and an append-only record of what it did.
const bakery = new Store({ id: 'bakery.example', privateJwk, program, programJson, recorder: new JsonlRecorder('bakery.jsonl') });
await bakery.join();                                 // once, before anything else

// After a purchase, the store issues a voucher to the key of the customer's wallet.
const voucher = await bakery.issue(customerPublicJwk);  // the voucher goes to the wallet; only its digest is recorded

// At another store, the wallet presents it against a challenge.
const wallet = new Wallet(customerPrivateJwk, customerPublicJwk);
const presentation = await wallet.present(voucher, 'cafe.example', cafe.challenge());
await cafe.redeem(presentation);                     // verifies, records, keeps the presentation

// At the end of the period, the operator settles from the stores' claims.
const { findings, statements } = await settle(program, programJson, [await bakery.claim(), await cafe.claim()]);
```

`settle` pays each voucher once, to the first store that recorded it, in
time order across all stores. Anything else is a finding tied to the store's
record: a voucher presented at two stores, a voucher a store's key signed
but the store never recorded issuing, a voucher redeemed after it expired,
or a presentation that does not match the record of it.

## Stopping a double use at the counter

Without more, a voucher presented at two stores is found at settlement and
paid once. With the operator's **registry**, the second store refuses it on
the spot: before a store takes a voucher it asks the registry, which holds
the digests of vouchers taken and the store that took each, and nothing
about anyone.

```sh
kangoh registry -p program.json --port 8788 --file claims.jsonl   # the operator runs this
```

A store can only claim a voucher a customer presented to it. Each claim
carries the customer's presentation, signed for that store, and a
short-lived token the store signs with its own key; the registry checks both
against the program. So nobody can mark a voucher spent that was not
presented to them, and a store cannot mark the vouchers it issued as spent
to keep other stores from taking them, and paying nothing.

A store names the registry in `store.json` (`"registry": {"url": "https://..."}`)
or in `StoreOptions.registry`. If the registry cannot be reached the store
takes the voucher and leaves a double use to settlement; with
`"required": true` it refuses instead. The registry is a convenience over
the records, not a replacement: settlement still matches every store's
ledger.

A store keeps three things: its signing key, its records and the
presentations it took. None of them identifies a customer. The records are
what the store submits for settlement, so a store keeps them where they
cannot be changed afterwards; the `Recorder` interface is where an
append-only file or an evidence log with signed checkpoints plugs in.

## Using part of a voucher

A voucher is spent whole, like a coin. To use part of one, the customer's
presentation names the points used and a fresh key for the rest; the store
takes the voucher as usual, and the operator's registry, which the store
asks anyway, issues the rest as **change**: a voucher signed with the
operator's key (`operator` in the program), worth what is left, valid until
the original expires, naming the original and the store that issued it. The
store hands it back; a wallet that missed it fetches it from the registry.
The store does nothing more.

```sh
kangoh registry -p program.json --key operator.json   # the registry, issuing change with the operator's key
```

Change only splits a store's voucher; it never makes points. The store
that issued the original pays every part of it, and settlement accepts
change only if it is exactly the rest of a voucher a store redeemed in part,
issued to the key the holder named for it, once. Change the operator signs
on its own is a finding. When the registry cannot be reached, part of a
voucher is refused and the whole voucher can still be used.

## Points from receipts

Most shops have no way to hand a credential over at the till, but every shop
prints a receipt. With `earn` in the program, the receipt is the evidence of
the purchase and the store still signs the voucher:

```json
{
  "name": "arcade.example",
  "earn": { "per": 100, "points": 1, "max": 500 },
  "validDays": 180,
  "receiptDays": 7,
  "qrMinutes": 10,
  "service": "https://points.arcade.example",
  "operator": { "id": "operator.arcade.example", "key": { "...": "..." } },
  "stores": [
    { "id": "bakery.example", "key": { "...": "..." } },
    { "id": "cafe.example", "key": { "...": "..." }, "receipts": "signed" }
  ]
}
```

1. **The customer claims.** The app reads the receipt (store, time, number,
   total) and leaves a claim at the operator's receipt desk with a fresh key,
   so that no two claims can be linked. A receipt is claimed once: the first
   claim for a store, day and number goes to the store, and later ones wait
   behind it as duplicates. If the store rejects the first, the earliest
   duplicate takes its place, so a stranger who claims guessed receipt
   numbers with made-up totals blocks nobody. Once the first is issued, the
   others are rejected.
2. **The store reviews once a day.** It lists the day's claims, duplicates
   first as errors, compares the rest with its sales, and approves: each
   voucher is signed with the store's key to the claim's key and recorded,
   as at the counter. It can correct a misread total, or refuse with a
   reason the customer sees.
3. **Or nothing to review.** A store whose point of sale prints a signed QR
   on each receipt (`"receipts": "signed"`) approved the voucher when it
   printed it. Claims made with the QR are issued at the store's next sync,
   and claims typed from its receipts are refused. Whoever scans a QR first
   gets the points, as with any paper voucher, so show it on the till's
   customer display rather than printing it where it can be photographed,
   and set `qrMinutes` to how long it is shown.
4. **The customer collects** the voucher from the desk, and spends it at any
   store in the program as before. Settlement is unchanged and pays by value.

The store that signs a voucher pays it, so a store gains nothing by
approving claims that are not its sales. A receipt is evidence of a
purchase, not of who made it: someone who photographs a receipt can claim it
first. A customer whose claim was refused but who has the receipt goes to
the store, which issues at the counter (`issue_voucher` with a value).

The desk runs in the operator's service, beside the registry:

```sh
KANGOH_DESK_SECRET=... kangoh registry -p program.json --state receipts.jsonl --chain receipts.chain.jsonl
```

It signs nothing and keeps nothing about anyone: receipts, the claims' keys
and vouchers until collected, in `receipts.jsonl`. Every outcome (claimed,
refused as a duplicate, issued, rejected) is appended to `receipts.chain.jsonl`,
a [deedlog](https://github.com/eucassoc/deedlog) chain that names the claim,
the store and an HMAC of the receipt, and no totals, numbers or keys, so that
it can be published. Checkpoint, cosign and serve it with `dlog`; a customer
can then check that the refusal of their claim is on the public record and
has not been changed.

| Endpoint | Who | Does |
|---|---|---|
| `POST /receipts` | the app | Claim a receipt (`{receipt, holder}` or `{token, holder}`): 201, 409 for a duplicate, 422 refused |
| `GET /receipts/ID` | the app | The claim, with the voucher once issued |
| `GET /receipts?from=DATE` | the store | Its claims; `Authorization: Store <token>` signed with its key |
| `POST /receipts/ID/issue`, `/reject` | the store | Hand over the voucher, or refuse with a reason |

## Command line

```sh
kangoh keygen -o bakery.json                               # a key pair, readable by you only (put its public half in the program)
kangoh issue -p program.json -k bakery.json -h customer.json  # a voucher, to standard output
kangoh present -k customer.json --aud cafe.example --nonce N voucher.txt
kangoh verify -p program.json --aud cafe.example --nonce N presentation.txt
kangoh settle -p program.json bakery-claim.json cafe-claim.json

# Receipts (the store's directory is KANGOH_STORE)
kangoh receipt-qr -p program.json -k cafe.json --number 0007 --total 640   # what the point of sale prints
kangoh receipts                                            # the day's claims: duplicates as errors, then those waiting
kangoh receipts approve                                    # approve all waiting; or IDs, with --total ID=880 to correct
kangoh receipts reject ID --reason "no such receipt number"
kangoh receipts sync                                       # issue the claims made with the store's signed QR
```

## MCP servers

`kangoh-mcp` serves each of the three roles over MCP, one role per process.
They are there for AI agents that will shop online unattended; until the
phone app is out, they are also the way to try every role.

```json
{
  "mcpServers": {
    "kangoh": { "command": "kangoh-mcp" },
    "kangoh-store": { "command": "kangoh-mcp", "args": ["store"], "env": { "KANGOH_STORE": "/path/to/store" } },
    "kangoh-operator": { "command": "kangoh-mcp", "args": ["operator"] }
  }
}
```

**Wallet** (`kangoh-mcp`): an AI agent holds the vouchers for the customer. The
wallet is a file holding the key and the vouchers (`KANGOH_WALLET`, default
`~/.kangoh/wallet.json`); no store ever sees it.

| Tool | Does |
|---|---|
| `receiving_key` | The public key to give a store at checkout, so it can issue a voucher to this wallet |
| `claim_receipt` | Claim points with a receipt: its QR, or the store, time, number and total as printed |
| `check_claims` | Collect the vouchers stores have issued for the claims, the reasons for refusals, and change not handed back |
| `add_voucher` | Keep an issued voucher, verifying it against the program if given |
| `list_vouchers` | The vouchers held, with issuer, value and expiry |
| `present_voucher` | Sign a presentation to a store against its challenge, of the whole voucher or part of it |
| `remove_voucher` | Drop a voucher once the store accepted it |

**Store** (`kangoh-mcp store`): the store's directory (`KANGOH_STORE`) holds
`store.json` (`{"id", "privateJwk"}`), `program.json` as published, and the
store's `records.jsonl` and `presentations.jsonl`, which the server writes.
The directory is the store's whole state.

| Tool | Does |
|---|---|
| `issue_voucher` | Issue a voucher to a customer's receiving key at the counter, of a given value in a receipt program |
| `challenge` | A challenge for one presentation |
| `redeem_voucher` | Accept a presentation: verify, record, keep it as the claim; returns the change when part was used |
| `claim` | The records and presentations to send to the operator |
| `receipts` | The day's receipt claims: refused duplicates first, then those waiting for review |
| `approve_receipts` | Sign vouchers for claims that match the sales, correcting totals if needed |
| `reject_receipt` | Refuse a claim with a reason the customer sees |
| `sync_receipts` | Issue the claims made with the store's signed receipt QR, without review |

**Operator** (`kangoh-mcp operator`): no state.

| Tool | Does |
|---|---|
| `settle` | Settle a period from the program and the stores' claims, given as JSON or file paths: statements per store and findings for every redemption not paid |

## Development

```sh
npm install
npm test
```

## License

Apache-2.0

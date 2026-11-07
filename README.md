# kangoh

**Reward vouchers without a customer database.**

Kangoh (勘合, "kan-go") were the tallies of Japan's medieval trade with
Ming China: a document split in two, one half held by each side, and a
shipment honoured only when the halves met. A kangoh voucher works the
same way: issued by one store, accepted by another, and settled when the
records of both are matched.

A store issues a voucher after a purchase: a signed credential of fixed value,
bound to a key the customer's agent holds, valid for a limited time. Any store
in the same program accepts it, checking only the issuer's signature, the
holder's signature and the expiry against the published program. The
redeeming store keeps the presentation as its claim on the issuer, and the
program operator settles between stores from the stores' records. Nobody
keeps a customer record, and there is no screen: the customer's side is a
key and a wallet, which an AI agent holds anyway.

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
they issue with, the value of a voucher and how many days it is valid.

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

// After a purchase, the point of sale issues a voucher to the agent's key.
const voucher = await bakery.issue(agentPublicJwk);  // the voucher goes to the agent; only its digest is recorded

// At another store, the agent presents it against a challenge.
const wallet = new Wallet(agentPrivateJwk, agentPublicJwk);
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

A store keeps three things: its signing key, its records and the
presentations it took. None of them identifies a customer. The records are
what the store submits for settlement, so a store keeps them where they
cannot be changed afterwards; the `Recorder` interface is where an
append-only file or an evidence log with signed checkpoints plugs in.

## Command line

```sh
kangoh keygen > bakery.json                                # a key pair (keep it private; put its public half in the program)
kangoh issue -p program.json -k bakery.json -h agent.json  # a voucher, to standard output
kangoh present -k agent.json --aud cafe.example --nonce N voucher.txt
kangoh verify -p program.json --aud cafe.example --nonce N presentation.txt
kangoh settle -p program.json bakery-claim.json cafe-claim.json
```

## MCP servers

`kangoh-mcp` serves each of the three roles to an agent, one role per
process. There is no screen; the agent is the interface.

```json
{
  "mcpServers": {
    "kangoh": { "command": "kangoh-mcp" },
    "kangoh-store": { "command": "kangoh-mcp", "args": ["store"], "env": { "KANGOH_STORE": "/path/to/store" } },
    "kangoh-operator": { "command": "kangoh-mcp", "args": ["operator"] }
  }
}
```

**Wallet** (`kangoh-mcp`): the customer's agent holds the vouchers. The
wallet is a file holding the key and the vouchers (`KANGOH_WALLET`, default
`~/.kangoh/wallet.json`); no store ever sees it.

| Tool | Does |
|---|---|
| `receiving_key` | The public key to give a store at checkout, so it can issue a voucher to this wallet |
| `add_voucher` | Keep an issued voucher, verifying it against the program if given |
| `list_vouchers` | The vouchers held, with issuer, value and expiry |
| `present_voucher` | Sign a presentation to a store against its challenge |
| `remove_voucher` | Drop a voucher once the store accepted it |

**Store** (`kangoh-mcp store`): the store's directory (`KANGOH_STORE`) holds
`store.json` (`{"id", "privateJwk"}`), `program.json` as published, and the
store's `records.jsonl` and `presentations.jsonl`, which the server writes.
The directory is the store's whole state.

| Tool | Does |
|---|---|
| `issue_voucher` | Issue a voucher to a customer's receiving key after a purchase |
| `challenge` | A challenge for one presentation |
| `redeem_voucher` | Accept a presentation: verify, record, keep it as the claim |
| `claim` | The records and presentations to send to the operator |

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

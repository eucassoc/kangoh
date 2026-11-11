# Example: a shopping street with shared points

A fictional shopping street of three shops, in Japanese, built on the
published kangoh package. Nobody signs up, and nobody keeps a customer
database.

[demo.mp4](demo.mp4) (2 minutes) walks through it.

## Run it

Node 20 or later:

```sh
cd examples/shopping-street
npm install
npm start          # http://127.0.0.1:8900/
```

The operator's service (the receipt desk and the registry) runs on port
8901. Every start, and 「最初から」, begins from nothing.

## What it shows

The bar at the bottom switches between the pages.

1. **お客さまの手元**: yesterday's receipt from the bakery, パン工房こむぎ, and
   the customer's app. The app claims the receipt with a fresh key; it sends
   the receipt and that key, nothing else.
2. **こむぎの端末**: the bakery's daily review. 「別の人が同じレシートで申請する」
   claims the same receipt number with another total, as someone who
   photographed the receipt might: the first claim wins, and the later one
   shows at the top as a duplicate. Approving signs a voucher with the
   bakery's key; the duplicate is rejected.
3. **喫茶ひだまり**: the café shows a QR signed with its key on the customer
   display. A claim from it needs no review and is issued at the café's next
   sync.
4. **雑貨つむぎ**: the customer pays 20 points: the bakery's 18 whole, and 2 of
   the café's 6. The operator's registry issues the remaining 4 as change.
5. **コピーしたアプリ**: a copy of the app presents the spent 18 points again,
   at the café. The registry refuses it at the counter.
6. **運営の精算**: the operator settles from the shops' records. The bakery
   pays 18, the café 2, and the gift shop receives 20; the records hold
   digests only.

The app runs inside the demo server to keep the demo to one process. In
practice it runs on the customer's phone, and its keys never leave it.

## Files

| File | |
|---|---|
| [server.mjs](server.mjs) | The shops, the operator's service, the app and the settlement |
| [app.html](app.html) | All pages |
| [title.html](title.html) | Title cards for the video |
| [record.cjs](record.cjs) | Records the video with Playwright: `node record.cjs OUTDIR` |

The street and its shops are fictional.

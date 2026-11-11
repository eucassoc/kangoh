// Records the demo at 1280x720: title, a receipt claimed, the bakery's review,
// the café's QR, paying with change, a copied app refused, the settlement, the end.
const { chromium } = require('playwright');
// Usage: node record.cjs OUTDIR, with the server running.
const base = process.env.BASE ?? 'http://127.0.0.1:8900';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: process.argv[2], size: { width: 1280, height: 720 } } });
  const p = await ctx.newPage();
  const wait = (ms) => p.waitForTimeout(ms);
  const cap = async (t, ms) => { await p.evaluate((x) => window.caption?.(x), t); if (ms) await wait(ms); };
  let mx = 640, my = 360;
  const to = async (sel) => {
    const inBar = await p.locator(sel).first().evaluate((el) => !!el.closest('.bar'));
    if (!inBar) {
      await p.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); if (r.top < 70 || r.bottom > window.innerHeight - 170) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
      await wait(450);
    }
    const bb = await p.locator(sel).first().boundingBox();
    const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
    await p.mouse.move(x, y, { steps: 18 }); mx = x; my = y; await wait(250);
  };
  const click = async (sel) => { await to(sel); await p.mouse.down(); await wait(90); await p.mouse.up(); };
  const type = async (sel, text) => { await click(sel); await p.locator(sel).pressSequentially(text, { delay: 55 }); await wait(200); };
  const hl = async (sel) => p.evaluate((s) => { const el = document.querySelector(s); el?.classList.remove('hl'); void el?.offsetWidth; el?.classList.add('hl'); }, sel);
  await fetch(base + '/api/reset', { method: 'POST' });
  const ACT = '.view.on #act';

  // Title
  await p.goto(base + '/title?card=start'); await wait(5200);

  // 1. A receipt, claimed from the app
  await p.goto(base + '/'); await p.mouse.move(mx, my); await wait(600);
  await cap('架空のひだまり商店街の共通ポイント。会員登録もポイントカードもありません', 4000);
  await cap('お客さまは、昨日パン工房こむぎで買い物をしたレシートを、アプリで読み取ります', 3600);
  await cap('');
  await click(ACT); await wait(2600);
  await cap('アプリが送るのは、レシートの内容と、この申請のためだけの新しい鍵。<br>名前も会員番号も送りません', 5600);
  await cap('レシートの写真を撮った別の人が、同じ番号で申請したら？', 3200);
  await click('#copycat'); await wait(700);

  // 2. The bakery's daily review
  await cap(''); await click('[data-go=desk]'); await wait(700);
  await cap('パン工房こむぎは1日1回、届いた申請を売上と照らして確認します', 4000);
  await hl('tr.dup'); await cap('同じレシートは先着だけ。後から来た申請は、重複として先頭に出ます', 4600);
  await cap('');
  await click('#approve'); await wait(800); await p.evaluate(() => window.lift('#d-out')); await wait(400);
  await cap('承認すると、お店の鍵でポイントを発行します。重複の申請は却下されます', 4800);

  // The points arrive
  await cap(''); await click('[data-go=receipt]'); await wait(900);
  await cap('お客さまのアプリに、18ポイントが届きました', 3400);

  // 3. The café's QR
  await cap(''); await click('[data-go=kissa]'); await wait(700);
  await cap('喫茶ひだまりは、レジのお客さま向け画面にQRを出せるお店です', 3800);
  await click('#show-qr'); await wait(800);
  await cap('QRはお店の鍵で署名済み。読み取るだけで、お店の確認は要りません', 4200);
  await cap('');
  await click(ACT); await wait(1600);
  await click('#sync'); await wait(1000);
  await cap('お店の次の同期で、6ポイントが届きます', 3600);

  // 4. Paying with change
  await cap(''); await click('[data-go=pay]'); await wait(700);
  await cap('雑貨つむぎで、20ポイントを使います', 2800);
  await cap('');
  await click(ACT); await wait(1200);
  await cap('こむぎの18ポイントと、ひだまりの6ポイントのうち2ポイント。<br>残りの4ポイントは、運営がお釣りとして発行します', 6200);
  await cap('お店が確かめるのは、署名と有効期限だけ。誰が来たかは知りません', 4400);

  // 5. A copied app
  await cap(''); await click('[data-go=copy]'); await wait(700);
  await cap('では、アプリをコピーして、使い終わったポイントをもう一度使おうとしたら？', 3800);
  await cap('');
  await click(ACT); await wait(1200);
  await cap('運営の照合サービスが、その場で断ります。<br>照合サービスが持つのは、使われたポイントのダイジェストとお店だけです', 6400);

  // 6. Settlement
  await cap(''); await click('[data-go=settle]'); await wait(900);
  await cap('月末、運営は各店の記録から精算します。<br>発行したお店が支払い、受け取ったお店が受け取ります', 5800);
  await p.evaluate(() => window.lift('#s-recs')); await wait(500); await hl('#s-recs'); await cap('記録にあるのはダイジェストだけ。お客さまの台帳は、どこにもありません', 5200);
  await cap('');

  // End
  await p.goto(base + '/title?card=end'); await wait(6500);
  await ctx.close(); await b.close();
})();

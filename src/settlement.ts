import { sha256 } from './digest.js';
import { payer, used, verifyPresentation, type Presented } from './presentation.js';
import { isOperator, type Program } from './program.js';
import type { Claim } from './store.js';

/** A redemption that is not paid, and why, tied to the store's record. */
export interface Finding {
  store: string;
  seq: number;
  /** Time of the record, so findings across stores read in order. */
  at: string;
  problem: string;
}

/** One store's side of the settlement. */
export interface Statement {
  store: string;
  /** Vouchers the store recorded issuing. */
  issued: number;
  /** Other stores' vouchers it is paid for. */
  accepted: number;
  /** Its own vouchers it took back. */
  own: number;
  receives: number;
  pays: number;
}

export interface Settlement {
  findings: Finding[];
  statements: Statement[];
}

/**
 * Settles a program period from the stores' claims. A voucher is paid once,
 * to the first store that recorded it, in time order across all stores, for
 * the points used. Change is paid by the store that issued the original,
 * and only if it is exactly the rest of a voucher redeemed in part, issued
 * to the key the holder named for it, once. So the operator, who signs
 * change, cannot make points: change it signs on its own is a finding.
 * Every redemption that is not paid is a finding.
 */
export async function settle(program: Program, programJson: string, claims: Claim[]): Promise<Settlement> {
  const findings: Finding[] = [];
  const programDigest = sha256(programJson);
  const issued = new Map<string, { store: string; seq: number }>();
  const statements = new Map<string, Statement>();
  const redemptions: { claim: Claim; record: Claim['records'][number] }[] = [];

  for (const claim of claims) {
    const s: Statement = { store: claim.store, issued: 0, accepted: 0, own: 0, receives: 0, pays: 0 };
    statements.set(claim.store, s);
    const first = claim.records[0];
    if (first?.event !== 'program') {
      findings.push({ store: claim.store, seq: 0, at: first?.at ?? '', problem: 'the first record must declare the program' });
      continue;
    }
    if (first.digest !== programDigest) {
      findings.push({ store: claim.store, seq: 0, at: first.at, problem: 'the program recorded is not the one being settled' });
      continue;
    }
    for (const r of claim.records.slice(1)) {
      switch (r.event) {
        case 'issued':
          issued.set(r.digest, { store: claim.store, seq: r.seq });
          s.issued++;
          break;
        case 'redeemed':
          redemptions.push({ claim, record: r });
          break;
        default:
          findings.push({ store: claim.store, seq: r.seq, at: r.at, problem: `unknown event ${JSON.stringify(r.event)}` });
      }
    }
  }
  redemptions.sort((a, b) => a.record.at.localeCompare(b.record.at) || a.claim.store.localeCompare(b.claim.store) || a.record.seq - b.record.seq);

  const paid = new Map<string, { store: string; seq: number; p: Presented }>();
  const changeOf = new Map<string, string>();
  for (const { claim, record } of redemptions) {
    const store = claim.store;
    const fail = (problem: string) => findings.push({ store, seq: record.seq, at: record.at, problem });
    const presentation = claim.presentations[record.digest];
    if (presentation === undefined) {
      fail('no presentation submitted for this redemption');
      continue;
    }
    if (sha256(presentation) !== record.digest) {
      fail('the submitted presentation is not the one recorded');
      continue;
    }
    let p;
    try {
      p = await verifyPresentation(program, presentation, { aud: store });
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    const digest = sha256(p.voucher);
    if (record.meta?.voucher !== digest || record.meta?.issuer !== p.claims.iss) {
      fail('the record does not describe the submitted presentation');
      continue;
    }
    let source: string;
    if (isOperator(program, p.claims.iss)) {
      const parentDigest = p.claims.chg?.parent as string;
      const parent = paid.get(parentDigest);
      if (!parent) {
        fail(`change from ${p.claims.iss} for a voucher no store redeemed; change issued without a purchase`);
        continue;
      }
      const pp = parent.p;
      if (pp.kb.change?.jwk.x !== p.claims.cnf.jwk.x || pp.claims.value - used(pp) !== p.claims.value || p.claims.exp > pp.claims.exp || payer(pp.claims) !== payer(p.claims)) {
        fail(`change does not match the rest of the voucher redeemed at ${parent.store} record ${parent.seq}`);
        continue;
      }
      const other = changeOf.get(parentDigest);
      if (other && other !== digest) {
        fail(`a second change for the voucher redeemed at ${parent.store} record ${parent.seq}`);
        continue;
      }
      changeOf.set(parentDigest, digest);
      source = `change of ${parent.store} record ${parent.seq}`;
    } else {
      const issuance = issued.get(digest);
      if (!issuance) {
        fail(`voucher signed with ${p.claims.iss}'s key, but ${p.claims.iss} never recorded issuing it; off-book issuance or a stolen key`);
        continue;
      }
      source = `record ${issuance.seq}`;
    }
    const at = Date.parse(record.at) / 1000;
    if (at > p.claims.exp) {
      fail(`voucher from ${p.claims.iss} (${source}) expired ${age(at - p.claims.exp)} before it was redeemed`);
      continue;
    }
    const first = paid.get(digest);
    if (first) {
      fail(`voucher already redeemed at ${first.store} record ${first.seq}; holder ${holderId(p.claims.cnf.jwk.x)} presented it twice`);
      continue;
    }
    paid.set(digest, { store, seq: record.seq, p });
    const s = statements.get(store) as Statement;
    const from = payer(p.claims);
    if (from === store) {
      s.own++;
      continue;
    }
    const amount = used(p);
    s.accepted++;
    s.receives += amount;
    const issuer = statements.get(from);
    if (issuer) issuer.pays += amount;
  }
  findings.sort((a, b) => a.at.localeCompare(b.at) || a.store.localeCompare(b.store) || a.seq - b.seq);
  return { findings, statements: claims.map((c) => statements.get(c.store) as Statement) };
}

function holderId(x: string | undefined): string {
  return (x ?? '').slice(0, 8);
}

/** Formats seconds as days and hours. */
export function age(seconds: number): string {
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

export function formatFinding(f: Finding): string {
  return `${f.store} record ${f.seq}: ${f.problem}`;
}

import { appendFile, readFile } from 'node:fs/promises';

export type EventName = 'program' | 'issued' | 'redeemed';

/**
 * What a store records: that it joined a program, issued a voucher or
 * redeemed one. A record holds the digest of the document, never the
 * document, and nothing about the holder.
 */
export interface Record {
  seq: number;
  /** RFC 3339 time, UTC. */
  at: string;
  event: EventName;
  /** Lowercase hex SHA-256 of the program, the voucher or the presentation. */
  digest: string;
  meta?: { [key: string]: string };
}

/**
 * Where a store keeps its records. The records are what the store submits
 * for settlement, so a store keeps them where they cannot be changed
 * afterwards: an append-only file, or an evidence log with signed
 * checkpoints.
 */
export interface Recorder {
  append(record: Omit<Record, 'seq'>): Promise<Record>;
  records(): Promise<Record[]>;
}

export class MemoryRecorder implements Recorder {
  private list: Record[] = [];

  async append(r: Omit<Record, 'seq'>): Promise<Record> {
    const record = { seq: this.list.length, ...r };
    this.list.push(record);
    return record;
  }

  async records(): Promise<Record[]> {
    return [...this.list];
  }
}

/** Records appended to a JSON Lines file. */
export class JsonlRecorder implements Recorder {
  private count: number | undefined;

  constructor(readonly path: string) {}

  async append(r: Omit<Record, 'seq'>): Promise<Record> {
    const seq = this.count ?? (await this.records()).length;
    const record = { seq, ...r };
    await appendFile(this.path, JSON.stringify(record) + '\n');
    this.count = seq + 1;
    return record;
  }

  async records(): Promise<Record[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const list = parseRecords(text);
    this.count = list.length;
    return list;
  }
}

/** Parses records in JSON Lines form, checking that they are in sequence. */
export function parseRecords(text: string): Record[] {
  const list: Record[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line) as Record;
    if (r.seq !== list.length) throw new Error(`record ${list.length}: seq is ${r.seq}`);
    list.push(r);
  }
  return list;
}

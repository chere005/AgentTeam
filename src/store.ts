import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { AppError } from './model.ts';
export type Event = { seq: number; type: string; entityId: string; data: unknown; createdAt: string };
export class Store {
  db: DatabaseSync;
  events = new EventEmitter();
  private pending: Event[] | null = null;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,entity_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  list<T>(kind: string): T[] { return this.db.prepare('SELECT data FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.data))); }
  get<T>(kind: string, id: string): T { const row = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind,id); if (!row) throw new AppError(404,'not_found',`${kind} ${id} not found`); return JSON.parse(String(row.data)); }
  put<T extends { id: string }>(kind: string, value: T): T { this.db.prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,value.id,JSON.stringify(value)); return value; }
  emit(type: string, entityId: string, data: unknown = {}): Event {
    const createdAt = new Date().toISOString(); const result = this.db.prepare('INSERT INTO events(type,entity_id,data,created_at) VALUES(?,?,?,?)').run(type,entityId,JSON.stringify(data),createdAt);
    const event = { seq: Number(result.lastInsertRowid), type, entityId, data, createdAt };
    if (this.pending) this.pending.push(event); else this.events.emit('event',event);
    return event;
  }
  history(after = 0, limit = 500): Event[] { return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit).map(r=>({seq:Number(r.seq),type:String(r.type),entityId:String(r.entity_id),data:JSON.parse(String(r.data)),createdAt:String(r.created_at)})); }
  transaction<T>(fn: () => T): T {
    if (this.pending) return fn();
    this.pending=[];this.db.exec('BEGIN IMMEDIATE');
    let result: T; let events: Event[];
    try { result=fn(); this.db.exec('COMMIT'); events=this.pending; } catch(e) { this.db.exec('ROLLBACK'); this.pending=null;throw e; }
    this.pending=null;for (const e of events) this.events.emit('event',e);return result;
  }
  remove(kind:string,id:string) {this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,id);}
  close() { this.db.close(); }
}

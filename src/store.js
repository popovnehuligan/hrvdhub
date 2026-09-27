import fs from 'node:fs';
import path from 'node:path';

const BACKUPS_KEPT = 30;

/**
 * The whole wishlist lives in one JSON file (data/wishlist.json). That is plenty
 * for an organisation's wishlist, easy to inspect and trivial to back up.
 * Writes go to a temp file first and are renamed into place, so a crash can't
 * leave a half-written file. A copy of the previous day's file is kept in
 * data/backups/.
 */
export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'wishlist.json');
    this.backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return { items: [], meta: {} };
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { items: data.items || [], meta: data.meta || {} };
  }

  save() {
    this.#backup();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  #backup() {
    if (!fs.existsSync(this.file)) return;
    const today = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `wishlist-${today}.json`);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.copyFileSync(this.file, target);
    const old = fs
      .readdirSync(this.backupDir)
      .filter((name) => /^wishlist-\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort()
      .slice(0, -BACKUPS_KEPT);
    for (const name of old) fs.rmSync(path.join(this.backupDir, name));
  }

  get items() {
    return this.data.items;
  }

  get meta() {
    return this.data.meta;
  }

  get(id) {
    return this.data.items.find((item) => item.id === id) || null;
  }

  insert(item) {
    this.data.items.push(item);
    this.save();
    return item;
  }

  remove(id) {
    const index = this.data.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.data.items.splice(index, 1);
    this.save();
    return true;
  }
}

// 简单 JSON 配置/缓存存储(userData 目录)
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = { ...defaults };
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...defaults, ...loaded };
    } catch { /* 首次运行或损坏时用默认值 */ }
  }
  get(k) { return this.data[k]; }
  all() { return { ...this.data }; }
  set(k, v) { this.data[k] = v; this.save(); }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error('[store] save failed:', e.message); }
  }
}

module.exports = { Store };

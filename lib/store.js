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
    } catch (e) {
      if (e && e.code === 'ENOENT') { /* 首次运行:静默用默认值 */ }
      else if (e instanceof SyntaxError) { // 文件存在但 JSON 损坏:备份现场再按默认值起,不丢数据也不崩
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { }
        console.error(`[store] ${file} 解析失败,已备份为 .corrupt- 文件:`, e.message);
      }
      /* 其余读取失败(权限等)同样回退默认值 */
    }
  }
  get(k) { return this.data[k]; }
  all() { return { ...this.data }; }
  set(k, v) { this.data[k] = v; this.scheduleSave(); }
  scheduleSave() { // 防抖合并:短窗内连续 set(如 endedAt 每周期 + 迁移连发)只全量落盘一次
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.save(); }, 300);
    if (this._t.unref) this._t.unref(); // 定时器不阻止进程退出;退出前由 flush 兜底
  }
  flush() { if (this._t) { clearTimeout(this._t); this._t = null; } this.save(); }
  cancelPending() { if (this._t) { clearTimeout(this._t); this._t = null; } } // 丢弃未落盘的变更:截图模式整文件还原前调用,防旧定时器在还原后把内存演示数据写回
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      const text = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(tmp, text); // 先写临时文件再改名:进程在写入中途被杀也不留半截 JSON
      try { fs.renameSync(tmp, this.file); }
      catch { // rename 被杀软/EDR 锁文件挡住时回退直写,不比旧行为差;临时文件顺手清掉
        fs.writeFileSync(this.file, text);
        try { fs.rmSync(tmp, { force: true }); } catch { }
      }
    } catch (e) { console.error('[store] save failed:', e.message); }
  }
}

module.exports = { Store };

// 变阵文案核对:mock 数据过真实推断层,逐条打印 zh/en 解读——mock 修到无 bug 的核对工具(可再生)
const I18N = require('../src/i18n.js');
const mock = require('./mock-data.json');
for (const t of mock.transfers) {
  const dir = I18N.transferDir(t);
  const note = I18N.transferNote(t, 'zh');
  const zh = I18N.transferStory(t, 'zh');
  const en = I18N.transferStory(t, 'en');
  console.log(`[${t.date}] ${t.player} (${t.flag}) ${t.oldTeam || '∅'} --${t.direction}-> ${t.newTeam || '∅'} note="${t.note}"`);
  console.log(`   dir=${dir} note标签="${note}"`);
  console.log(`   zh: ${zh}`);
  console.log(`   en: ${en}`);
}

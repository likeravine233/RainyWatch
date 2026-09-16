// 落地页改造实测:字体/相位错开/显影重触发/灯箱/meta 清理
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 浏览器与站点地址可用环境变量覆盖;输出固定写到本脚本旁的 site-check/(已 gitignore)
const EXE = process.env.RW_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.env.RW_SITE_URL || 'http://127.0.0.1:8137/index.html';
const OUT = fileURLToPath(new URL('./site-check', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

// 1) 字体
const fonts = await page.evaluate(() => ({
  chakra: document.fonts.check('700 20px "Chakra Petch"'),
  chakra500: document.fonts.check('500 20px "Chakra Petch"'),
  space: document.fonts.check('400 16px "Space Grotesk"'),
  noto: document.fonts.check('16px "Noto Sans SC"', '一瞥即知赛况'),
}));
console.log('FONTS', JSON.stringify(fonts));

// 2) 相位错开:取前 8 条带的 animation-delay 是否互不相同且覆盖整周期
const delays = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.vhsbg .ribbon')].slice(0, 8)
    .map((r) => { const f = r.querySelector('.film') || r.querySelector('.run'); return getComputedStyle(f).animationDelay; });
  return els;
});
console.log('DELAYS', JSON.stringify(delays));
const uniq = new Set(delays);
console.log('DELAYS uniq', uniq.size, '/', delays.length);

// 3) meta 文本清查
const metaHit = await page.evaluate(() => {
  const t = document.body.innerText;
  return ['漂移中', 'SCROLL', 'REEL 01', '35MM'].filter((k) => t.includes(k));
});
console.log('META-LEFT', JSON.stringify(metaHit));

// 4) 显影可重触发:滚到 features 记录 .in,滚回顶部再等,再滚下去看是否重新触发
await page.evaluate(() => document.querySelector('#features').scrollIntoView({ behavior: 'instant', block: 'start' }));
await page.waitForTimeout(900);
const inAfterDown = await page.evaluate(() => document.querySelectorAll('#features .reveal.in').length);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(900);
const inAfterTop = await page.evaluate(() => document.querySelectorAll('#features .reveal.in').length);
await page.evaluate(() => document.querySelector('#features').scrollIntoView({ behavior: 'instant', block: 'start' }));
await page.waitForTimeout(900);
const inAgain = await page.evaluate(() => document.querySelectorAll('#features .reveal.in').length);
console.log('REVEAL down=', inAfterDown, 'backTop=', inAfterTop, 'again=', inAgain);

// 5) 灯箱
await page.evaluate(() => document.querySelector('#showcase').scrollIntoView({ behavior: 'instant', block: 'center' }));
await page.waitForTimeout(700);
await page.screenshot({ path: OUT + '/showcase.png' });
await page.click('.frame-zoom');
await page.waitForTimeout(400);
const lbVisible = await page.evaluate(() => !document.getElementById('lb').hidden);
await page.screenshot({ path: OUT + '/lightbox.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const lbClosed = await page.evaluate(() => document.getElementById('lb').hidden);
console.log('LIGHTBOX open=', lbVisible, 'escClosed=', lbClosed);

// 6) 截图:桌面全页 + hero
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);
await page.screenshot({ path: OUT + '/hero.png' });
// 全页:先滚到底触发全部显影,再回顶 fullPage
await page.addStyleTag({ content: '.reveal{opacity:1!important;transform:none!important;transition:none!important}' });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/full.png', fullPage: true });

// 7) 移动端
const mp = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mp.goto(URL, { waitUntil: 'networkidle' });
await mp.waitForTimeout(800);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
await mp.screenshot({ path: OUT + '/mobile.png' });
console.log('MOBILE overflow px =', overflow);

console.log('CONSOLE-ERRORS', errors.length, errors.slice(0, 4));
await browser.close();

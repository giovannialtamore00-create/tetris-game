const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.LOCALAPPDATA + '/ms-playwright/chromium-1243/chrome-win64/chrome.exe' });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.goto('http://localhost:8080');
  await p.waitForTimeout(800);
  await p.screenshot({ path: __dirname + '/out/probe-menu.png' });
  await p.click('#playBtn'); await p.click('#freePlayBtn');
  await p.waitForTimeout(9000);
  await p.screenshot({ path: __dirname + '/out/probe-game.png' });
  await b.close();
})();

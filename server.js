const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// 健康檢查：部署後先打這個確認服務活著
app.get('/', (req, res) => res.send('Playwright service is running'));

// 爬取端點：n8n 會 POST 到這裡
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url || 'https://practicetestautomation.com/practice-test-login/');

    // ── demo：模擬登入 + 抓資料（之後換成 104 的選擇器）──
    await page.fill('#username', 'student');
    await page.fill('#password', 'Password123');
    await page.waitForTimeout(1500);
    await page.click('#submit');
    await page.waitForLoadState('networkidle');
    const heading = await page.textContent('h1');
    // ────────────────────────────────────────────────

    await browser.close();
    res.json({ success: true, data: { heading } });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

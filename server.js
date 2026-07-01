const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '5mb' })); // storageState 帶 cookies，body 開大一點

// 健康檢查：部署後先打這個確認服務活著
app.get('/', (req, res) => res.send('Playwright service is running'));

// 隨機延遲，模擬真人操作間隔（避免被平台判定為機器人）
function randomDelay(minMs = 800, maxMs = 2000) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 簡單的 API Key 驗證：這個服務目前是公開網址，任何人都能打
// 加這層避免被陌生人拿去當免費的「幫我登入 104」代理
function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (!process.env.API_KEY || key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
}

// 爬取端點：n8n 會 POST 到這裡（demo，之後接 104 列表頁爬取邏輯時再換掉）
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

// 104 登入：body 帶 { identity, password }（n8n Credentials 傳進來，不寫死在這裡）
// 成功則回傳 storageState，交給 n8n 存起來，之後 check-session / 之後的爬取端點都靠這份 state 免重複登入
app.post('/104/login', requireApiKey, async (req, res) => {
  const { identity, password } = req.body;
  if (!identity || !password) {
    return res.status(400).json({ success: false, error: 'identity 和 password 為必填' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://signin.104.com.tw/');
    await randomDelay();

    // 第一步：輸入帳號
    // 注意：頁面上還有一個 name="fakeInput" 的隱藏陷阱欄位（honeypot），
    // 專門抓「無腦填滿所有 password 欄位」的機器人，絕對不要碰它
    await page.fill('#identity', identity);
    await randomDelay();
    await page.locator('button:has-text("下一步")').click();

    // 第二步：等密碼欄位出現後才輸入（兩段式表單，是動態渲染的）
    await page.waitForSelector('#password', { timeout: 10000 });
    await randomDelay();
    await page.fill('#password', password);
    await randomDelay();
    await page.locator('button:has-text("登入")').click();

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const currentUrl = page.url();

    // 還停在登入頁 = 帳密錯誤或登入失敗
    if (currentUrl.includes('signin.104.com.tw')) {
      const pageText = await page.textContent('body').catch(() => '');
      await browser.close();
      return res.status(401).json({
        success: false,
        error: '登入失敗，可能帳密錯誤或頁面結構變了',
        debug: pageText.slice(0, 300),
      });
    }

    const storageState = await context.storageState();
    await browser.close();
    res.json({ success: true, storageState });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

// 檢查 session 是否還有效：body 帶 { storageState }（n8n 存的那份丟回來）
app.post('/104/check-session', requireApiKey, async (req, res) => {
  const { storageState } = req.body;
  if (!storageState) {
    return res.status(400).json({ success: false, error: 'storageState 為必填' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    // 這個頁面沒登入會被導回 signin.104.com.tw，藉此判斷 session 是否還活著
    await page.goto('https://pda.104.com.tw/profile', { waitUntil: 'networkidle', timeout: 15000 });
    const loggedIn = !page.url().includes('signin.104.com.tw');

    await browser.close();
    res.json({ success: true, loggedIn });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

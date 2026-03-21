// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                    PriceHawk — app.js                                   ║
// ║   Everything in one file: server + scraper + AI + email + cron          ║
// ║   Run:  node app.js                                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
'use strict';

require('dotenv').config();

// ════════════════════════════════════════════════════════════════════════════
//  DEPENDENCIES
// ════════════════════════════════════════════════════════════════════════════
const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const path          = require('path');
const crypto        = require('crypto');
const axios         = require('axios');
const cron          = require('node-cron');
const puppeteer  = require('puppeteer-core');
const chromium   = require('@sparticuz/chromium');
const { createClient }       = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ════════════════════════════════════════════════════════════════════════════
//  DB CLIENT
// ════════════════════════════════════════════════════════════════════════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI CLIENT (null if key not set — math fallback kicks in automatically)
// ════════════════════════════════════════════════════════════════════════════
let geminiModel = null;
try {
  if (process.env.GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    console.log('[GEMINI] ✅ Gemini client ready');
  } else {
    console.log('[GEMINI] No API key — math engine will be used');
  }
} catch (e) {
  console.warn('[GEMINI] Init failed:', e.message);
}

// ════════════════════════════════════════════════════════════════════════════
//
//   ██╗   ██╗████████╗██╗██╗     ███████╗
//   ██║   ██║╚══██╔══╝██║██║     ██╔════╝
//   ██║   ██║   ██║   ██║██║     ███████╗
//   ██║   ██║   ██║   ██║██║     ╚════██║
//   ╚██████╔╝   ██║   ██║███████╗███████║
//    ╚═════╝    ╚═╝   ╚═╝╚══════╝╚══════╝
//
// ════════════════════════════════════════════════════════════════════════════

// ─── Extract clean URL from messy share text ──────────────────────────────────
function extractUrlFromInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const cleaned = rawInput.trim();
  try {
    const u = new URL(cleaned);
    if (u.protocol === 'http:' || u.protocol === 'https:') return cleaned;
  } catch {}
  const urlRegex = /https?:\/\/[^\s"'<>)\]]+/g;
  const matches  = [...new Set(cleaned.match(urlRegex) || [])];
  if (!matches.length) return null;
  const KNOWN = ['amazon.in','amazon.com','flipkart.com','dl.flipkart.com',
                 'meesho.com','myntra.com','snapdeal.com','tatacliq.com',
                 'nykaa.com','croma.com'];
  const preferred = matches.find(m => {
    try { return KNOWN.some(d => new URL(m).hostname.includes(d)); }
    catch { return false; }
  });
  return preferred || matches[0];
}

// ─── Platform / domain helpers ───────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  'amazon.in','amazon.com','flipkart.com','dl.flipkart.com',
  'meesho.com','myntra.com','snapdeal.com','tatacliq.com','nykaa.com','croma.com',
];

function isDomainAllowed(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

function detectPlatform(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes('amazon'))   return 'amazon';
    if (h.includes('flipkart')) return 'flipkart';
    if (h.includes('meesho'))   return 'meesho';
    if (h.includes('myntra'))   return 'myntra';
    if (h.includes('snapdeal')) return 'snapdeal';
    if (h.includes('tatacliq')) return 'tatacliq';
    if (h.includes('nykaa'))    return 'nykaa';
    if (h.includes('croma'))    return 'croma';
  } catch {}
  return 'other';
}

function buildAffiliateUrl(url, platform) {
  try {
    if (platform === 'amazon' && process.env.AMAZON_AFFILIATE_TAG) {
      const u = new URL(url);
      u.searchParams.set('tag', process.env.AMAZON_AFFILIATE_TAG);
      return u.toString();
    }
  } catch {}
  return url;
}

function makeSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 70) + '-' + Date.now();
}

function respond(res, status, data) {
  return res.status(status).json(data);
}

// ════════════════════════════════════════════════════════════════════════════
//
//  ███████╗ ██████╗██████╗  █████╗ ██████╗ ███████╗██████╗
//  ██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗
//  ███████╗██║     ██████╔╝███████║██████╔╝█████╗  ██████╔╝
//  ╚════██║██║     ██╔══██╗██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗
//  ███████║╚██████╗██║  ██║██║  ██║██║     ███████╗██║  ██║
//  ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝
//
// ════════════════════════════════════════════════════════════════════════════

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }
function humanDelay(min, max) {
  min = min || 600; max = max || 1800;
  return sleep(Math.random() * (max - min) + min);
}

// ─── Launch browser — works on Render free tier via @sparticuz/chromium ─────────
async function launchBrowser() {
  // On Render/Lambda: use sparticuz chromium (pre-built, no root needed)
  // Locally: falls back to any installed Chrome via CHROME_EXECUTABLE_PATH env
  const executablePath = process.env.CHROME_EXECUTABLE_PATH
    || await chromium.executablePath();

  return puppeteer.launch({
    headless: chromium.headless,
    executablePath: executablePath,
    args: [
      ...chromium.args,
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
    defaultViewport: chromium.defaultViewport,
  });
}

// ─── Create a stealth page (Puppeteer — no newContext) ────────────────────────
async function createStealthPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(randomUA());
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-IN,en;q=0.9' });
  await page.evaluateOnNewDocument(function() {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
    Object.defineProperty(navigator, 'plugins',   { get: function() { return [1,2,3,4,5]; } });
    window.chrome = { runtime: {} };
  });
  return page;
}

// ─── Amazon ───────────────────────────────────────────────────────────────────
async function scrapeAmazon(page) {
  await page.waitForSelector('#productTitle, h1', { timeout: 15000 });
  await humanDelay(400, 900);

  return page.evaluate(function() {
    function getText(sels) {
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        var t = el && el.textContent && el.textContent.trim();
        if (t) return t;
      }
      return null;
    }
    function getAttr(sels, a) {
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        var v = el && el.getAttribute(a);
        if (v) return v;
      }
      return null;
    }

    var title = getText(['#productTitle','#title span','h1.product-title-word-break'])
             || (document.querySelector('meta[property="og:title"]') || {}).content || '';

    var priceWhole = getText(['.a-price-whole','#priceblock_ourprice','#priceblock_dealprice',
      '#apex_desktop .a-price-whole','.apexPriceToPay .a-price-whole',
      '#corePrice_feature_div .a-price-whole']) || '0';
    var priceFrac  = getText(['.a-price-fraction']) || '00';
    var price = parseFloat((priceWhole.replace(/[^0-9]/g,'')) + '.' + (priceFrac.replace(/[^0-9]/g,'').slice(0,2))) || 0;

    var mrpRaw = getText(['.a-price.a-text-price .a-offscreen','#listPrice',
      '#priceblock_listprice','.basisPrice .a-price .a-offscreen']);
    var originalPrice = mrpRaw ? parseFloat(mrpRaw.replace(/[^0-9.]/g,'')) : null;

    var imageUrl = getAttr(['#landingImage','#imgBlkFront','#main-image'],'src')
      || getAttr(['#landingImage','#imgBlkFront'],'data-old-hires')
      || getAttr(['meta[property="og:image"]'],'content') || '';

    var brandEl = document.querySelector('#bylineInfo') || document.querySelector('#brand');
    var brand = brandEl ? brandEl.textContent.trim().replace(/^(Visit the |Brand: ?|by )/i,'') : null;

    var modelNumber = null;
    var rows = document.querySelectorAll('#productDetails_techSpec_section_1 tr, #detailBullets_feature_div li');
    for (var r = 0; r < rows.length; r++) {
      var t = rows[r].textContent || '';
      if (/model|item model/i.test(t)) {
        var parts = t.split(/[:\n]/);
        if (parts[1]) { modelNumber = parts[1].trim(); break; }
      }
    }

    var ratingText = getText(['#averageCustomerReviews .a-icon-alt']);
    var rating = ratingText ? parseFloat(ratingText) : null;

    var stockEl = document.querySelector('#availability span, #outOfStock');
    var inStock = !(stockEl && stockEl.textContent && stockEl.textContent.toLowerCase().match(/unavailable|out of stock/));

    var catEl = document.querySelector('#wayfinding-breadcrumbs_feature_div a:last-of-type');
    var category = catEl ? catEl.textContent.trim() : null;

    return { title: title, price: price, originalPrice: originalPrice, imageUrl: imageUrl,
             brand: brand, modelNumber: modelNumber, rating: rating, inStock: inStock, category: category };
  });
}

// ─── Flipkart ─────────────────────────────────────────────────────────────────
async function scrapeFlipkart(page) {
  // Dismiss login popup if present
  try {
    const closeBtn = await page.$('button._2KpZ6l._2doB4z');
    if (closeBtn) await closeBtn.click();
  } catch (e) {}

  await page.waitForSelector('.B_NuCI, .yhB1nd, h1', { timeout: 12000 });
  await humanDelay(300, 700);

  return page.evaluate(function() {
    function getText(sels) {
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        var t = el && el.textContent && el.textContent.trim();
        if (t) return t;
      }
      return null;
    }

    var title = getText(['.B_NuCI','.yhB1nd','h1.yhB1nd','h1._9E25nV']) || '';
    var priceText = getText(['._30jeq3._16Jk6d','._30jeq3','._16Jk6d']) || '0';
    var price = parseFloat(priceText.replace(/[^0-9.]/g,'')) || 0;

    var mrpText = getText(['._3I9_wc._2p6lqe','._3I9_wc']);
    var originalPrice = mrpText ? parseFloat(mrpText.replace(/[^0-9.]/g,'')) : null;

    var imgEl = document.querySelector('._396cs4 img') || document.querySelector('._2r_T1I img') || document.querySelector('img.q6DClP');
    var imageUrl = imgEl ? imgEl.src : '';

    var brandEl = document.querySelector('span.G6XhRU') || document.querySelector('._2whKao a');
    var brand = brandEl ? brandEl.textContent.trim() : null;

    var ratingText = getText(['._3LWZlK']);
    var rating = ratingText ? parseFloat(ratingText) : null;

    var inStock = !document.querySelector('._16FRp0');

    var catEl = document.querySelector('div._1MR4o5 a:last-child');
    var category = catEl ? catEl.textContent.trim() : null;

    return { title: title, price: price, originalPrice: originalPrice, imageUrl: imageUrl,
             brand: brand, modelNumber: null, rating: rating, inStock: inStock, category: category };
  });
}

// ─── Generic (JSON-LD / OpenGraph fallback) ───────────────────────────────────
async function scrapeGeneric(page) {
  await humanDelay(600, 1200);
  return page.evaluate(function() {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var j = JSON.parse(scripts[i].textContent);
        var p = j['@type'] === 'Product' ? j
              : (Array.isArray(j) ? j.find(function(x) { return x['@type'] === 'Product'; }) : null);
        if (p) {
          var o = Array.isArray(p.offers) ? p.offers[0] : p.offers;
          return {
            title: p.name || '', price: parseFloat((o && o.price) || 0),
            originalPrice: null, imageUrl: (p.image && (p.image[0] || p.image)) || '',
            brand: (p.brand && p.brand.name) || null, modelNumber: p.mpn || null,
            rating: parseFloat((p.aggregateRating && p.aggregateRating.ratingValue) || 0) || null,
            inStock: o ? (o.availability || '').indexOf('InStock') > -1 : true,
            category: p.category || null,
          };
        }
      } catch (e) {}
    }
    var ogTitle = document.querySelector('meta[property="og:title"]');
    var ogImage = document.querySelector('meta[property="og:image"]');
    return {
      title: (ogTitle && ogTitle.content) || document.title || '',
      price: 0, originalPrice: null,
      imageUrl: (ogImage && ogImage.content) || '',
      brand: null, modelNumber: null, rating: null, inStock: true, category: null,
    };
  });
}

// ─── Main scraper with retry ──────────────────────────────────────────────────
async function scrapeProduct(url, platform) {
  platform = platform || 'other';
  for (var attempt = 1; attempt <= 3; attempt++) {
    var browser = null;
    try {
      console.log('[SCRAPER] Attempt ' + attempt + '/3 — ' + platform + ' — ' + url.slice(0,60) + '...');
      browser = await launchBrowser();
      var page = await createStealthPage(browser);

      // Block heavy assets on retry attempts to speed up
      if (attempt > 1) {
        await page.setRequestInterception(true);
        page.on('request', function(req) {
          var type = req.resourceType();
          if (type === 'image' || type === 'stylesheet' || type === 'font') {
            req.abort();
          } else {
            req.continue();
          }
        });
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.evaluate(function() { window.scrollBy(0, 300); });
      await humanDelay(300, 700);

      // Re-detect platform from final URL (handles dl.flipkart.com redirects)
      var finalUrl = page.url();
      var resolvedPlatform = detectPlatform(finalUrl) !== 'other' ? detectPlatform(finalUrl) : platform;

      var scraped;
      if (resolvedPlatform === 'amazon')        scraped = await scrapeAmazon(page);
      else if (resolvedPlatform === 'flipkart') scraped = await scrapeFlipkart(page);
      else                                      scraped = await scrapeGeneric(page);

      if (!scraped.title) throw new Error('Could not extract product title');
      if (!scraped.price) throw new Error('Could not extract price');

      await browser.close();
      console.log('[SCRAPER] ✅ "' + scraped.title.slice(0,50) + '" ₹' + scraped.price);
      return Object.assign({}, scraped, { resolvedUrl: finalUrl });

    } catch (err) {
      console.error('[SCRAPER] ❌ Attempt ' + attempt + ' failed: ' + err.message);
      if (browser) { try { await browser.close(); } catch (e) {} }
      if (attempt === 3) throw err;
      await sleep(3000 * attempt * attempt);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//
//  ███████╗███╗   ███╗ █████╗ ██╗██╗
//  ██╔════╝████╗ ████║██╔══██╗██║██║
//  █████╗  ██╔████╔██║███████║██║██║
//  ██╔══╝  ██║╚██╔╝██║██╔══██║██║██║
//  ███████╗██║ ╚═╝ ██║██║  ██║██║███████╗
//  ╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝
//
// ════════════════════════════════════════════════════════════════════════════

function movingAverage(prices, n) {
  var slice = prices.slice(-Math.min(n, prices.length));
  return slice.reduce(function(a, b) { return a + b; }, 0) / slice.length;
}

function calcSlope(prices) {
  var n = prices.length;
  if (n < 2) return 0;
  var xMean = (n - 1) / 2;
  var yMean = prices.reduce(function(a, b) { return a + b; }, 0) / n;
  var num = 0, den = 0;
  for (var i = 0; i < n; i++) {
    num += (i - xMean) * (prices[i] - yMean);
    den += Math.pow(i - xMean, 2);
  }
  return den === 0 ? 0 : num / den;
}

function calcVolatility(prices) {
  if (prices.length < 2) return 0;
  var mean = prices.reduce(function(a, b) { return a + b; }, 0) / prices.length;
  var variance = prices.reduce(function(sum, p) { return sum + Math.pow(p - mean, 2); }, 0) / prices.length;
  return mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0;
}

function mathPrediction(product, history) {
  var prices = history.map(function(h) { return parseFloat(h.price); });
  var cur = prices[prices.length - 1];
  var min = Math.min.apply(null, prices);
  var max = Math.max.apply(null, prices);

  var ma7    = movingAverage(prices, 7);
  var ma30   = movingAverage(prices, 30);
  var slope  = calcSlope(prices);
  var volPct = calcVolatility(prices);
  var pctChg = prices.length >= 2 ? ((cur - prices[0]) / prices[0]) * 100 : 0;

  var threshold = cur * 0.002;
  var trend = slope < -threshold ? 'decreasing' : slope > threshold ? 'increasing' : 'stable';

  var dropProb = 50;
  if (trend === 'decreasing') dropProb += 20;
  if (trend === 'increasing') dropProb -= 20;
  if (cur > ma30)   dropProb += 10;
  if (cur < ma7)    dropProb += 10;
  if (volPct > 8)   dropProb += 10;
  if (pctChg > 10)  dropProb += 5;
  if (pctChg < -10) dropProb -= 10;
  dropProb = Math.max(5, Math.min(95, Math.round(dropProb)));

  var impact = slope * 30;
  var estMin = Math.round(Math.max(min * 0.95, cur + impact - (volPct * cur / 100)));
  var estMax = Math.round(Math.min(max * 1.05, cur + impact + (volPct * cur / 100)));

  var bestTimeToBuy = dropProb >= 65 ? 'Wait 1–2 weeks — drop likely soon'
    : dropProb <= 35 ? 'Good time to buy — price near historical low'
    : cur <= min * 1.05 ? 'Near all-time low — consider buying now'
    : trend === 'increasing' ? 'Buy now before price rises further'
    : 'Price is stable — buy when ready';

  var trendMsg = trend === 'decreasing' ? 'Price trend is decreasing 📉'
    : trend === 'increasing' ? 'Price is rising 📈' : 'Price has been stable ➡️';

  var volMsg = volPct > 10 ? 'High volatility — prices change frequently.'
    : volPct > 5 ? 'Moderate fluctuations.' : 'Low volatility — consistent pricing.';

  var maMsg = cur > ma7
    ? ((cur - ma7) / ma7 * 100).toFixed(1) + '% above 7-day avg — may dip.'
    : ((ma7 - cur) / ma7 * 100).toFixed(1) + '% below 7-day avg — relatively good deal.';

  var summary = [
    trendMsg, volMsg, maMsg,
    '7-day avg: ₹' + Math.round(ma7).toLocaleString('en-IN') + ' | 30-day avg: ₹' + Math.round(ma30).toLocaleString('en-IN'),
    'Range: ₹' + min.toLocaleString('en-IN') + ' – ₹' + max.toLocaleString('en-IN'),
    dropProb >= 60 ? '⚠️ High drop probability — consider waiting.'
      : dropProb <= 35 ? '✅ Near low — good buy window.'
      : '💡 No strong signal — monitor a few more days.',
  ].join('\n');

  return {
    engine: 'math', trend: trend, dropProbability: dropProb, bestTimeToBuy: bestTimeToBuy,
    estimatedRange: { min: estMin, max: estMax }, summary: summary,
    meta: { ma7: Math.round(ma7), ma30: Math.round(ma30), volatility: parseFloat(volPct.toFixed(2)) },
  };
}

async function geminiPrediction(product, history) {
  if (!geminiModel) throw new Error('Gemini not configured');
  var prices = history.map(function(h) { return parseFloat(h.price); });
  var step   = Math.max(1, Math.floor(history.length / 30));
  var series = history
    .filter(function(_, i) { return i % step === 0 || i === history.length - 1; })
    .map(function(h) { return new Date(h.recorded_at).toLocaleDateString('en-IN') + ': ₹' + h.price; })
    .join('\n');

  var prompt = 'You are a price analyst. Analyze this product price history and respond ONLY with valid JSON (no markdown):\n\n'
    + 'Product: ' + product.title + '\nPlatform: ' + product.platform
    + '\nCurrent: ₹' + prices[prices.length - 1]
    + '\nRange: ₹' + Math.min.apply(null, prices) + ' – ₹' + Math.max.apply(null, prices)
    + '\n\nHistory:\n' + series
    + '\n\nJSON format:\n{"trend":"decreasing"|"increasing"|"stable","dropProbability":<0-100>,'
    + '"bestTimeToBuy":"<string>","estimatedRange":{"min":<number>,"max":<number>},'
    + '"summary":"<3-5 sentences>","keyInsights":["<string>","<string>","<string>"]}';

  var result = await geminiModel.generateContent(prompt);
  var raw    = result.response.text().trim()
    .replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  var parsed = JSON.parse(raw);

  if (!parsed.trend || typeof parsed.dropProbability !== 'number')
    throw new Error('Incomplete Gemini response');

  return {
    engine: 'gemini', trend: parsed.trend,
    dropProbability: Math.max(0, Math.min(100, Math.round(parsed.dropProbability))),
    bestTimeToBuy: parsed.bestTimeToBuy || '',
    estimatedRange: parsed.estimatedRange,
    summary: parsed.summary || '',
    keyInsights: parsed.keyInsights || [],
  };
}

async function generatePrediction(product, history) {
  if (!history || history.length < 2) {
    return {
      engine: 'math', trend: 'stable', dropProbability: 50,
      bestTimeToBuy: 'Need more data — check back in 24 hours',
      estimatedRange: null, summary: 'Not enough history yet. Keep tracking!',
    };
  }
  if (geminiModel) {
    try {
      console.log('[GEMINI] Requesting prediction...');
      var result = await Promise.race([
        geminiPrediction(product, history),
        new Promise(function(_, r) { setTimeout(function() { r(new Error('Timeout')); }, 15000); }),
      ]);
      console.log('[GEMINI] ✅ AI prediction done');
      return result;
    } catch (err) {
      console.warn('[GEMINI] ⚠️ Failed (' + err.message + ') — switching to math engine');
    }
  }
  return mathPrediction(product, history);
}

// ════════════════════════════════════════════════════════════════════════════
//  EMAIL (Brevo REST API)
// ════════════════════════════════════════════════════════════════════════════

function brevoHeaders() {
  return {
    'accept': 'application/json',
    'api-key': process.env.BREVO_API_KEY,
    'content-type': 'application/json',
  };
}

function isBrevoConfigured() {
  return process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL;
}

async function sendWelcomeEmail(opts) {
  if (!isBrevoConfigured()) {
    console.warn('[EMAIL] Brevo not configured — skipping welcome email');
    return;
  }

  var toEmail       = opts.toEmail;
  var productTitle  = opts.productTitle;
  var productImage  = opts.productImage;
  var platform      = opts.platform;
  var currentPrice  = opts.currentPrice;
  var originalPrice = opts.originalPrice;
  var targetPrice   = opts.targetPrice;
  var buyUrl        = opts.buyUrl;

  var fmt = function(n) { return '₹' + Number(n).toLocaleString('en-IN'); };
  var APP = process.env.FRONTEND_URL || 'https://pricehawk.onrender.com';

  var dropPct = originalPrice && originalPrice > currentPrice
    ? ((originalPrice - currentPrice) / originalPrice * 100).toFixed(1) : null;

  var alertSection = targetPrice
    ? '<div style="margin-top:16px;padding:14px 18px;background:rgba(79,70,229,0.15);border:1px solid rgba(167,139,250,0.3);border-radius:10px;font-size:13px;color:#c4b5fd">🎯 <strong>Alert set:</strong> We\'ll email you the moment price drops to <strong>' + fmt(targetPrice) + '</strong></div>'
    : '<div style="margin-top:16px;padding:14px 18px;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);border-radius:10px;font-size:13px;color:#67e8f9">📊 <strong>Auto-monitoring active:</strong> We\'ll alert you on any significant price change.</div>';

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Tracking Started — PriceHawk</title></head>'
    + '<body style="margin:0;padding:0;background:#0d1117;font-family:\'Segoe UI\',system-ui,sans-serif">'
    + '<div style="max-width:560px;margin:0 auto;padding:24px 16px">'
    + '<div style="text-align:center;padding:28px 0 20px">'
    + '<div style="display:inline-block;background:linear-gradient(135deg,#1e3a5f,#2d1b69);border:1px solid rgba(100,200,255,0.2);border-radius:16px;padding:10px 24px;margin-bottom:16px">'
    + '<span style="font-size:18px;font-weight:800;color:#67e8f9">🦅 PriceHawk</span></div>'
    + '<h1 style="color:#f0f6ff;font-size:24px;font-weight:800;margin:0 0 6px">✅ Tracking Started!</h1>'
    + '<p style="color:#94a3b8;margin:0;font-size:15px">We\'re now watching this product 24/7 for you</p></div>'
    + '<div style="background:#131a25;border:1px solid rgba(100,200,255,0.15);border-radius:16px;padding:20px;margin-bottom:16px">'
    + '<div style="display:flex;gap:16px;align-items:flex-start">'
    + (productImage ? '<img src="' + productImage + '" width="90" height="90" style="border-radius:10px;object-fit:cover;background:#1e293b;flex-shrink:0">' : '<div style="width:90px;height:90px;background:#1e293b;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0">📦</div>')
    + '<div><p style="margin:0 0 6px;color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:1px">via ' + platform + '</p>'
    + '<p style="margin:0 0 8px;color:#f1f5f9;font-size:14px;font-weight:600;line-height:1.4">' + productTitle.slice(0,90) + (productTitle.length > 90 ? '…' : '') + '</p>'
    + '<p style="margin:0;font-size:22px;font-weight:800;color:#67e8f9">' + fmt(currentPrice) + '</p>'
    + (dropPct ? '<span style="font-size:12px;color:#4ade80;margin-left:8px">↓ ' + dropPct + '% off MRP</span>' : '')
    + '</div></div></div>'
    + alertSection
    + '<div style="text-align:center;margin:20px 0">'
    + '<a href="' + buyUrl + '" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ef4444);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:800">🛒 Buy Now on ' + platform + ' →</a></div>'
    + '<div style="text-align:center;padding:14px 0;border-top:1px solid rgba(255,255,255,0.06)">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#475569"><a href="' + APP + '" style="color:#67e8f9;text-decoration:none">Open Dashboard</a></p>'
    + '<p style="margin:0;font-size:12px;color:#334155">PriceHawk — Smart Price Intelligence</p></div>'
    + '</div></body></html>';

  var response = await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: process.env.BREVO_SENDER_NAME || 'PriceHawk', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: toEmail }],
    subject: '✅ Tracking started: ' + productTitle.slice(0,50) + (productTitle.length > 50 ? '…' : ''),
    htmlContent: html,
    textContent: 'Tracking started!\n\n' + productTitle + '\nCurrent price: ' + fmt(currentPrice) + '\n' + (targetPrice ? 'Alert set for: ' + fmt(targetPrice) : 'Auto-monitoring active') + '\n\nView dashboard: ' + APP,
  }, { headers: brevoHeaders(), timeout: 10000 });

  console.log('[EMAIL] ✅ Welcome email sent to ' + toEmail + ' — ID: ' + response.data.messageId);
}

async function sendAlertEmail(opts) {
  if (!isBrevoConfigured()) {
    console.warn('[EMAIL] Brevo not configured — skipping alert email');
    return;
  }

  var toEmail       = opts.toEmail;
  var productTitle  = opts.productTitle;
  var productImage  = opts.productImage;
  var platform      = opts.platform;
  var newPrice      = opts.newPrice;
  var oldPrice      = opts.oldPrice;
  var originalPrice = opts.originalPrice;
  var buyUrl        = opts.buyUrl;
  var targetPrice   = opts.targetPrice;
  var priceType     = opts.priceType;

  var fmt          = function(n) { return '₹' + Number(n).toLocaleString('en-IN'); };
  var APP          = process.env.FRONTEND_URL || 'https://pricehawk.onrender.com';
  var isDropAlert  = priceType === 'drop';
  var dropPct      = oldPrice > 0 ? Math.abs((oldPrice - newPrice) / oldPrice) * 100 : 0;
  var savingAmount = Math.abs(oldPrice - newPrice);

  var subjectLine = isDropAlert
    ? '🔥 Price Drop! ' + productTitle.slice(0,40) + '… now ' + fmt(newPrice)
    : '⚠️ Price Increased — ' + productTitle.slice(0,40) + '… now ' + fmt(newPrice);

  var headerTitle = isDropAlert ? 'Price Drop Alert!' : 'Price Increase Warning';
  var headerSub   = isDropAlert ? 'Good news — price dropped on ' + platform + '!'
                                : 'Heads up — price has risen on ' + platform;

  var priceBlock = isDropAlert
    ? '<div style="background:linear-gradient(135deg,#052e16,#14532d);border:1px solid rgba(74,222,128,0.3);border-radius:16px;padding:24px;text-align:center;margin-bottom:20px">'
    + '<p style="margin:0 0 6px;color:#86efac;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-weight:600">🔥 NEW PRICE</p>'
    + '<p style="margin:0 0 4px;font-size:40px;font-weight:900;color:#4ade80">' + fmt(newPrice) + '</p>'
    + '<p style="margin:0 0 14px;color:#86efac;font-size:14px;text-decoration:line-through;opacity:0.8">was ' + fmt(oldPrice) + '</p>'
    + '<div style="display:inline-flex;gap:10px;flex-wrap:wrap;justify-content:center">'
    + '<span style="background:#16a34a;color:#fff;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700">↓ ' + dropPct.toFixed(1) + '% OFF</span>'
    + '<span style="background:#065f46;color:#6ee7b7;padding:5px 14px;border-radius:20px;font-size:13px">Save ' + fmt(savingAmount) + '</span>'
    + (targetPrice ? '<span style="background:#1e3a5f;color:#67e8f9;padding:5px 14px;border-radius:20px;font-size:13px">Target: ' + fmt(targetPrice) + '</span>' : '')
    + '</div></div>'
    : '<div style="background:linear-gradient(135deg,#450a0a,#7f1d1d);border:1px solid rgba(248,113,113,0.3);border-radius:16px;padding:24px;text-align:center;margin-bottom:20px">'
    + '<p style="margin:0 0 6px;color:#fca5a5;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-weight:600">⚠️ PRICE INCREASED</p>'
    + '<p style="margin:0 0 4px;font-size:40px;font-weight:900;color:#f87171">' + fmt(newPrice) + '</p>'
    + '<p style="margin:0 0 14px;color:#fca5a5;font-size:14px;text-decoration:line-through;opacity:0.8">was ' + fmt(oldPrice) + '</p>'
    + '<span style="background:#991b1b;color:#fff;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700">↑ ' + dropPct.toFixed(1) + '% INCREASE</span></div>'
    + '<div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:10px;padding:14px;margin-bottom:16px;font-size:13px;color:#fca5a5">'
    + '💡 If you still want this product, you may want to buy now before further increases.</div>';

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>' + headerTitle + ' — PriceHawk</title></head>'
    + '<body style="margin:0;padding:0;background:#0d1117;font-family:\'Segoe UI\',system-ui,sans-serif">'
    + '<div style="max-width:560px;margin:0 auto;padding:24px 16px">'
    + '<div style="text-align:center;padding:24px 0 18px">'
    + '<div style="display:inline-block;background:linear-gradient(135deg,#1e3a5f,#2d1b69);border:1px solid rgba(100,200,255,0.2);border-radius:14px;padding:9px 22px;margin-bottom:14px">'
    + '<span style="font-size:17px;font-weight:800;color:#67e8f9">🦅 PriceHawk</span></div>'
    + '<h1 style="color:#f0f6ff;font-size:24px;font-weight:800;margin:0 0 4px">' + (isDropAlert ? '🔥' : '⚠️') + ' ' + headerTitle + '</h1>'
    + '<p style="color:#94a3b8;margin:0;font-size:14px">' + headerSub + '</p></div>'
    + '<div style="background:#131a25;border:1px solid rgba(100,200,255,0.15);border-radius:16px;padding:18px;margin-bottom:16px">'
    + '<div style="display:flex;gap:14px;align-items:flex-start">'
    + (productImage ? '<img src="' + productImage + '" width="76" height="76" style="border-radius:9px;object-fit:cover;background:#1e293b;flex-shrink:0">' : '<div style="width:76px;height:76px;background:#1e293b;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">📦</div>')
    + '<div><p style="margin:0 0 5px;color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:1px">via ' + platform + '</p>'
    + '<p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600;line-height:1.4">' + productTitle.slice(0,90) + (productTitle.length > 90 ? '…' : '') + '</p></div></div></div>'
    + priceBlock
    + '<div style="text-align:center;margin-bottom:20px">'
    + '<a href="' + buyUrl + '" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ef4444);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:800">🛒 Buy Now on ' + platform + ' →</a></div>'
    + '<div style="text-align:center;padding:14px 0;border-top:1px solid rgba(255,255,255,0.06)">'
    + '<p style="margin:0 0 6px;font-size:13px;color:#475569"><a href="' + APP + '" style="color:#67e8f9;text-decoration:none">Dashboard</a></p>'
    + '<p style="margin:0;font-size:12px;color:#334155">Prices may change. Verify on the retailer\'s site.</p></div>'
    + '</div></body></html>';

  var response = await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: process.env.BREVO_SENDER_NAME || 'PriceHawk', email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: toEmail }],
    subject: subjectLine,
    htmlContent: html,
    textContent: headerTitle + '\n\n' + productTitle + '\n\nNew: ' + fmt(newPrice) + ' | Was: ' + fmt(oldPrice) + '\n' + (isDropAlert ? 'Save: ' + fmt(savingAmount) + ' (' + dropPct.toFixed(1) + '% off)' : 'Increase: ' + dropPct.toFixed(1) + '%') + '\n\nBuy: ' + buyUrl,
  }, { headers: brevoHeaders(), timeout: 10000 });

  console.log('[EMAIL] ✅ ' + (isDropAlert ? 'Drop alert' : 'Rise warning') + ' sent to ' + toEmail + ' — ID: ' + response.data.messageId);
}

// ════════════════════════════════════════════════════════════════════════════
//
//   █████╗ ██████╗ ██╗    ██████╗  ██████╗ ██╗   ██╗████████╗███████╗███████╗
//  ██╔══██╗██╔══██╗██║    ██╔══██╗██╔═══██╗██║   ██║╚══██╔══╝██╔════╝██╔════╝
//  ███████║██████╔╝██║    ██████╔╝██║   ██║██║   ██║   ██║   █████╗  ███████╗
//  ██╔══██║██╔═══╝ ██║    ██╔══██╗██║   ██║██║   ██║   ██║   ██╔══╝  ╚════██║
//  ██║  ██║██║     ██║    ██║  ██║╚██████╔╝╚██████╔╝   ██║   ███████╗███████║
//  ╚═╝  ╚═╝╚═╝     ╚═╝    ╚═╝  ╚═╝ ╚═════╝  ╚═════╝    ╚═╝   ╚══════╝╚══════╝
//
// ════════════════════════════════════════════════════════════════════════════

var app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

var globalLimit = rateLimit({ windowMs: 60000, max: 100 });
var trackLimit  = rateLimit({ windowMs: 60000, max: 5,
  message: { error: 'Slow down — max 5 track requests per minute.' } });
app.use(globalLimit);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', function(_, res) {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── TRACK PRODUCT ────────────────────────────────────────────────────────────
app.post('/api/products/track', trackLimit, async function(req, res) {
  var rawInput    = req.body.rawInput;
  var email       = req.body.email;
  var targetPrice = req.body.targetPrice;

  if (!rawInput) return respond(res, 400, { error: 'Please provide a product URL or share text.' });

  var url = extractUrlFromInput(rawInput);
  if (!url) return respond(res, 400, { error: 'No valid URL found in your input. Please paste the product URL directly.' });
  if (!isDomainAllowed(url)) return respond(res, 400, { error: new URL(url).hostname + ' is not a supported website yet.' });

  var platform = detectPlatform(url);

  var scraped;
  try {
    scraped = await scrapeProduct(url, platform);
  } catch (err) {
    console.error('[TRACK] Scrape failed:', err.message);
    return respond(res, 502, { error: 'Could not fetch product details. Check the URL and try again.' });
  }

  var resolvedUrl  = scraped.resolvedUrl || url;
  var slug         = makeSlug(scraped.title);
  var affiliateUrl = buildAffiliateUrl(resolvedUrl, platform);

  // Upsert user
  var userEmail = email || 'anonymous@pricehawk.in';
  var userId;
  var existingUser = await supabase.from('users').select('id').eq('email', userEmail).single();
  if (!existingUser.data) {
    var createdUser = await supabase.from('users').insert({ email: userEmail }).select('id').single();
    userId = createdUser.data && createdUser.data.id;
  } else {
    userId = existingUser.data.id;
  }

  var productInsert = await supabase.from('products').insert({
    user_id:        userId,
    slug:           slug,
    title:          scraped.title,
    brand:          scraped.brand,
    model_number:   scraped.modelNumber,
    image_url:      scraped.imageUrl,
    category:       scraped.category,
    source_url:     resolvedUrl,
    platform:       platform,
    current_price:  scraped.price,
    original_price: scraped.originalPrice || scraped.price,
    in_stock:       scraped.inStock,
    affiliate_url:  affiliateUrl,
    last_scraped:   new Date().toISOString(),
  }).select().single();

  if (productInsert.error) {
    console.error('[TRACK] DB error:', productInsert.error.message);
    return respond(res, 500, { error: 'Database error. Please try again.' });
  }
  var product = productInsert.data;

  await supabase.from('price_history').insert({
    product_id: product.id, price: scraped.price, in_stock: scraped.inStock, source: 'scraper',
  });

  await supabase.from('tracking_jobs').insert({
    product_id: product.id, status: 'pending',
    next_run: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
  });

  // Create alert — tagged 'user' or 'auto'
  var autoAlertSet = false;
  if (email) {
    if (targetPrice) {
      await supabase.from('alerts').insert({
        user_id: userId, product_id: product.id,
        email: email, target_price: Number(targetPrice), notes: 'user',
      });
    } else {
      await supabase.from('alerts').insert({
        user_id: userId, product_id: product.id,
        email: email, target_price: 0, notes: 'auto',
      });
      autoAlertSet = true;
    }
  }

  // Price sanity warnings
  var priceWarning = null;
  if (scraped.originalPrice && scraped.originalPrice > 0) {
    var diff = scraped.price - scraped.originalPrice;
    var pct  = Math.abs(diff / scraped.originalPrice * 100).toFixed(0);
    if (diff > scraped.originalPrice * 0.05) {
      priceWarning = { type: 'high', message: '⚠️ Current price (₹' + scraped.price.toLocaleString('en-IN') + ') is ' + pct + '% above the original listed price (₹' + scraped.originalPrice.toLocaleString('en-IN') + '). We\'ll notify you when it drops.' };
    } else if (diff < -(scraped.originalPrice * 0.3)) {
      priceWarning = { type: 'deal', message: '🎉 Great deal! ' + pct + '% below original price. You\'re tracking at a great price point!' };
    }
  }

  // Send welcome email (non-blocking)
  if (email) {
    sendWelcomeEmail({
      toEmail: email, productTitle: scraped.title, productImage: scraped.imageUrl,
      platform: platform, currentPrice: scraped.price, originalPrice: scraped.originalPrice,
      targetPrice: targetPrice ? Number(targetPrice) : null,
      buyUrl: (process.env.FRONTEND_URL || 'https://pricehawk.onrender.com') + '/go/' + product.id,
    }).catch(function(err) { console.error('[EMAIL] Welcome email failed:', err.message); });
  }

  respond(res, 201, {
    success: true,
    message: 'Tracking started from today! 🎯',
    extractedUrl: url !== rawInput.trim() ? url : null,
    priceWarning: priceWarning,
    product: Object.assign({}, product, { autoAlertSet: autoAlertSet }),
    scraped: scraped,
  });
});

// ─── GET PRODUCTS ─────────────────────────────────────────────────────────────
app.get('/api/products', async function(req, res) {
  var email = req.query.email;
  if (!email) return respond(res, 400, { error: 'email query required' });
  var userResult = await supabase.from('users').select('id').eq('email', email).single();
  if (!userResult.data) return respond(res, 200, []);
  var result = await supabase.from('products').select('*')
    .eq('user_id', userResult.data.id).eq('is_active', true)
    .order('created_at', { ascending: false });
  if (result.error) return respond(res, 500, { error: result.error.message });
  respond(res, 200, result.data);
});

// ─── GET SINGLE PRODUCT ───────────────────────────────────────────────────────
app.get('/api/products/:id', async function(req, res) {
  var result = await supabase.from('products').select('*').eq('id', req.params.id).single();
  if (result.error || !result.data) return respond(res, 404, { error: 'Product not found.' });
  respond(res, 200, result.data);
});

// ─── PRICE HISTORY ────────────────────────────────────────────────────────────
app.get('/api/products/:id/history', async function(req, res) {
  var days  = Number(req.query.days) || 30;
  var since = new Date(Date.now() - days * 86400000).toISOString();
  var result = await supabase.from('price_history')
    .select('price, in_stock, recorded_at')
    .eq('product_id', req.params.id)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });
  if (result.error) return respond(res, 500, { error: result.error.message });
  respond(res, 200, result.data);
});

// ─── AI PREDICTION ────────────────────────────────────────────────────────────
app.get('/api/products/:id/predict', async function(req, res) {
  var histResult = await supabase.from('price_history')
    .select('price, recorded_at').eq('product_id', req.params.id)
    .order('recorded_at', { ascending: false }).limit(60);
  var prodResult = await supabase.from('products')
    .select('title, platform, current_price').eq('id', req.params.id).single();
  if (!histResult.data || !histResult.data.length)
    return respond(res, 400, { error: 'Not enough price data yet.' });
  var prediction = await generatePrediction(prodResult.data, histResult.data.reverse());
  await supabase.from('predictions').insert({
    product_id:   req.params.id,
    engine:       prediction.engine,
    trend:        prediction.trend,
    drop_prob:    prediction.dropProbability,
    best_time:    prediction.bestTimeToBuy,
    min_estimate: prediction.estimatedRange && prediction.estimatedRange.min,
    max_estimate: prediction.estimatedRange && prediction.estimatedRange.max,
    summary:      prediction.summary,
  });
  respond(res, 200, prediction);
});

// ─── SET ALERT ────────────────────────────────────────────────────────────────
app.post('/api/alerts', async function(req, res) {
  var productId   = req.body.productId;
  var email       = req.body.email;
  var targetPrice = req.body.targetPrice;
  if (!productId || !email || !targetPrice)
    return respond(res, 400, { error: 'productId, email, and targetPrice are required.' });
  var userResult = await supabase.from('users').select('id').eq('email', email).single();
  var userId;
  if (!userResult.data) {
    var newUser = await supabase.from('users').insert({ email: email }).select('id').single();
    userId = newUser.data && newUser.data.id;
  } else {
    userId = userResult.data.id;
  }
  var result = await supabase.from('alerts').insert({
    user_id: userId, product_id: productId,
    email: email, target_price: Number(targetPrice), notes: 'user',
  }).select().single();
  if (result.error) return respond(res, 500, { error: result.error.message });
  respond(res, 201, { success: true, alert: result.data });
});

// ─── DELETE PRODUCT ───────────────────────────────────────────────────────────
app.delete('/api/products/:id', async function(req, res) {
  await supabase.from('products').update({ is_active: false }).eq('id', req.params.id);
  respond(res, 200, { success: true });
});

// ─── AFFILIATE REDIRECT ───────────────────────────────────────────────────────
app.get('/go/:id', async function(req, res) {
  var result = await supabase.from('products')
    .select('affiliate_url, source_url, platform').eq('id', req.params.id).single();
  if (!result.data) return res.redirect('/');
  var ip = req.ip || req.headers['x-forwarded-for'] || '';
  await supabase.from('click_logs').insert({
    product_id: req.params.id, platform: result.data.platform,
    ip_hash: crypto.createHash('sha256').update(ip).digest('hex'),
  });
  res.redirect(result.data.affiliate_url || result.data.source_url);
});

// ─── TOP DEALS ────────────────────────────────────────────────────────────────
app.get('/api/deals', async function(req, res) {
  var result = await supabase.from('top_deals').select('*').limit(20);
  if (result.error) return respond(res, 500, { error: result.error.message });
  respond(res, 200, result.data);
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', function(_, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════════════════════════════════════
//  WORKER
// ════════════════════════════════════════════════════════════════════════════

var runningJobs = 0;
var MAX_CONCURRENT = 3;

async function checkAlerts(product, newPrice, oldPrice) {
  var originalPrice = parseFloat(product.original_price || 0);
  var priceDropped  = newPrice < oldPrice;
  var priceRose     = newPrice > oldPrice;

  // User-set alerts (notes='user') — fire when price drops to/below target
  if (priceDropped) {
    var userAlerts = await supabase.from('alerts').select('*')
      .eq('product_id', product.id).eq('is_active', true)
      .eq('notes', 'user').lte('target_price', newPrice);
    for (var i = 0; i < (userAlerts.data || []).length; i++) {
      var alert = userAlerts.data[i];
      try {
        await sendAlertEmail({
          toEmail: alert.email, productTitle: product.title,
          productImage: product.image_url, platform: product.platform,
          newPrice: newPrice, oldPrice: oldPrice, originalPrice: originalPrice,
          buyUrl: (process.env.FRONTEND_URL || 'https://pricehawk.onrender.com') + '/go/' + product.id,
          targetPrice: alert.target_price, priceType: 'drop',
        });
        await supabase.from('alerts').update({
          is_active: false, triggered_at: new Date().toISOString(),
          trigger_count: (alert.trigger_count || 0) + 1,
        }).eq('id', alert.id);
        console.log('[ALERT] ✅ Drop alert sent to ' + alert.email);
      } catch (err) { console.error('[ALERT] Drop send failed:', err.message); }
    }
  }

  // Auto-monitoring alerts (notes='auto')
  var autoAlerts = await supabase.from('alerts').select('*')
    .eq('product_id', product.id).eq('is_active', true).eq('notes', 'auto');
  for (var j = 0; j < (autoAlerts.data || []).length; j++) {
    var autoAlert = autoAlerts.data[j];
    try {
      if (originalPrice > 0 && newPrice < originalPrice && priceDropped) {
        await sendAlertEmail({
          toEmail: autoAlert.email, productTitle: product.title,
          productImage: product.image_url, platform: product.platform,
          newPrice: newPrice, oldPrice: oldPrice, originalPrice: originalPrice,
          buyUrl: (process.env.FRONTEND_URL || 'https://pricehawk.onrender.com') + '/go/' + product.id,
          targetPrice: null, priceType: 'drop',
        });
        await supabase.from('alerts').update({
          is_active: false, triggered_at: new Date().toISOString(),
          trigger_count: (autoAlert.trigger_count || 0) + 1,
        }).eq('id', autoAlert.id);
        console.log('[ALERT] ✅ Auto drop alert sent to ' + autoAlert.email);
      } else if (originalPrice > 0 && newPrice > originalPrice * 1.05 && priceRose) {
        await sendAlertEmail({
          toEmail: autoAlert.email, productTitle: product.title,
          productImage: product.image_url, platform: product.platform,
          newPrice: newPrice, oldPrice: oldPrice, originalPrice: originalPrice,
          buyUrl: (process.env.FRONTEND_URL || 'https://pricehawk.onrender.com') + '/go/' + product.id,
          targetPrice: null, priceType: 'rise',
        });
        console.log('[ALERT] ⚠️ Rise warning sent to ' + autoAlert.email);
      }
    } catch (err) { console.error('[ALERT] Auto-alert failed:', err.message); }
  }
}

async function processJob(job) {
  var product = job.products;
  if (!product) return;
  await supabase.from('tracking_jobs').update({ status: 'running' }).eq('id', job.id);
  try {
    var scraped  = await scrapeProduct(product.source_url, product.platform);
    var newPrice = parseFloat(scraped.price);
    var oldPrice = parseFloat(product.current_price || 0);

    await supabase.from('products').update({
      current_price: newPrice,
      original_price: scraped.originalPrice || product.original_price,
      in_stock: scraped.inStock,
      last_scraped: new Date().toISOString(),
    }).eq('id', product.id);

    await supabase.from('price_history').insert({
      product_id: product.id, price: newPrice, in_stock: scraped.inStock, source: 'scraper',
    });

    await checkAlerts(product, newPrice, oldPrice);

    await supabase.from('tracking_jobs').update({
      status: 'done', last_run: new Date().toISOString(),
      next_run: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      retry_count: 0, error_log: null,
    }).eq('id', job.id);

    console.log('[WORKER] ✅ ' + (product.title || '').slice(0,40) + ' — ₹' + oldPrice + ' → ₹' + newPrice);
  } catch (err) {
    var retries = (job.retry_count || 0) + 1;
    await supabase.from('tracking_jobs').update({
      status: retries >= 5 ? 'failed' : 'pending',
      retry_count: retries, last_run: new Date().toISOString(),
      next_run: new Date(Date.now() + Math.min(retries * 30 * 60 * 1000, 4 * 3600 * 1000)).toISOString(),
      error_log: err.message,
    }).eq('id', job.id);
    console.error('[WORKER] ❌ ' + (product.title || '').slice(0,40) + ' — ' + err.message);
  }
}

async function runPriceUpdates() {
  console.log('\n[WORKER] ── Price update cycle ──────────────────────────────');
  var result = await supabase.from('tracking_jobs')
    .select('id, product_id, retry_count, products(id, title, source_url, platform, current_price, original_price, affiliate_url, image_url)')
    .in('status', ['pending','failed'])
    .lte('next_run', new Date().toISOString())
    .order('next_run', { ascending: true })
    .limit(20);

  if (result.error) { console.error('[WORKER] Fetch jobs error:', result.error.message); return; }
  if (!result.data || !result.data.length) { console.log('[WORKER] No jobs due ✅'); return; }

  console.log('[WORKER] ' + result.data.length + ' job(s) to process');
  for (var i = 0; i < result.data.length; i++) {
    while (runningJobs >= MAX_CONCURRENT) await sleep(2000);
    runningJobs++;
    processJob(result.data[i]).finally(function() { runningJobs--; });
    await sleep(1500 + Math.random() * 1000);
  }
}

async function archiveInactive() {
  var cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  var result = await supabase.from('products').select('id').eq('is_active', true).lt('last_scraped', cutoff);
  if (result.data && result.data.length) {
    await supabase.from('products').update({ is_active: false })
      .in('id', result.data.map(function(p) { return p.id; }));
    console.log('[WORKER] Archived ' + result.data.length + ' inactive products');
  }
}

// Cron jobs
cron.schedule('*/90 * * * *', function() { runPriceUpdates().catch(console.error); });
cron.schedule('0 * * * *',    function() {
  supabase.rpc('refresh_top_deals')
    .then(function() { console.log('[CRON] Deals refreshed'); })
    .catch(console.error);
});
cron.schedule('0 3 * * *', function() { archiveInactive().catch(console.error); });

// ════════════════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════════════════
var PORT = process.env.PORT || 3001;
app.listen(PORT, function() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   🦅  PriceHawk is running!                      ║');
  console.log('║   Port: ' + PORT + '                                    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log('  Supabase : ' + (process.env.SUPABASE_URL || '❌ NOT SET'));
  console.log('  Gemini   : ' + (geminiModel ? '✅ Connected' : '⚠️  Not set (math fallback active)'));
  console.log('  Email    : ' + (isBrevoConfigured() ? '✅ Brevo ready — ' + process.env.BREVO_SENDER_EMAIL : '⚠️  BREVO keys not set'));
  console.log('  Cron     : ✅ Price updates every 90 minutes\n');
  runPriceUpdates().catch(console.error);
});

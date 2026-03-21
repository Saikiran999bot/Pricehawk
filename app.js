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
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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
    var closeSelectors = ['button._2KpZ6l._2doB4z','button[class*="close"]','._2doB4z'];
    for (var s = 0; s < closeSelectors.length; s++) {
      var btn = await page.$(closeSelectors[s]);
      if (btn) { await btn.click(); break; }
    }
  } catch (e) {}

  // Extra wait for JS-rendered price to appear
  await humanDelay(1500, 2500);

  // Scroll down to trigger lazy-loaded price elements
  await page.evaluate(function() {
    window.scrollBy(0, 500);
  });
  await humanDelay(800, 1200);

  return page.evaluate(function() {
    function getText(sels) {
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        var t = el && el.textContent && el.textContent.trim();
        if (t) return t;
      }
      return null;
    }

    // ── STEP 1: Try JSON-LD structured data first (most reliable) ─────────
    var price = 0, originalPrice = null, title = '', imageUrl = '', brand = null;
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var si = 0; si < scripts.length; si++) {
      try {
        var jd = JSON.parse(scripts[si].textContent);
        var prod = jd['@type'] === 'Product' ? jd
          : (Array.isArray(jd) ? jd.find(function(x){ return x['@type']==='Product'; }) : null);
        if (prod) {
          var offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
          if (offer && offer.price) price = parseFloat(offer.price) || 0;
          if (prod.name) title = prod.name;
          if (prod.image) imageUrl = Array.isArray(prod.image) ? prod.image[0] : prod.image;
          if (prod.brand && prod.brand.name) brand = prod.brand.name;
          break;
        }
      } catch(e) {}
    }

    // ── STEP 2: CSS selector fallback for price if JSON-LD missed it ──────
    if (!price) {
      var priceText = getText([
        '._30jeq3._16Jk6d', '._30jeq3', '._16Jk6d',
        'div._25b18c ._30jeq3', '._16Jk6d ._30jeq3',
        '[class*="finalPrice"]', '[class*="selling-price"]',
        'div[class*="price"] div[class*="amount"]',
        // innerText scan — last resort
      ]);
      if (priceText) price = parseFloat(priceText.replace(/[^0-9.]/g,'')) || 0;

      // Nuclear option: scan all elements for ₹ price pattern
      if (!price) {
        var allEls = document.querySelectorAll('*');
        for (var ei = 0; ei < allEls.length && ei < 2000; ei++) {
          var txt = allEls[ei].childNodes.length === 1
            && allEls[ei].firstChild.nodeType === 3
            && allEls[ei].textContent.trim();
          if (txt && /^₹[\d,]+$/.test(txt.trim())) {
            var candidate = parseFloat(txt.replace(/[^0-9.]/g,''));
            if (candidate > 100) { price = candidate; break; }
          }
        }
      }
    }

    // ── STEP 3: Title fallback ─────────────────────────────────────────────
    if (!title) {
      title = getText([
        '.B_NuCI', '.yhB1nd', 'h1.yhB1nd', 'h1._9E25nV', 'h1',
        'span.B_NuCI', '[class*="ProductTitle"]', 'div[class*="title"] h1',
      ]);
      if (!title) {
        var ogTitle = document.querySelector('meta[property="og:title"]');
        title = ogTitle ? ogTitle.getAttribute('content') : '';
      }
    }
    title = title || '';

    // ── MRP / Original price ──────────────────────────────────────────────
    if (!originalPrice) {
      var mrpText = getText(['._3I9_wc._2p6lqe','._3I9_wc','._2p6lqe',
        'div[class*="MRP"]','span[class*="mrp"]','[class*="strike"]']);
      if (mrpText) originalPrice = parseFloat(mrpText.replace(/[^0-9.]/g,'')) || null;
    }

    // ── Image fallback ────────────────────────────────────────────────────
    if (!imageUrl) {
      var imgEl = document.querySelector('._396cs4 img')
        || document.querySelector('._2r_T1I img')
        || document.querySelector('img.q6DClP')
        || document.querySelector('img._2amPTt')
        || document.querySelector('div[class*="image"] img');
      var ogImg = document.querySelector('meta[property="og:image"]');
      imageUrl = (imgEl && imgEl.src) || (ogImg && ogImg.getAttribute('content')) || '';
    }

    // ── Brand / Rating / Stock / Category ─────────────────────────────────
    if (!brand) {
      var brandEl = document.querySelector('span.G6XhRU')
        || document.querySelector('._2whKao a');
      brand = brandEl ? brandEl.textContent.trim() : null;
    }
    var ratingText = getText(['._3LWZlK','div[class*="rating"] span']);
    var rating = ratingText ? parseFloat(ratingText) : null;
    var inStock = !document.querySelector('._16FRp0')
      && !document.querySelector('[class*="out-of-stock"]');
    var catEl = document.querySelector('div._1MR4o5 a:last-child')
      || document.querySelector('nav a:last-child');
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

      // domcontentloaded is lighter on RAM; manual scroll+delay lets JS render prices
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await humanDelay(2000, 3000);   // wait for JS-rendered prices
      await page.evaluate(function() { window.scrollBy(0, 400); });
      await humanDelay(1000, 1500);
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

  var prices  = history.map(function(h) { return parseFloat(h.price); });
  var cur     = prices[prices.length - 1];
  var minP    = Math.min.apply(null, prices);
  var maxP    = Math.max.apply(null, prices);
  var avgP    = (prices.reduce(function(a,b){return a+b;},0) / prices.length).toFixed(2);
  var firstP  = prices[0];
  var changePct = ((cur - firstP) / firstP * 100).toFixed(1);

  // Build compact time-series (max 40 points)
  var step = Math.max(1, Math.floor(history.length / 40));
  var series = history
    .filter(function(_, i) { return i % step === 0 || i === history.length - 1; })
    .map(function(h) {
      var d = new Date(h.recorded_at);
      return d.getDate() + '/' + (d.getMonth()+1) + '/' + d.getFullYear() + ': ₹' + parseFloat(h.price).toLocaleString('en-IN');
    }).join('\n');

  var prompt = [
    'You are an expert e-commerce price analyst for the Indian market.',
    'Analyze the following product price history and give a detailed prediction.',
    '',
    '=== PRODUCT ===',
    'Name: ' + product.title,
    'Platform: ' + product.platform,
    'Current Price: ₹' + cur.toLocaleString('en-IN'),
    'All-time Low: ₹' + minP.toLocaleString('en-IN'),
    'All-time High: ₹' + maxP.toLocaleString('en-IN'),
    'Average Price: ₹' + parseFloat(avgP).toLocaleString('en-IN'),
    'Price Change (first to now): ' + changePct + '%',
    'Total data points: ' + history.length,
    '',
    '=== PRICE HISTORY (date: price) ===',
    series,
    '',
    '=== YOUR TASK ===',
    'Based on the price history pattern, predict:',
    '1. Will the price GO UP or GO DOWN in the next 7-30 days?',
    '2. What is the probability (0-100) that the price will DROP?',
    '3. What is the best time to buy?',
    '4. Give 3 specific actionable insights about this product pricing.',
    '5. Predict the likely price range over next 30 days.',
    '',
    'IMPORTANT: You MUST respond with ONLY valid JSON. No markdown, no explanation outside JSON.',
    '',
    'Required JSON format:',
    '{',
    '  "trend": "decreasing" or "increasing" or "stable",',
    '  "priceDirection": "PRICE WILL GO DOWN" or "PRICE WILL GO UP" or "PRICE WILL STAY STABLE",',
    '  "dropProbability": <integer 0-100>,',
    '  "confidence": "high" or "medium" or "low",',
    '  "bestTimeToBuy": "<one clear sentence>",',
    '  "estimatedRange": { "min": <number>, "max": <number> },',
    '  "summary": "<2-3 clear sentences explaining the price outlook>",',
    '  "keyInsights": [',
    '    "<specific insight about price pattern>",',
    '    "<specific insight about best deal timing>",',
    '    "<specific insight about risk or opportunity>"',
    '  ],',
    '  "recommendation": "BUY NOW" or "WAIT" or "MONITOR"',
    '}',
  ].join('\n');

  console.log('[GEMINI] Sending prediction request for:', product.title.slice(0,50));

  var result = await geminiModel.generateContent(prompt);
  var raw    = result.response.text().trim();

  // Strip any markdown code fences Gemini might add
  raw = raw.replace(/^```json\s*/im, '').replace(/^```\s*/im, '').replace(/\s*```$/im, '').trim();

  // Extract JSON if wrapped in extra text
  var jsonStart = raw.indexOf('{');
  var jsonEnd   = raw.lastIndexOf('}');
  if (jsonStart > -1 && jsonEnd > -1) {
    raw = raw.slice(jsonStart, jsonEnd + 1);
  }

  var parsed = JSON.parse(raw);

  if (!parsed.trend || typeof parsed.dropProbability !== 'number')
    throw new Error('Incomplete Gemini response — missing required fields');

  return {
    engine:         'gemini',
    trend:          parsed.trend,
    priceDirection: parsed.priceDirection || (parsed.trend === 'decreasing' ? 'PRICE WILL GO DOWN' : parsed.trend === 'increasing' ? 'PRICE WILL GO UP' : 'PRICE WILL STAY STABLE'),
    dropProbability: Math.max(0, Math.min(100, Math.round(parsed.dropProbability))),
    confidence:     parsed.confidence || 'medium',
    bestTimeToBuy:  parsed.bestTimeToBuy || '',
    estimatedRange: parsed.estimatedRange || { min: minP, max: maxP },
    summary:        parsed.summary || '',
    keyInsights:    parsed.keyInsights || [],
    recommendation: parsed.recommendation || 'MONITOR',
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
        new Promise(function(_, r) { setTimeout(function() { r(new Error('Timeout')); }, 30000); }),
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
  var productId     = opts.productId;

  var fmt = function(n) { return '\u20b9' + Number(n).toLocaleString('en-IN'); };
  var APP = process.env.FRONTEND_URL || 'https://pricehawk.onrender.com';

  var savingPct = originalPrice && originalPrice > currentPrice
    ? ((originalPrice - currentPrice) / originalPrice * 100).toFixed(0) : null;

  var alertMsg = targetPrice
    ? '\u26a0\ufe0f Price Alert Set at ' + fmt(targetPrice) + " — We'll email you the instant price hits your target."
    : '\ud83d\udcca Auto-Monitoring Active — We track every price change and alert you when it drops below the original price.';

  var alertColor  = targetPrice ? '#7c3aed' : '#0891b2';
  var alertBorder = targetPrice ? 'rgba(167,139,250,0.3)' : 'rgba(6,182,212,0.3)';
  var alertBg     = targetPrice ? 'rgba(124,58,237,0.1)' : 'rgba(6,182,212,0.08)';

  var html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Tracking Started \u2014 PriceHawk</title>',
    '</head>',
    '<body style="margin:0;padding:0;background:#060b14;font-family:Segoe UI,system-ui,sans-serif">',
    '<div style="max-width:580px;margin:0 auto;padding:0 0 32px">',

    // ── Header band
    '<div style="background:linear-gradient(135deg,#0f1f3d 0%,#1a0933 100%);padding:32px 24px;text-align:center;border-bottom:1px solid rgba(6,182,212,0.2)">',
    '<div style="display:inline-block;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.3);border-radius:12px;padding:8px 20px;margin-bottom:18px">',
    '<span style="font-size:20px;font-weight:900;color:#67e8f9;letter-spacing:-0.5px">\ud83e\uddd4 PriceHawk</span>',
    '</div>',
    '<h1 style="margin:0 0 8px;color:#f0f6ff;font-size:26px;font-weight:800;letter-spacing:-0.5px">\u2705 You are Now Tracking!</h1>',
    '<p style="margin:0;color:#94a3b8;font-size:15px">Price monitoring has started \u2014 we have got you covered.</p>',
    '</div>',

    // ── Product card
    '<div style="margin:24px 16px 0;background:#0a1628;border:1px solid rgba(100,200,255,0.12);border-radius:16px;padding:20px">',
    '<div style="display:flex;gap:16px;align-items:flex-start">',
    productImage
      ? '<img src="' + productImage + '" width="100" height="100" style="border-radius:10px;object-fit:cover;flex-shrink:0;background:#162848">'
      : '<div style="width:100px;height:100px;background:#162848;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:36px;flex-shrink:0">\ud83d\udce6</div>',
    '<div style="flex:1;min-width:0">',
    '<p style="margin:0 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600">via ' + platform.toUpperCase() + '</p>',
    '<p style="margin:0 0 10px;color:#e2e8f0;font-size:14px;font-weight:600;line-height:1.5">' + productTitle.slice(0,100) + (productTitle.length > 100 ? '\u2026' : '') + '</p>',
    '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">',
    '<span style="font-size:26px;font-weight:900;color:#22d3ee">' + fmt(currentPrice) + '</span>',
    originalPrice && originalPrice > currentPrice
      ? '<span style="font-size:13px;color:#64748b;text-decoration:line-through">' + fmt(originalPrice) + '</span><span style="font-size:12px;font-weight:700;color:#4ade80;background:rgba(74,222,128,0.1);padding:2px 8px;border-radius:20px">\u2193 ' + savingPct + '% off</span>'
      : '',
    '</div>',
    '</div>',
    '</div>',
    '</div>',

    // ── Tracking status
    '<div style="margin:12px 16px 0;background:' + alertBg + ';border:1px solid ' + alertBorder + ';border-radius:12px;padding:14px 18px">',
    '<p style="margin:0;font-size:13px;color:#e2e8f0;line-height:1.6"><strong style="color:' + alertColor + '">\ud83d\udd14 Tracking Status:</strong> ' + alertMsg + '</p>',
    '</div>',

    // ── What happens next
    '<div style="margin:20px 16px 0;background:#0a1628;border:1px solid rgba(100,200,255,0.08);border-radius:16px;padding:20px">',
    '<p style="margin:0 0 14px;font-size:14px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px">What Happens Next</p>',
    '<div style="display:flex;flex-direction:column;gap:10px">',
    '<div style="display:flex;gap:12px;align-items:flex-start"><span style="font-size:18px;flex-shrink:0">\ud83d\udd04</span><div><p style="margin:0;font-size:13px;font-weight:600;color:#f1f5f9">Price checked every 90 minutes</p><p style="margin:2px 0 0;font-size:12px;color:#64748b">We scrape the live price automatically — no action needed from you.</p></div></div>',
    '<div style="display:flex;gap:12px;align-items:flex-start"><span style="font-size:18px;flex-shrink:0">\u26a1</span><div><p style="margin:0;font-size:13px;font-weight:600;color:#f1f5f9">Instant email alert on price drop</p><p style="margin:2px 0 0;font-size:12px;color:#64748b">You will be the first to know when the price falls.</p></div></div>',
    '<div style="display:flex;gap:12px;align-items:flex-start"><span style="font-size:18px;flex-shrink:0">\ud83d\udcc8</span><div><p style="margin:0;font-size:13px;font-weight:600;color:#f1f5f9">AI-powered price prediction</p><p style="margin:2px 0 0;font-size:12px;color:#64748b">Our AI analyses price history to predict if prices will go up or down.</p></div></div>',
    '</div>',
    '</div>',

    // ── CTA buttons
    '<div style="margin:20px 16px 0;display:flex;gap:10px;flex-wrap:wrap">',
    '<a href="' + APP + '" style="flex:1;min-width:120px;display:inline-block;background:linear-gradient(135deg,#0891b2,#4f46e5);color:#fff;text-decoration:none;padding:13px 20px;border-radius:10px;font-size:14px;font-weight:700;text-align:center">\ud83d\udcca View Dashboard</a>',
    '<a href="' + buyUrl + '" style="flex:1;min-width:120px;display:inline-block;background:linear-gradient(135deg,#f97316,#ef4444);color:#fff;text-decoration:none;padding:13px 20px;border-radius:10px;font-size:14px;font-weight:700;text-align:center">\ud83d\uded2 Buy Now</a>',
    '</div>',

    // ── Thank you footer
    '<div style="margin:24px 16px 0;text-align:center;padding:20px;border-top:1px solid rgba(255,255,255,0.05)">',
    '<p style="margin:0 0 6px;font-size:15px;color:#67e8f9;font-weight:700">Thank you for using PriceHawk! \ud83d\udc4b</p>',
    '<p style="margin:0 0 12px;font-size:13px;color:#475569">We will do the hard work of tracking prices so you never overpay again.</p>',
    '<p style="margin:0;font-size:12px;color:#1e3a5f">',
    '<a href="' + APP + '" style="color:#22d3ee;text-decoration:none">' + APP.replace('https://','') + '</a>',
    ' &nbsp;|&nbsp; PriceHawk \u2014 Smart Price Intelligence',
    '</p>',
    '</div>',

    '</div>',
    '</body>',
    '</html>',
  ].join('\n');

  try {
    var response = await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: process.env.BREVO_SENDER_NAME || 'PriceHawk', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: '\u2705 PriceHawk is tracking: ' + productTitle.slice(0,55) + (productTitle.length > 55 ? '\u2026' : ''),
      htmlContent: html,
      textContent: [
        'Hi! PriceHawk is now tracking your product.',
        '',
        'Product: ' + productTitle,
        'Platform: ' + platform,
        'Current Price: ' + fmt(currentPrice),
        targetPrice ? 'Alert set for: ' + fmt(targetPrice) : 'Auto-monitoring: ON',
        '',
        'We will email you immediately when the price drops.',
        '',
        'View your dashboard: ' + APP,
        '',
        'Thank you for using PriceHawk!',
        'Smart Price Intelligence',
      ].join('\n'),
    }, { headers: brevoHeaders(), timeout: 12000 });

    console.log('[EMAIL] \u2705 Welcome email sent to ' + toEmail + ' \u2014 ID: ' + response.data.messageId);
  } catch (emailErr) {
    console.error('[EMAIL] \u274c Welcome email failed:', emailErr.response ? JSON.stringify(emailErr.response.data) : emailErr.message);
    throw emailErr;
  }
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

// Required for Render/Heroku — sits behind a reverse proxy
app.set('trust proxy', 1);

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
  // Ensure any uncaught error returns JSON, not HTML
  try {
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
        email: email, target_price: Number(targetPrice), is_auto: false,
      });
    } else {
      await supabase.from('alerts').insert({
        user_id: userId, product_id: product.id,
        email: email, target_price: 0, is_auto: true,
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
  } catch (err) {
    console.error('[TRACK] Unexpected error:', err.message);
    return respond(res, 502, { error: 'Could not fetch product details. Check the URL and try again.' });
  }
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
  try {
    var histResult = await supabase.from('price_history')
      .select('price, recorded_at').eq('product_id', req.params.id)
      .order('recorded_at', { ascending: true }).limit(90);  // ascending for correct time order

    var prodResult = await supabase.from('products')
      .select('id, title, platform, current_price, original_price, brand, category')
      .eq('id', req.params.id).single();

    if (prodResult.error || !prodResult.data)
      return respond(res, 404, { error: 'Product not found.' });

    if (!histResult.data || histResult.data.length < 1) {
      // Return a basic prediction even with 1 data point
      return respond(res, 200, {
        engine: 'math',
        trend: 'stable',
        priceDirection: 'PRICE WILL STAY STABLE',
        dropProbability: 50,
        confidence: 'low',
        bestTimeToBuy: 'Just started tracking — check back in 24-48 hours for better analysis.',
        estimatedRange: null,
        summary: 'We just started tracking this product. Check back after a few price checks for a meaningful prediction.',
        keyInsights: [
          'Price tracking started today — we need at least a few data points.',
          'Check back after 24-48 hours for AI-powered price predictions.',
          'Meanwhile, set a price alert so you never miss a deal.'
        ],
        recommendation: 'MONITOR',
      });
    }

    console.log('[PREDICT] Running for:', prodResult.data.title.slice(0,50), '| Points:', histResult.data.length);

    var prediction = await generatePrediction(prodResult.data, histResult.data);

    // Cache prediction in DB (non-blocking)
    supabase.from('predictions').insert({
      product_id:   req.params.id,
      engine:       prediction.engine,
      trend:        prediction.trend,
      drop_prob:    prediction.dropProbability,
      best_time:    prediction.bestTimeToBuy,
      min_estimate: prediction.estimatedRange ? prediction.estimatedRange.min : null,
      max_estimate: prediction.estimatedRange ? prediction.estimatedRange.max : null,
      summary:      prediction.summary,
    }).then(function() {}).catch(function(e) { console.warn('[PREDICT] Cache insert failed:', e.message); });

    console.log('[PREDICT] Done — engine:', prediction.engine, '| trend:', prediction.trend, '| drop prob:', prediction.dropProbability + '%');
    respond(res, 200, prediction);

  } catch (err) {
    console.error('[PREDICT] Error:', err.message);
    respond(res, 500, { error: 'Prediction failed: ' + err.message });
  }
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
    email: email, target_price: Number(targetPrice), is_auto: false,
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

// ─── Global error handler — ensures JSON is returned, never HTML ──────────────
app.use(function(err, req, res, next) {
  console.error('[SERVER] Unhandled error:', err.message);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
  next(err);
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
      .eq('is_auto', false).lte('target_price', newPrice);
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
    .eq('product_id', product.id).eq('is_active', true).eq('is_auto', true);
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

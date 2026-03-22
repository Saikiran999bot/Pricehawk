// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                    PriceHawk — app.js                                   ║
// ║   All API keys come from environment variables (Render dashboard)       ║
// ║   Required env vars:                                                    ║
// ║     SUPABASE_URL          SUPABASE_SERVICE_KEY                          ║
// ║     BREVO_API_KEY         BREVO_SENDER_EMAIL    BREVO_SENDER_NAME       ║
// ║     GEMINI_API_KEY        FRONTEND_URL                                  ║
// ║   Optional:                                                             ║
// ║     AMAZON_AFFILIATE_TAG  CHROME_EXECUTABLE_PATH                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
'use strict';

require('dotenv').config(); // loads .env in local dev; Render injects vars directly

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
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const { createClient }       = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ════════════════════════════════════════════════════════════════════════════
//  DB CLIENT
// ════════════════════════════════════════════════════════════════════════════
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI CLIENT (lazy — null if key not set)
// ════════════════════════════════════════════════════════════════════════════
let geminiModel = null;
try {
  if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('your_')) {
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

// ─── Extract a clean URL from messy share text ────────────────────────────────
// Handles: "Take a look at... https://dl.flipkart.com/s/abc" style shares
// Also handles double-pasted text (the same URL appearing twice)
function extractUrlFromInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const cleaned = rawInput.trim();

  // First try: is the whole input already a plain URL?
  try {
    const u = new URL(cleaned);
    if (u.protocol === 'http:' || u.protocol === 'https:') return cleaned;
  } catch {}

  // Second try: pull ALL https:// URLs out of the text
  const urlRegex = /https?:\/\/[^\s"'<>)\]]+/g;
  const matches  = [...new Set(cleaned.match(urlRegex) || [])]; // deduplicate

  if (!matches.length) return null;

  // Prefer known e-commerce domains; fall back to first found
  const KNOWN = ['amazon.in','amazon.com','flipkart.com','meesho.com',
                 'myntra.com','snapdeal.com','tatacliq.com','nykaa.com',
                 'croma.com','dl.flipkart.com'];

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
function humanDelay(min = 600, max = 1800) { return sleep(Math.random() * (max - min) + min); }

async function launchBrowser() {
  // Auto-detect Chrome executable across different environments
  var executablePath = null;

  // 1. Explicit override via env var
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    // 2. Try to get path from puppeteer itself
    try {
      var { executablePath: ep } = require('puppeteer');
      executablePath = ep();
    } catch (e1) {
      // 3. Common Render/Linux paths
      var candidates = [
        '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
        '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.72/chrome-linux64/chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ];
      var fs = require('fs');
      for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
          executablePath = candidates[i];
          break;
        }
      }
    }
  }

  if (!executablePath) {
    // Last resort: scan the puppeteer cache directory
    try {
      var fs = require('fs');
      var cacheBase = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
      if (fs.existsSync(cacheBase)) {
        var glob = require('child_process').execSync(
          'find ' + cacheBase + ' -name "chrome" -type f 2>/dev/null | head -1'
        ).toString().trim();
        if (glob) executablePath = glob;
      }
    } catch (e2) {}
  }

  console.log('[BROWSER] executablePath:', executablePath || 'auto-detect (no path found)');

  var launchOpts = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
    ],
  };

  if (executablePath) launchOpts.executablePath = executablePath;

  return puppeteerExtra.launch(launchOpts);
}

async function createStealthPage(browser) {
  var page = await browser.newPage();

  // Realistic viewport sizes
  var viewports = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1280, height: 720 },
  ];
  var vp = viewports[Math.floor(Math.random() * viewports.length)];
  await page.setViewport(vp);
  await page.setUserAgent(randomUA());

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  });

  // puppeteer-extra-plugin-stealth handles all fingerprint masking automatically

  return page;
}

// ─── Amazon ───────────────────────────────────────────────────────────────────
async function scrapeAmazon(page) {
  await page.waitForSelector('#productTitle, h1', { timeout: 15000 });
  await humanDelay(400, 900);

  return page.evaluate(() => {
    const getText = sels => { for (const s of sels) { const t = document.querySelector(s)?.textContent?.trim(); if (t) return t; } return null; };
    const getAttr = (sels, a) => { for (const s of sels) { const v = document.querySelector(s)?.getAttribute(a); if (v) return v; } return null; };

    const title = getText(['#productTitle','#title span','h1.product-title-word-break'])
               || document.querySelector('meta[property="og:title"]')?.content || '';

    const priceWhole = getText(['.a-price-whole','#priceblock_ourprice','#priceblock_dealprice',
      '#apex_desktop .a-price-whole','.apexPriceToPay .a-price-whole',
      '#corePrice_feature_div .a-price-whole']) || '0';
    const priceFrac  = getText(['.a-price-fraction']) || '00';
    const price = parseFloat(`${priceWhole.replace(/[^0-9]/g,'')}.${priceFrac.replace(/[^0-9]/g,'').slice(0,2)}`) || 0;

    const mrpRaw = getText(['.a-price.a-text-price .a-offscreen','#listPrice','#priceblock_listprice','.basisPrice .a-price .a-offscreen']);
    const originalPrice = mrpRaw ? parseFloat(mrpRaw.replace(/[^0-9.]/g,'')) : null;

    const imageUrl = getAttr(['#landingImage','#imgBlkFront','#main-image'],'src')
      || getAttr(['#landingImage','#imgBlkFront'],'data-old-hires')
      || getAttr(['meta[property="og:image"]'],'content') || '';

    const brand = getText(['#bylineInfo','#brand'])?.replace(/^(Visit the |Brand: ?|by )/i,'').trim() || null;

    let modelNumber = null;
    for (const row of document.querySelectorAll('#productDetails_techSpec_section_1 tr, #detailBullets_feature_div li')) {
      const t = row.textContent || '';
      if (/model|item model/i.test(t)) { const p = t.split(/[:\n]/); if (p[1]) { modelNumber = p[1].trim(); break; } }
    }

    const ratingText = getText(['#averageCustomerReviews .a-icon-alt']);
    const rating = ratingText ? parseFloat(ratingText) : null;

    const stockEl  = document.querySelector('#availability span, #outOfStock');
    const inStock  = !stockEl?.textContent?.toLowerCase().match(/unavailable|out of stock/);

    const category = document.querySelector('#wayfinding-breadcrumbs_feature_div a:last-of-type')?.textContent?.trim() || null;

    return { title, price, originalPrice, imageUrl, brand, modelNumber, rating, inStock, category };
  });
}

// ─── Flipkart ─────────────────────────────────────────────────────────────────
async function scrapeFlipkart(page) {
  // Check for bot-detection / captcha page BEFORE doing anything
  const pageTitle = await page.title();
  if (/are you a human|captcha|robot|verify/i.test(pageTitle)) {
    throw new Error('Flipkart bot detection triggered — will retry with different fingerprint');
  }
  const pageContent = await page.evaluate(() => document.body.innerText.slice(0, 200));
  if (/are you a human|captcha|i am not a robot/i.test(pageContent)) {
    throw new Error('Flipkart CAPTCHA page detected — retrying');
  }

  // Dismiss login popup
  try {
    const closeBtn = await page.$('button._2KpZ6l._2doB4z, button[class*="close"], ._2doB4z');
    if (closeBtn) { await closeBtn.click(); await humanDelay(500, 800); }
  } catch {}

  // Wait generously for page to render
  await humanDelay(2500, 3500);

  // Scroll to trigger lazy-loaded content
  await page.evaluate(() => window.scrollBy(0, 600));
  await humanDelay(1000, 1500);

  return page.evaluate(() => {
    // ── Helper: get first non-empty text from selector list ───────────────────
    function getText(sels) {
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        var t = el && el.textContent && el.textContent.trim();
        if (t && t.length > 1) return t;
      }
      return null;
    }

    // ── LAYER 1: JSON-LD structured data (most reliable, never changes) ───────
    var title = '', price = 0, originalPrice = null, imageUrl = '', brand = null;
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      try {
        var data = JSON.parse(scripts[i].textContent);
        var prod = data['@type'] === 'Product' ? data
          : Array.isArray(data) ? data.find(function(x) { return x['@type'] === 'Product'; })
          : null;
        if (prod) {
          if (prod.name) title = prod.name;
          if (prod.brand && prod.brand.name) brand = prod.brand.name;
          if (prod.image) imageUrl = Array.isArray(prod.image) ? prod.image[0] : prod.image;
          var offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
          if (offer && offer.price) price = parseFloat(offer.price) || 0;
          break;
        }
      } catch (e) {}
    }

    // ── LAYER 2: CSS selectors for title (Flipkart class names change often) ──
    if (!title) {
      title = getText([
        '.B_NuCI', '.yhB1nd', 'h1.yhB1nd', 'h1._9E25nV', 'h1',
        'span.B_NuCI', '[class*="ProductTitle"]', '[class*="product-title"]',
        'div[class*="title"] h1', 'div[class*="Title"] h1',
        'meta[property="og:title"]',  // will not work with getText, handled below
      ]);
      // og:title fallback
      if (!title) {
        var ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) title = ogTitle.getAttribute('content') || '';
      }
    }

    // ── LAYER 3: CSS selectors for price ─────────────────────────────────────
    if (!price) {
      var priceText = getText([
        '._30jeq3._16Jk6d', '._30jeq3', '._16Jk6d',
        'div._25b18c ._30jeq3', '[class*="finalPrice"]',
        '[class*="selling-price"]', '[class*="price"] [class*="amount"]',
        'div[class*="Price"]',
      ]);
      if (priceText) price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;

      // NUCLEAR: scan all elements for ₹ price pattern
      if (!price) {
        var allEls = document.body.querySelectorAll('*');
        for (var j = 0; j < allEls.length && j < 3000; j++) {
          var el = allEls[j];
          if (el.childElementCount === 0) {
            var txt = (el.textContent || '').trim();
            if (/^₹[\d,]+$/.test(txt)) {
              var candidate = parseFloat(txt.replace(/[^0-9.]/g, ''));
              if (candidate > 500 && candidate < 10000000) {
                price = candidate;
                break;
              }
            }
          }
        }
      }
    }

    // ── LAYER 4: MRP / Original price ─────────────────────────────────────────
    if (!originalPrice) {
      var mrpText = getText([
        '._3I9_wc._2p6lqe', '._3I9_wc', '._2p6lqe',
        '[class*="mrp"]', '[class*="MRP"]', '[class*="strike"]',
        'span[class*="original"]', 'del',
      ]);
      if (mrpText) originalPrice = parseFloat(mrpText.replace(/[^0-9.]/g, '')) || null;
    }

    // ── Image ─────────────────────────────────────────────────────────────────
    if (!imageUrl) {
      var imgEl = document.querySelector('._396cs4 img, ._2r_T1I img, img.q6DClP, img._2amPTt')
        || document.querySelector('div[class*="image"] img, div[class*="Image"] img');
      var ogImg = document.querySelector('meta[property="og:image"]');
      imageUrl = (imgEl && imgEl.src) || (ogImg && ogImg.getAttribute('content')) || '';
    }

    // ── Brand / Rating / Stock ────────────────────────────────────────────────
    if (!brand) {
      var brandEl = document.querySelector('span.G6XhRU, ._2whKao a, [class*="brand"]');
      brand = brandEl ? brandEl.textContent.trim() : null;
    }
    var ratingText = getText(['._3LWZlK', 'div[class*="rating"] span']);
    var rating = ratingText ? parseFloat(ratingText) : null;
    var inStock = !document.querySelector('._16FRp0, [class*="out-of-stock"], [class*="OutOfStock"]');
    var catEl = document.querySelector('div._1MR4o5 a:last-child, nav a:last-child');
    var category = catEl ? catEl.textContent.trim() : null;

    return {
      title: (title || '').trim(),
      price: price,
      originalPrice: originalPrice,
      imageUrl: imageUrl,
      brand: brand,
      modelNumber: null,
      rating: rating,
      inStock: inStock,
      category: category,
    };
  });
}

// ─── Generic (JSON-LD / OpenGraph fallback) ───────────────────────────────────
async function scrapeGeneric(page) {
  await humanDelay(600, 1200);
  return page.evaluate(() => {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        const p = j['@type'] === 'Product' ? j : (Array.isArray(j) ? j.find(x => x['@type'] === 'Product') : null);
        if (p) {
          const o = Array.isArray(p.offers) ? p.offers[0] : p.offers;
          return { title: p.name||'', price: parseFloat(o?.price||0), originalPrice: null,
                   imageUrl: p.image?.[0]||p.image||'', brand: p.brand?.name||null,
                   modelNumber: p.mpn||null, rating: parseFloat(p.aggregateRating?.ratingValue||0)||null,
                   inStock: o?.availability?.includes('InStock')??true, category: p.category||null };
        }
      } catch {}
    }
    return { title: document.querySelector('meta[property="og:title"]')?.content||document.title||'',
             price: 0, originalPrice: null, imageUrl: document.querySelector('meta[property="og:image"]')?.content||'',
             brand: null, modelNumber: null, rating: null, inStock: true, category: null };
  });
}

// ─── Flipkart HTTP-only scrape (no browser — avoids bot detection) ────────────
async function scrapeFlipkartHttp(url) {
  // Try fetching the page via HTTP — sometimes works before JS renders
  var response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.google.com/',
    },
  });

  var html = response.data;

  // Extract JSON-LD from HTML
  var jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (var i = 0; i < jsonLdMatch.length; i++) {
      try {
        var jsonContent = jsonLdMatch[i].replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        var data = JSON.parse(jsonContent);
        var prod = data['@type'] === 'Product' ? data
          : Array.isArray(data) ? data.find(function(x) { return x['@type'] === 'Product'; })
          : null;
        if (prod) {
          var offer = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
          var price = parseFloat((offer && offer.price) || 0);
          var title = prod.name || '';
          if (title && price > 0) {
            return {
              title:         title,
              price:         price,
              originalPrice: null,
              imageUrl:      (prod.image && (Array.isArray(prod.image) ? prod.image[0] : prod.image)) || '',
              brand:         (prod.brand && prod.brand.name) || null,
              modelNumber:   prod.mpn || null,
              rating:        parseFloat((prod.aggregateRating && prod.aggregateRating.ratingValue) || 0) || null,
              inStock:       (offer && offer.availability && offer.availability.includes('InStock')) !== false,
              category:      prod.category || null,
            };
          }
        }
      } catch (e) {}
    }
  }

  // Fallback: og:title + og:image
  var ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  var ogImage = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  if (ogTitle && !/are you a human|captcha/i.test(ogTitle)) {
    // Try to find price in HTML with regex
    var priceMatch = html.match(/["']finalPrice["']\s*:\s*(\d+)/) ||
                     html.match(/"price"\s*:\s*"?(\d+)"?/) ||
                     html.match(/₹\s*(\d[\d,]+)/);
    var price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g,'')) : 0;
    return {
      title: ogTitle, price: price, originalPrice: null,
      imageUrl: ogImage || '', brand: null, modelNumber: null,
      rating: null, inStock: true, category: null,
    };
  }

  throw new Error('HTTP scrape could not extract product data');
}

// ─── Main scraper with retry ──────────────────────────────────────────────────
async function scrapeProduct(url, platform = 'other') {
  // For Flipkart: try fast HTTP method first (no browser, no bot detection)
  if (platform === 'flipkart') {
    try {
      console.log('[SCRAPER] Trying Flipkart HTTP method first...');
      var result = await scrapeFlipkartHttp(url);
      if (result && result.title && result.price > 0) {
        console.log('[SCRAPER] ✅ HTTP method succeeded:', result.title.slice(0,50));
        return { ...result, resolvedUrl: url };
      }
    } catch (httpErr) {
      console.log('[SCRAPER] HTTP method failed:', httpErr.message, '— falling back to browser');
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    var browser = null;
    try {
      console.log(`[SCRAPER] Attempt ${attempt}/3 — ${platform} — ${url.slice(0,60)}...`);
      browser = await launchBrowser();
      const page = await createStealthPage(browser);

      if (attempt > 1) {
        await page.setRequestInterception(true);
        page.on('request', req => {
          if (['image','stylesheet','font'].includes(req.resourceType())) req.abort();
          else req.continue();
        });
      }

      // Navigate with redirect handling (dl.flipkart.com → flipkart.com)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });

      // Re-detect platform from final URL (after redirect) — needed for wait logic below
      const finalUrl = page.url();
      const resolvedPlatform = detectPlatform(finalUrl) !== 'other' ? detectPlatform(finalUrl) : platform;

      // For Flipkart: extra wait because prices load via JS after DOM
      if (platform === 'flipkart' || resolvedPlatform === 'flipkart') {
        await humanDelay(3000, 4000); // let JS render prices
      } else {
        await humanDelay(1000, 2000);
      }

      // Simulate human scroll behaviour
      await page.evaluate(function() { window.scrollBy(0, 300 + Math.random() * 300); });
      await humanDelay(600, 1000);
      await page.evaluate(function() { window.scrollBy(0, 200 + Math.random() * 200); });
      await humanDelay(300, 600);

      // (resolvedPlatform and finalUrl already defined above)

      let scraped;
      if (resolvedPlatform === 'amazon')        scraped = await scrapeAmazon(page);
      else if (resolvedPlatform === 'flipkart') scraped = await scrapeFlipkart(page);
      else                                      scraped = await scrapeGeneric(page);

      // Detect captcha page in final title
      if (scraped.title && /are you a human|captcha|robot|verify you/i.test(scraped.title)) {
        throw new Error('Bot detection page returned — Flipkart blocked this request');
      }

      // Last-resort title from page meta if scraper missed it
      if (!scraped.title) {
        scraped.title = await page.evaluate(() =>
          document.querySelector('meta[property="og:title"]')?.getAttribute('content')
          || document.title
          || ''
        );
      }

      // Final captcha check on fallback title
      if (scraped.title && /are you a human|captcha|robot/i.test(scraped.title)) {
        throw new Error('Bot detection page returned — retrying');
      }

      if (!scraped.title) throw new Error('Could not extract product title');

      // Last-resort price — allow tracking at ₹0 and update later via cron
      if (!scraped.price) {
        console.warn('[SCRAPER] Price not found — saving with price=0, will update via cron');
        scraped.price = 0;
      }

      await browser.close();
      console.log(`[SCRAPER] ✅ "${scraped.title.slice(0,50)}" ₹${scraped.price}`);
      return { ...scraped, resolvedUrl: finalUrl };

    } catch (err) {
      console.error(`[SCRAPER] ❌ Attempt ${attempt} failed: ${err.message}`);
      
      try { await browser?.close(); } catch {}
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

// ─── Math Fallback Engine ─────────────────────────────────────────────────────
function movingAverage(prices, n) {
  const slice = prices.slice(-Math.min(n, prices.length));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcSlope(prices) {
  const n = prices.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (prices[i] - yMean); den += (i - xMean) ** 2; }
  return den === 0 ? 0 : num / den;
}

function calcVolatility(prices) {
  if (prices.length < 2) return 0;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / prices.length;
  return mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0;
}

function mathPrediction(product, history) {
  const prices = history.map(h => parseFloat(h.price));
  const cur = prices[prices.length - 1];
  const min = Math.min(...prices), max = Math.max(...prices);

  const ma7    = movingAverage(prices, 7);
  const ma30   = movingAverage(prices, 30);
  const slope  = calcSlope(prices);
  const volPct = calcVolatility(prices);
  const pctChg = prices.length >= 2 ? ((cur - prices[0]) / prices[0]) * 100 : 0;

  const threshold = cur * 0.002;
  const trend = slope < -threshold ? 'decreasing' : slope > threshold ? 'increasing' : 'stable';

  let dropProb = 50;
  if (trend === 'decreasing') dropProb += 20;
  if (trend === 'increasing') dropProb -= 20;
  if (cur > ma30)   dropProb += 10;
  if (cur < ma7)    dropProb += 10;
  if (volPct > 8)   dropProb += 10;
  if (pctChg > 10)  dropProb += 5;
  if (pctChg < -10) dropProb -= 10;
  dropProb = Math.max(5, Math.min(95, Math.round(dropProb)));

  const impact = slope * 30;
  const estMin = Math.round(Math.max(min * 0.95, cur + impact - (volPct * cur / 100)));
  const estMax = Math.round(Math.min(max * 1.05, cur + impact + (volPct * cur / 100)));

  const bestTimeToBuy = dropProb >= 65 ? 'Wait 1–2 weeks — drop likely soon'
    : dropProb <= 35 ? 'Good time to buy — price near historical low'
    : cur <= min * 1.05 ? 'Near all-time low — consider buying now'
    : trend === 'increasing' ? 'Buy now before price rises further'
    : 'Price is stable — buy when ready';

  const summary = [
    { decreasing: 'Price trend is decreasing 📉', increasing: 'Price is rising 📈', stable: 'Price has been stable ➡️' }[trend],
    volPct > 10 ? 'High volatility — prices change frequently.' : volPct > 5 ? 'Moderate fluctuations.' : 'Low volatility — consistent pricing.',
    cur > ma7 ? `${((cur - ma7) / ma7 * 100).toFixed(1)}% above 7-day avg — may dip.` : `${((ma7 - cur) / ma7 * 100).toFixed(1)}% below 7-day avg — relatively good deal.`,
    `7-day avg: ₹${Math.round(ma7).toLocaleString('en-IN')} | 30-day avg: ₹${Math.round(ma30).toLocaleString('en-IN')}`,
    `Range: ₹${min.toLocaleString('en-IN')} – ₹${max.toLocaleString('en-IN')}`,
    dropProb >= 60 ? '⚠️ High drop probability — consider waiting.' : dropProb <= 35 ? '✅ Near low — good buy window.' : '💡 No strong signal — monitor a few more days.',
  ].join('\n');

  return { engine: 'math', trend, dropProbability: dropProb, bestTimeToBuy,
           estimatedRange: { min: estMin, max: estMax }, summary,
           meta: { ma7: Math.round(ma7), ma30: Math.round(ma30), volatility: parseFloat(volPct.toFixed(2)) } };
}

// ─── Gemini AI Engine ─────────────────────────────────────────────────────────
async function geminiPrediction(product, history) {
  if (!geminiModel) throw new Error('Gemini not configured');

  const prices  = history.map(h => parseFloat(h.price));
  const step    = Math.max(1, Math.floor(history.length / 30));
  const series  = history.filter((_, i) => i % step === 0 || i === history.length - 1)
    .map(h => `${new Date(h.recorded_at).toLocaleDateString('en-IN')}: ₹${h.price}`).join('\n');

  const prompt = `You are a price analyst. Analyze this product's price history and respond ONLY with valid JSON (no markdown, no extra text):

Product: ${product.title}
Platform: ${product.platform}
Current: ₹${prices[prices.length-1]}
Range: ₹${Math.min(...prices)} – ₹${Math.max(...prices)}

Price History:
${series}

JSON format required:
{"trend":"decreasing"|"increasing"|"stable","dropProbability":<0-100>,"bestTimeToBuy":"<string>","estimatedRange":{"min":<number>,"max":<number>},"summary":"<3-5 sentences>","keyInsights":["<string>","<string>","<string>"]}`;

  const result  = await geminiModel.generateContent(prompt);
  const raw     = result.response.text().trim().replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  const parsed  = JSON.parse(raw);

  if (!parsed.trend || typeof parsed.dropProbability !== 'number') throw new Error('Incomplete Gemini response');

  return { engine: 'gemini', trend: parsed.trend,
           dropProbability: Math.max(0, Math.min(100, Math.round(parsed.dropProbability))),
           bestTimeToBuy: parsed.bestTimeToBuy || '', estimatedRange: parsed.estimatedRange,
           summary: parsed.summary || '', keyInsights: parsed.keyInsights || [] };
}

// ─── Main prediction (tries Gemini, falls back to math) ───────────────────────
async function generatePrediction(product, history) {
  if (!history?.length || history.length < 2) {
    return { engine: 'math', trend: 'stable', dropProbability: 50,
             bestTimeToBuy: 'Need more data — check back in 24 hours',
             estimatedRange: null, summary: 'Not enough history yet. Keep tracking!' };
  }
  if (geminiModel) {
    try {
      console.log('[GEMINI] Requesting prediction...');
      const result = await Promise.race([
        geminiPrediction(product, history),
        new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 15000)),
      ]);
      console.log('[GEMINI] ✅ AI prediction done');
      return result;
    } catch (err) {
      console.warn(`[GEMINI] ⚠️ Failed (${err.message}) — switching to math engine`);
    }
  }
  console.log('[MATH] Using mathematical prediction engine');
  return mathPrediction(product, history);
}

// ════════════════════════════════════════════════════════════════════════════
//
//  ███████╗███╗   ███╗ █████╗ ██╗██╗
//  ██╔════╝████╗ ████║██╔══██╗██║██║
//  █████╗  ██╔████╔██║███████║██║██║
//  ██╔══╝  ██║╚██╔╝██║██╔══██║██║██║
//  ███████╗██║ ╚═╝ ██║██║  ██║██║███████╗
//  ╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝  (email)
//
// ════════════════════════════════════════════════════════════════════════════

function isBrevoConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

function brevoHeaders() {
  return { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' };
}

// ─── Welcome / confirmation email ────────────────────────────────────────────
async function sendWelcomeEmail(opts) {
  if (!isBrevoConfigured()) {
    console.warn('[EMAIL] Brevo not configured. Set BREVO_API_KEY and BREVO_SENDER_EMAIL in Render environment.');
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
  var productUrl    = opts.productUrl || buyUrl;

  var INR   = function(n) { return 'Rs.' + Number(n).toLocaleString('en-IN'); };
  var APP   = process.env.FRONTEND_URL || 'https://pricehawk.onrender.com';
  var SITE  = APP.replace('https://','').replace('http://','');

  var savingPct = (originalPrice && originalPrice > currentPrice)
    ? ((originalPrice - currentPrice) / originalPrice * 100).toFixed(0) : null;

  var alertMsg = targetPrice
    ? 'Price Alert Set: ' + INR(targetPrice) + ' - We will email you the moment the price reaches your target.'
    : 'Auto-Monitoring Active - We will alert you on any significant price drop from the original price.';

  var html = '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Tracking Started - PriceHawk</title></head>' +
    '<body style="margin:0;padding:0;background:#060b14;font-family:Segoe UI,Arial,sans-serif">' +
    '<div style="max-width:580px;margin:0 auto">' +

    // Header
    '<div style="background:linear-gradient(135deg,#0f1f3d,#1a0933);padding:32px 24px;text-align:center;border-bottom:1px solid rgba(6,182,212,0.2)">' +
    '<div style="display:inline-block;background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.3);border-radius:12px;padding:8px 20px;margin-bottom:18px">' +
    '<span style="font-size:20px;font-weight:900;color:#67e8f9">&#129413; PriceHawk</span>' +
    '</div>' +
    '<h1 style="margin:0 0 8px;color:#f0f6ff;font-size:26px;font-weight:800">&#9989; You Are Now Tracking!</h1>' +
    '<p style="margin:0;color:#94a3b8;font-size:15px">Price monitoring has started - we have got you covered.</p>' +
    '</div>' +

    // Product card
    '<div style="margin:24px 16px 0;background:#0a1628;border:1px solid rgba(100,200,255,0.12);border-radius:16px;padding:20px">' +
    '<div style="display:flex;gap:16px;align-items:flex-start">' +
    (productImage
      ? '<img src="' + productImage + '" width="100" height="100" style="border-radius:10px;object-fit:cover;flex-shrink:0;background:#162848">'
      : '<div style="width:100px;height:100px;background:#162848;border-radius:10px;text-align:center;line-height:100px;font-size:36px;flex-shrink:0">&#128230;</div>') +
    '<div style="flex:1;min-width:0">' +
    '<p style="margin:0 0 4px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600">via ' + platform.toUpperCase() + '</p>' +
    '<p style="margin:0 0 10px;color:#e2e8f0;font-size:14px;font-weight:600;line-height:1.5">' + productTitle.slice(0,100) + (productTitle.length > 100 ? '...' : '') + '</p>' +
    '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">' +
    '<span style="font-size:26px;font-weight:900;color:#22d3ee">' + INR(currentPrice) + '</span>' +
    (originalPrice && originalPrice > currentPrice
      ? '<span style="font-size:13px;color:#64748b;text-decoration:line-through">' + INR(originalPrice) + '</span>' +
        '<span style="font-size:12px;font-weight:700;color:#4ade80;background:rgba(74,222,128,0.1);padding:2px 8px;border-radius:20px">&#8595; ' + savingPct + '% off</span>'
      : '') +
    '</div>' +
    '</div></div>' +
    '</div>' +

    // Alert status
    '<div style="margin:12px 16px 0;background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.25);border-radius:12px;padding:14px 18px">' +
    '<p style="margin:0;font-size:13px;color:#e2e8f0;line-height:1.6">' +
    '<strong style="color:#22d3ee">&#128276; Tracking Status:</strong> ' + alertMsg +
    '</p></div>' +

    // What happens next
    '<div style="margin:16px 16px 0;background:#0a1628;border:1px solid rgba(100,200,255,0.08);border-radius:16px;padding:20px">' +
    '<p style="margin:0 0 14px;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px">What Happens Next</p>' +
    '<table width="100%" cellpadding="0" cellspacing="0">' +
    '<tr><td width="32" style="vertical-align:top;padding-bottom:12px;font-size:18px">&#128260;</td>' +
    '<td style="vertical-align:top;padding-bottom:12px"><strong style="color:#f1f5f9;font-size:13px">Price checked every 90 minutes</strong><br>' +
    '<span style="color:#64748b;font-size:12px">We scrape the live price automatically - no action needed.</span></td></tr>' +
    '<tr><td width="32" style="vertical-align:top;padding-bottom:12px;font-size:18px">&#9889;</td>' +
    '<td style="vertical-align:top;padding-bottom:12px"><strong style="color:#f1f5f9;font-size:13px">Instant email alert on price drop</strong><br>' +
    '<span style="color:#64748b;font-size:12px">You will be the first to know when the price falls.</span></td></tr>' +
    '<tr><td width="32" style="vertical-align:top;font-size:18px">&#129504;</td>' +
    '<td style="vertical-align:top"><strong style="color:#f1f5f9;font-size:13px">AI-powered price prediction</strong><br>' +
    '<span style="color:#64748b;font-size:12px">Our AI analyses history to predict if price will go UP or DOWN.</span></td></tr>' +
    '</table></div>' +

    // Tracked URL
    '<div style="margin:14px 16px 0;background:#060b14;border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:14px 18px">' +
    '<p style="margin:0 0 6px;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.8px;font-weight:600">Tracked Product URL</p>' +
    '<a href="' + productUrl + '" style="font-size:12px;color:#67e8f9;text-decoration:none;word-break:break-all">' +
    (productUrl.length > 80 ? productUrl.slice(0,80) + '...' : productUrl) + '</a>' +
    '</div>' +

    // CTA buttons
    '<div style="margin:16px 16px 0;display:flex;gap:10px">' +
    '<a href="' + APP + '" style="flex:1;display:block;background:linear-gradient(135deg,#0891b2,#4f46e5);color:#fff;text-decoration:none;padding:13px 10px;border-radius:10px;font-size:14px;font-weight:700;text-align:center">&#128202; View Dashboard</a>' +
    '<a href="' + buyUrl + '" style="flex:1;display:block;background:linear-gradient(135deg,#f97316,#ef4444);color:#fff;text-decoration:none;padding:13px 10px;border-radius:10px;font-size:14px;font-weight:700;text-align:center">&#128722; Buy Now</a>' +
    '</div>' +

    // Thank you section
    '<div style="margin:16px 16px 0;text-align:center;padding:28px 20px;background:linear-gradient(135deg,rgba(6,182,212,0.05),rgba(79,70,229,0.05));border-radius:16px;border:1px solid rgba(6,182,212,0.12)">' +
    '<p style="margin:0 0 10px;font-size:28px">&#128075;</p>' +
    '<p style="margin:0 0 8px;font-size:20px;font-weight:800;color:#f0f6ff">Thank You for Choosing PriceHawk!</p>' +
    '<p style="margin:0 0 18px;font-size:13px;color:#64748b;line-height:1.7">We will check this product every 90 minutes and send you an instant<br>email the moment the price drops. Never miss a deal again.</p>' +
    '<a href="' + APP + '" style="display:inline-block;background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.35);color:#22d3ee;text-decoration:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:700">Open My Dashboard &#8594;</a>' +
    '</div>' +

    // Footer
    '<div style="margin:12px 16px 24px;text-align:center">' +
    '<p style="margin:0;font-size:11px;color:#334155">' +
    '<a href="' + APP + '" style="color:#22d3ee;text-decoration:none">' + SITE + '</a>' +
    ' &nbsp;&mdash;&nbsp; PriceHawk Smart Price Intelligence' +
    '</p></div>' +

    '</div></body></html>';

  try {
    var resp = await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: process.env.BREVO_SENDER_NAME || 'PriceHawk', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: 'Tracking Started: ' + productTitle.slice(0,55) + (productTitle.length > 55 ? '...' : '') + ' | PriceHawk',
      htmlContent: html,
      textContent: [
        'Hi! PriceHawk is now tracking your product.',
        '',
        'Product: ' + productTitle,
        'Platform: ' + platform,
        'Current Price: ' + INR(currentPrice),
        targetPrice ? 'Alert set for: ' + INR(targetPrice) : 'Auto-monitoring: ON',
        '',
        'Tracked URL: ' + productUrl,
        '',
        'We will email you immediately when the price drops.',
        '',
        'View your dashboard: ' + APP,
        '',
        'Thank you for choosing PriceHawk!',
        SITE + ' | Smart Price Intelligence',
      ].join('\n'),
    }, { headers: brevoHeaders(), timeout: 15000 });
    console.log('[EMAIL] Welcome email sent to ' + toEmail + ' - ID: ' + resp.data.messageId);
  } catch (emailErr) {
    var errMsg = emailErr.response ? JSON.stringify(emailErr.response.data) : emailErr.message;
    console.error('[EMAIL] Welcome email FAILED:', errMsg);
    throw new Error('Email failed: ' + errMsg);
  }
}

async function sendAlertEmail({ toEmail, productTitle, productImage, platform,
  newPrice, oldPrice, buyUrl, targetPrice, priceType }) {

  if (!process.env.BREVO_API_KEY || process.env.BREVO_API_KEY.startsWith('xkeysib-xxx')) {
    console.warn('[EMAIL] BREVO_API_KEY not configured — skipping alert email');
    return;
  }

  const fmt          = n => `₹${Number(n).toLocaleString('en-IN')}`;
  const APP          = (process.env.FRONTEND_URL || 'https://pricehawk.onrender.com');
  const isDropAlert  = priceType === 'drop';
  const isRiseWarn   = priceType === 'rise';
  const dropPct      = oldPrice > 0 ? Math.abs((oldPrice - newPrice) / oldPrice) * 100 : 0;
  const savingAmount = Math.abs(oldPrice - newPrice);

  const subjectLine = isDropAlert
    ? `🔥 Price Drop! ${productTitle.slice(0,40)}… now ${fmt(newPrice)}`
    : `⚠️ Price Increased — ${productTitle.slice(0,40)}… now ${fmt(newPrice)}`;

  const headerColor  = isDropAlert ? '#16a34a' : '#dc2626';
  const headerEmoji  = isDropAlert ? '🔥' : '⚠️';
  const headerTitle  = isDropAlert ? 'Price Drop Alert!' : 'Price Increase Warning';
  const headerSub    = isDropAlert ? `Good news — price dropped on ${platform}!`
                                   : `Heads up — price has risen on ${platform}`;

  const priceBlock = isDropAlert
    ? `<div style="background:linear-gradient(135deg,#052e16,#14532d);
               border:1px solid rgba(74,222,128,0.3);border-radius:16px;
               padding:24px;text-align:center;margin-bottom:20px">
         <p style="margin:0 0 6px;color:#86efac;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-weight:600">🔥 NEW PRICE</p>
         <p style="margin:0 0 4px;font-size:40px;font-weight:900;color:#4ade80;letter-spacing:-1px">${fmt(newPrice)}</p>
         <p style="margin:0 0 14px;color:#86efac;font-size:14px;text-decoration:line-through;opacity:0.8">was ${fmt(oldPrice)}</p>
         <div style="display:inline-flex;gap:10px;flex-wrap:wrap;justify-content:center">
           <span style="background:#16a34a;color:#fff;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700">↓ ${dropPct.toFixed(1)}% OFF</span>
           <span style="background:#065f46;color:#6ee7b7;padding:5px 14px;border-radius:20px;font-size:13px">Save ${fmt(savingAmount)}</span>
           ${targetPrice ? `<span style="background:#1e3a5f;color:#67e8f9;padding:5px 14px;border-radius:20px;font-size:13px">Target: ${fmt(targetPrice)}</span>` : ''}
         </div>
       </div>`
    : `<div style="background:linear-gradient(135deg,#450a0a,#7f1d1d);
               border:1px solid rgba(248,113,113,0.3);border-radius:16px;
               padding:24px;text-align:center;margin-bottom:20px">
         <p style="margin:0 0 6px;color:#fca5a5;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-weight:600">⚠️ PRICE INCREASED</p>
         <p style="margin:0 0 4px;font-size:40px;font-weight:900;color:#f87171;letter-spacing:-1px">${fmt(newPrice)}</p>
         <p style="margin:0 0 14px;color:#fca5a5;font-size:14px;text-decoration:line-through;opacity:0.8">was ${fmt(oldPrice)}</p>
         <span style="background:#991b1b;color:#fff;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700">↑ ${dropPct.toFixed(1)}% INCREASE</span>
       </div>
       <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);
                   border-radius:10px;padding:14px;margin-bottom:16px;font-size:13px;color:#fca5a5">
         💡 If you still want this product, you may want to buy now before further increases.
       </div>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${headerTitle} — PriceHawk</title></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',system-ui,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="text-align:center;padding:24px 0 18px">
    <div style="display:inline-block;background:linear-gradient(135deg,#1e3a5f,#2d1b69);
                border:1px solid rgba(100,200,255,0.2);border-radius:14px;padding:9px 22px;margin-bottom:14px">
      <span style="font-size:17px;font-weight:800;background:linear-gradient(90deg,#67e8f9,#a78bfa);
                   -webkit-background-clip:text;-webkit-text-fill-color:transparent">🦅 PriceHawk</span>
    </div>
    <h1 style="color:#f0f6ff;font-size:24px;font-weight:800;margin:0 0 4px">${headerEmoji} ${headerTitle}</h1>
    <p style="color:#94a3b8;margin:0;font-size:14px">${headerSub}</p>
  </div>
  <div style="background:#131a25;border:1px solid rgba(100,200,255,0.15);border-radius:16px;padding:18px;margin-bottom:16px">
    <div style="display:flex;gap:14px;align-items:flex-start">
      ${productImage
        ? `<img src="${productImage}" width="76" height="76" style="border-radius:9px;object-fit:cover;background:#1e293b;flex-shrink:0">`
        : `<div style="width:76px;height:76px;background:#1e293b;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">📦</div>`}
      <div>
        <p style="margin:0 0 5px;color:#cbd5e1;font-size:11px;text-transform:uppercase;letter-spacing:1px">via ${platform}</p>
        <p style="margin:0;color:#f1f5f9;font-size:14px;font-weight:600;line-height:1.4">${productTitle.slice(0,90)}${productTitle.length>90?'…':''}</p>
      </div>
    </div>
  </div>
  ${priceBlock}
  <div style="text-align:center;margin-bottom:20px">
    <a href="${buyUrl}" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ef4444);
               color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;
               font-size:16px;font-weight:800">
      🛒 Buy Now on ${platform} →
    </a>
  </div>
  <div style="text-align:center;padding:14px 0;border-top:1px solid rgba(255,255,255,0.06)">
    <p style="margin:0 0 6px;font-size:13px;color:#475569">
      <a href="${APP}" style="color:#67e8f9;text-decoration:none">Dashboard</a>
      &nbsp;·&nbsp;
      <a href="${APP}/alerts" style="color:#67e8f9;text-decoration:none">Manage Alerts</a>
    </p>
    <p style="margin:0;font-size:12px;color:#334155">Prices may change. Verify on the retailer's site.</p>
  </div>
</div></body></html>`;

  const res = await axios.post('https://api.brevo.com/v3/smtp/email', {
    sender: { name: process.env.BREVO_SENDER_NAME, email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: toEmail }],
    subject: subjectLine,
    htmlContent: html,
    textContent: `${headerTitle}\n\n${productTitle}\n\nNew: ${fmt(newPrice)} | Was: ${fmt(oldPrice)}\n${isDropAlert ? `Save: ${fmt(savingAmount)} (${dropPct.toFixed(1)}% off)` : `Increase: ${dropPct.toFixed(1)}%`}\n\nBuy: ${buyUrl}`,
  }, { headers: brevoHeaders(), timeout: 10000 });

  console.log(`[EMAIL] ✅ ${isDropAlert ? 'Drop alert' : 'Rise warning'} sent to ${toEmail} — ID: ${res.data.messageId}`);
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

const app = express();
app.set('trust proxy', 1); // Required for Render — behind a load balancer

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const globalLimit = rateLimit({ windowMs: 60_000, max: 100 });
const trackLimit  = rateLimit({ windowMs: 60_000, max: 5,
  message: { error: 'Slow down — max 5 track requests per minute.' } });
app.use(globalLimit);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── TRACK PRODUCT ────────────────────────────────────────────────────────────
app.post('/api/products/track', trackLimit, async (req, res) => {
  const { rawInput, email, targetPrice } = req.body;

  if (!rawInput) return respond(res, 400, { error: 'Please provide a product URL or share text.' });

  // ── Extract clean URL from any messy input ─────────────────────────────────
  const url = extractUrlFromInput(rawInput);
  if (!url) return respond(res, 400, { error: 'No valid URL found in your input. Please paste the product URL directly.' });
  if (!isDomainAllowed(url)) return respond(res, 400, { error: `"${new URL(url).hostname}" is not a supported website yet.` });

  const platform = detectPlatform(url);

  // ── Scrape ─────────────────────────────────────────────────────────────────
  let scraped;
  try {
    scraped = await scrapeProduct(url, platform);
  } catch (err) {
    console.error('[TRACK] Scrape failed:', err.message);
    return respond(res, 502, { error: 'Could not fetch product details. Check the URL and try again.' });
  }

  const resolvedUrl  = scraped.resolvedUrl || url;
  const slug         = makeSlug(scraped.title);
  const affiliateUrl = buildAffiliateUrl(resolvedUrl, platform);

  // ── Upsert user ────────────────────────────────────────────────────────────
  const userEmail = email || 'anonymous@pricehawk.in';
  let userId;
  {
    let { data: existing } = await supabase.from('users').select('id').eq('email', userEmail).single();
    if (!existing) {
      const { data: created } = await supabase.from('users').insert({ email: userEmail }).select('id').single();
      userId = created?.id;
    } else {
      userId = existing.id;
    }
  }

  // ── Save product ───────────────────────────────────────────────────────────
  const { data: product, error: pErr } = await supabase.from('products').insert({
    user_id:        userId,
    slug,
    title:          scraped.title,
    brand:          scraped.brand,
    model_number:   scraped.modelNumber,
    image_url:      scraped.imageUrl,
    category:       scraped.category,
    source_url:     resolvedUrl,
    platform,
    current_price:  scraped.price,
    original_price: scraped.originalPrice || scraped.price,
    in_stock:       scraped.inStock,
    affiliate_url:  affiliateUrl,
    last_scraped:   new Date().toISOString(),
  }).select().single();

  if (pErr) { console.error('[TRACK] DB error:', pErr.message); return respond(res, 500, { error: 'Database error. Please try again.' }); }

  // ── Seed price history ─────────────────────────────────────────────────────
  await supabase.from('price_history').insert({ product_id: product.id, price: scraped.price, in_stock: scraped.inStock, source: 'scraper' });

  // ── Create tracking job ────────────────────────────────────────────────────
  await supabase.from('tracking_jobs').insert({ product_id: product.id, status: 'pending', next_run: new Date(Date.now() + 2 * 3600 * 1000).toISOString() });

  // ── Create alert ───────────────────────────────────────────────────────────
  // If user gave a target price → specific alert
  // If user gave email but NO target price → auto-alert on any drop from original
  const effectiveTarget = targetPrice ? Number(targetPrice)
    : (email && scraped.originalPrice ? scraped.originalPrice : null);  // auto-track at original price

  if (effectiveTarget && email) {
    await supabase.from('alerts').insert({
      user_id:      userId,
      product_id:   product.id,
      email,
      target_price: effectiveTarget,
      is_auto: !targetPrice,
    });
  }

  // ── Price sanity warnings ──────────────────────────────────────────────────
  let priceWarning = null;
  if (scraped.originalPrice && scraped.price > scraped.originalPrice * 1.05) {
    priceWarning = `⚠️ Current price (₹${scraped.price.toLocaleString('en-IN')}) is higher than the listed original price (₹${scraped.originalPrice.toLocaleString('en-IN')}). This can happen during peak demand or flash sales. We'll alert you when it drops.`;
  } else if (scraped.originalPrice && scraped.price < scraped.originalPrice * 0.5) {
    priceWarning = `💡 This product is currently at ${(((scraped.originalPrice - scraped.price) / scraped.originalPrice) * 100).toFixed(0)}% below its original listed price. Looks like a great deal!`;
  }

  // ── Send welcome email ─────────────────────────────────────────────────────
  if (email) {
    sendWelcomeEmail({
      toEmail:       email,
      productTitle:  scraped.title,
      productImage:  scraped.imageUrl,
      platform,
      currentPrice:  scraped.price,
      originalPrice: scraped.originalPrice,
      targetPrice:   targetPrice ? Number(targetPrice) : null,
      buyUrl:        `${(process.env.FRONTEND_URL || 'https://pricehawk.onrender.com')}/go/${product.id}`,
      productId:     product.id,
    }).catch(err => console.error('[EMAIL] Welcome email failed:', err.message));
  }

  respond(res, 201, {
    success:      true,
    message:      'Tracking started from today! 🎯',
    extractedUrl: url !== rawInput.trim() ? url : null,  // tell frontend if URL was extracted
    priceWarning,
    product: {
      ...product,
      autoAlertSet: !targetPrice && !!email && !!scraped.originalPrice,
    },
    scraped,
  });
});

// ─── GET PRODUCTS ─────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const { email } = req.query;
  if (!email) return respond(res, 400, { error: 'email query required' });
  const { data: user } = await supabase.from('users').select('id').eq('email', email).single();
  if (!user) return respond(res, 200, []);
  const { data, error } = await supabase.from('products').select('*').eq('user_id', user.id).eq('is_active', true).order('created_at', { ascending: false });
  if (error) return respond(res, 500, { error: error.message });
  respond(res, 200, data);
});

// ─── GET SINGLE PRODUCT ───────────────────────────────────────────────────────
app.get('/api/products/:id', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('id', req.params.id).single();
  if (error || !data) return respond(res, 404, { error: 'Product not found.' });
  respond(res, 200, data);
});

// ─── PRICE HISTORY ────────────────────────────────────────────────────────────
app.get('/api/products/:id/history', async (req, res) => {
  const { days = 30 } = req.query;
  const since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
  const { data, error } = await supabase.from('price_history').select('price, in_stock, recorded_at').eq('product_id', req.params.id).gte('recorded_at', since).order('recorded_at', { ascending: true });
  if (error) return respond(res, 500, { error: error.message });
  respond(res, 200, data);
});

// ─── AI PREDICTION ────────────────────────────────────────────────────────────
app.get('/api/products/:id/predict', async (req, res) => {
  const { data: history } = await supabase.from('price_history').select('price, recorded_at').eq('product_id', req.params.id).order('recorded_at', { ascending: false }).limit(60);
  const { data: product } = await supabase.from('products').select('title, platform, current_price').eq('id', req.params.id).single();
  if (!history?.length) return respond(res, 400, { error: 'Not enough price data yet.' });
  const prediction = await generatePrediction(product, history.reverse());
  await supabase.from('predictions').insert({ product_id: req.params.id, engine: prediction.engine, trend: prediction.trend, drop_prob: prediction.dropProbability, best_time: prediction.bestTimeToBuy, min_estimate: prediction.estimatedRange?.min, max_estimate: prediction.estimatedRange?.max, summary: prediction.summary });
  respond(res, 200, prediction);
});

// ─── SET ALERT ────────────────────────────────────────────────────────────────
app.post('/api/alerts', async (req, res) => {
  const { productId, email, targetPrice } = req.body;
  if (!productId || !email || !targetPrice) return respond(res, 400, { error: 'productId, email, and targetPrice are required.' });
  let { data: user } = await supabase.from('users').select('id').eq('email', email).single();
  if (!user) { const { data: n } = await supabase.from('users').insert({ email }).select('id').single(); user = n; }
  const { data, error } = await supabase.from('alerts').insert({ user_id: user.id, product_id: productId, email, target_price: Number(targetPrice) }).select().single();
  if (error) return respond(res, 500, { error: error.message });
  respond(res, 201, { success: true, alert: data });
});

// ─── DELETE PRODUCT ───────────────────────────────────────────────────────────
app.delete('/api/products/:id', async (req, res) => {
  await supabase.from('products').update({ is_active: false }).eq('id', req.params.id);
  respond(res, 200, { success: true });
});

// ─── AFFILIATE REDIRECT ───────────────────────────────────────────────────────
app.get('/go/:id', async (req, res) => {
  const { data } = await supabase.from('products').select('affiliate_url, source_url, platform').eq('id', req.params.id).single();
  if (!data) return res.redirect('/');
  const ip = req.ip || req.headers['x-forwarded-for'] || '';
  await supabase.from('click_logs').insert({ product_id: req.params.id, platform: data.platform, ip_hash: crypto.createHash('sha256').update(ip).digest('hex') });
  res.redirect(data.affiliate_url || data.source_url);
});

// ─── TOP DEALS ────────────────────────────────────────────────────────────────
app.get('/api/deals', async (req, res) => {
  const { data, error } = await supabase.from('top_deals').select('*').limit(20);
  if (error) return respond(res, 500, { error: error.message });
  respond(res, 200, data);
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ════════════════════════════════════════════════════════════════════════════
//
//  ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗███████╗██████╗
//  ██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝██╔════╝██╔══██╗
//  ██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗  ██████╔╝
//  ██║███╗██║██║   ██║██╔══██╗██╔═██╗ ██╔══╝  ██╔══██╗
//  ╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗███████╗██║  ██║
//   ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
//
// ════════════════════════════════════════════════════════════════════════════

let runningJobs = 0;
const MAX_CONCURRENT = 3;

async function checkAlerts(product, newPrice, oldPrice) {
  const originalPrice = parseFloat(product.original_price || 0);
  const priceDropped  = newPrice < oldPrice;
  const priceRose     = newPrice > oldPrice;

  // ── 1. User-set target-price alerts (price dropped to/below target) ─────────
  if (priceDropped) {
    const { data: targetAlerts } = await supabase
      .from('alerts').select('*')
      .eq('product_id', product.id)
      .eq('is_active', true)
      .eq('is_auto', false)                  // only explicit user-set alerts
      .lte('target_price', newPrice);

    for (const alert of targetAlerts || []) {
      try {
        await sendAlertEmail({
          toEmail: alert.email, productTitle: product.title,
          productImage: product.image_url, platform: product.platform,
          newPrice, oldPrice, originalPrice,
          buyUrl: `${(process.env.FRONTEND_URL || 'https://pricehawk.onrender.com')}/go/${product.id}`,
          targetPrice: alert.target_price, priceType: 'drop',
        });
        await supabase.from('alerts')
          .update({ is_active: false, triggered_at: new Date().toISOString(), trigger_count: (alert.trigger_count||0)+1 })
          .eq('id', alert.id);
        console.log(`[ALERT] ✅ Drop alert sent to ${alert.email} (target ₹${alert.target_price})`);
      } catch (err) { console.error('[ALERT] Drop send failed:', err.message); }
    }
  }

  // ── 2. Auto-monitoring alerts (no target set — monitor from original price) ─
  //    These are created with notes='auto'. Fire when:
  //    a) Price drops below original price → good news, notify!
  //    b) Price rises significantly above original (>5%) → warning!
  const { data: autoAlerts } = await supabase
    .from('alerts').select('*')
    .eq('product_id', product.id)
    .eq('is_active', true)
    .eq('is_auto', true);

  for (const alert of autoAlerts || []) {
    try {
      // Case A: price is now BELOW original → notify as a drop
      if (originalPrice > 0 && newPrice < originalPrice && priceDropped) {
        await sendAlertEmail({
          toEmail: alert.email, productTitle: product.title,
          productImage: product.image_url, platform: product.platform,
          newPrice, oldPrice, originalPrice,
          buyUrl: `${(process.env.FRONTEND_URL || 'https://pricehawk.onrender.com')}/go/${product.id}`,
          targetPrice: null, priceType: 'drop',
        });
        await supabase.from('alerts')
          .update({ is_active: false, triggered_at: new Date().toISOString(), trigger_count: (alert.trigger_count||0)+1 })
          .eq('id', alert.id);
        console.log(`[ALERT] ✅ Auto drop alert sent to ${alert.email} (₹${oldPrice} → ₹${newPrice})`);
      }
      // Case B: price rose MORE than 5% above original → send warning
      else if (originalPrice > 0 && newPrice > originalPrice * 1.05 && priceRose) {
        await sendAlertEmail({
          toEmail: alert.email, productTitle: product.title,
          productImage: product.image_url, platform: product.platform,
          newPrice, oldPrice, originalPrice,
          buyUrl: `${(process.env.FRONTEND_URL || 'https://pricehawk.onrender.com')}/go/${product.id}`,
          targetPrice: null, priceType: 'rise',
        });
        // Do NOT deactivate rise warnings — user may want future drop alerts too
        console.log(`[ALERT] ⚠️  Rise warning sent to ${alert.email} (₹${oldPrice} → ₹${newPrice})`);
      }
    } catch (err) { console.error('[ALERT] Auto-alert failed:', err.message); }
  }
}

async function processJob(job) {
  const product = job.products;
  if (!product) return;
  await supabase.from('tracking_jobs').update({ status: 'running' }).eq('id', job.id);
  try {
    const scraped  = await scrapeProduct(product.source_url, product.platform);
    const newPrice = parseFloat(scraped.price);
    const oldPrice = parseFloat(product.current_price || 0);

    await supabase.from('products').update({ current_price: newPrice, original_price: scraped.originalPrice || product.original_price, in_stock: scraped.inStock, last_scraped: new Date().toISOString() }).eq('id', product.id);
    await supabase.from('price_history').insert({ product_id: product.id, price: newPrice, in_stock: scraped.inStock, source: 'scraper' });
    await checkAlerts(product, newPrice, oldPrice);
    await supabase.from('tracking_jobs').update({ status: 'done', last_run: new Date().toISOString(), next_run: new Date(Date.now() + 90 * 60 * 1000).toISOString(), retry_count: 0, error_log: null }).eq('id', job.id);
    console.log(`[WORKER] ✅ ${product.title?.slice(0,40)} — ₹${oldPrice} → ₹${newPrice}`);
  } catch (err) {
    const retries = (job.retry_count||0) + 1;
    await supabase.from('tracking_jobs').update({ status: retries >= 5 ? 'failed' : 'pending', retry_count: retries, last_run: new Date().toISOString(), next_run: new Date(Date.now() + Math.min(retries * 30 * 60 * 1000, 4 * 3600 * 1000)).toISOString(), error_log: err.message }).eq('id', job.id);
    console.error(`[WORKER] ❌ ${product.title?.slice(0,40)} — ${err.message}`);
  }
}

async function runPriceUpdates() {
  console.log('\n[WORKER] ── Price update cycle ──────────────────────────────');
  const { data: jobs, error } = await supabase.from('tracking_jobs')
    .select(`id, product_id, retry_count, products(id, title, source_url, platform, current_price, original_price, affiliate_url, image_url)`)
    .in('status', ['pending','failed'])
    .lte('next_run', new Date().toISOString())
    .order('next_run', { ascending: true })
    .limit(20);

  if (error) { console.error('[WORKER] Fetch jobs error:', error.message); return; }
  if (!jobs?.length) { console.log('[WORKER] No jobs due ✅'); return; }

  console.log(`[WORKER] ${jobs.length} job(s) to process`);
  for (const job of jobs) {
    while (runningJobs >= MAX_CONCURRENT) await sleep(2000);
    runningJobs++;
    processJob(job).finally(() => runningJobs--);
    await sleep(1500 + Math.random() * 1000);
  }
}

async function archiveInactive() {
  const { data } = await supabase.from('products').select('id').eq('is_active', true).lt('last_scraped', new Date(Date.now() - 30 * 86_400_000).toISOString());
  if (data?.length) {
    await supabase.from('products').update({ is_active: false }).in('id', data.map(p => p.id));
    console.log(`[WORKER] Archived ${data.length} inactive products`);
  }
}

// Cron schedule
cron.schedule('*/90 * * * *', () => runPriceUpdates().catch(console.error));
cron.schedule('0 * * * *',    () => supabase.rpc('refresh_top_deals').then(() => console.log('[CRON] Deals refreshed')).catch(console.error));
cron.schedule('0 3 * * *',    () => archiveInactive().catch(console.error));

// ════════════════════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   🦅  PriceHawk is running!                      ║
║   http://localhost:${PORT}                         ║
╚══════════════════════════════════════════════════╝

  Supabase : ${process.env.SUPABASE_URL ? '✅ Connected' : '❌ SUPABASE_URL not set'}
  Gemini   : ${geminiModel ? '✅ gemini-2.5-flash' : '⚠️  Not set — math engine active'}
  Email    : ${(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) ? '✅ Brevo — ' + process.env.BREVO_SENDER_EMAIL : '❌ BREVO_API_KEY or BREVO_SENDER_EMAIL not set'}
  Chrome   : ✅ puppeteer (auto-installs Chrome)
  Cron     : ✅ Price checks every 90 minutes
  `);
  // Run one update cycle on startup
  // Auto-install Chrome if not present (handles Render cold starts)
  var fs = require('fs');
  var cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
  var chromeFound = false;
  try {
    var found = require('child_process').execSync(
      'find ' + cacheDir + ' -name "chrome" -type f 2>/dev/null | head -1'
    ).toString().trim();
    chromeFound = !!found;
  } catch(e) {}

  if (!chromeFound) {
    console.log('[STARTUP] Chrome not found — installing via puppeteer...');
    try {
      require('child_process').execSync('npx puppeteer browsers install chrome', {
        stdio: 'inherit', timeout: 120000,
        env: Object.assign({}, process.env, { PUPPETEER_CACHE_DIR: cacheDir }),
      });
      console.log('[STARTUP] ✅ Chrome installed');
    } catch (installErr) {
      console.error('[STARTUP] Chrome install failed:', installErr.message);
    }
  } else {
    console.log('[STARTUP] ✅ Chrome found at cache');
  }

  runPriceUpdates().catch(console.error);
});

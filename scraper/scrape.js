import fs from "fs"; // Import modul bawaan Node.js untuk baca/tulis file
import path from "path"; // Import modul path untuk mengatur path folder/file
import crypto from "crypto"; // Import crypto untuk membuat hash SHA256
import puppeteer from "puppeteer-extra"; // Import puppeteer-extra (versi puppeteer dengan plugin)
import StealthPlugin from "puppeteer-extra-plugin-stealth"; // Import plugin stealth agar tidak terdeteksi sebagai bot

puppeteer.use(StealthPlugin()); // Aktifkan plugin stealth

// Konfigurasi Browser
const USE_HEADLESS = true; // true = browser tidak terlihat (production), false = browser terlihat (debugging)
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; // Path Chrome di macOS

// URL utama website target dan batas tanggal pencarian
const BASE_URL = "https://kliping.jogjakota.go.id/frontend"; 
const DATE_FROM = "2024-01-01"; 
const DATE_TO = "2025-12-31"; 
const STEP = 9; // Jumlah data per halaman
const MAX_PAGES = 1; // Jumlah maksimum halaman yang akan discan

// Konfigurasi Retry System
const MAX_RETRIES = 5; // Maksimal retry per operasi (ditingkatkan untuk koneksi tidak stabil)
const RETRY_DELAY = 3000; // Delay 3 detik sebelum retry
const PAGE_TIMEOUT = 90000; // Timeout 90 detik untuk load halaman (ditingkatkan)
const NAVIGATION_TIMEOUT = 90000; // Timeout khusus untuk navigasi

const OUT = path.resolve("output");
const IMG_DIR = path.join(OUT, "images");
const CHECKPOINT_FILE = path.join(OUT, "checkpoint.json");
fs.mkdirSync(IMG_DIR, { recursive: true }); // Buat folder jika belum ada

const sleep = ms => new Promise(r => setTimeout(r, ms)); // Fungsi delay / sleep

// Fungsi retry wrapper untuk operasi yang bisa gagal
async function retryOperation(operation, operationName, maxRetries = MAX_RETRIES) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isNetworkError = 
        error.message.includes('net::ERR') ||
        error.message.includes('Navigation') ||
        error.message.includes('timeout') ||
        error.message.includes('disconnected') ||
        error.message.includes('Protocol error') ||
        error.message.includes('socket hang up') ||
        error.message.includes('ECONNRESET') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ENOTFOUND') ||
        error.message.includes('Target closed');
      
      if (isNetworkError && attempt < maxRetries) {
        const waitTime = RETRY_DELAY * attempt; // Exponential backoff
        console.log(`${operationName} gagal (attempt ${attempt}/${maxRetries}): ${error.message}`);
        console.log(`🔄 Retry dalam ${waitTime/1000} detik...`);
        await sleep(waitTime);
      } else if (!isNetworkError) {
        // Jika bukan network error, langsung throw
        throw error;
      }
    }
  }
  
  // Jika semua retry gagal
  console.log(`${operationName} gagal setelah ${maxRetries} percobaan`);
  throw lastError;
}

// Fungsi untuk load checkpoint
function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
      console.log("📋 Checkpoint ditemukan! Melanjutkan dari halaman", data.lastPage + 1, "item", data.lastCard + 1);
      return data;
    } catch (err) {
      console.log("⚠️  Error membaca checkpoint, mulai dari awal");
      return null;
    }
  }
  return null;
}

// Fungsi untuk save checkpoint
function saveCheckpoint(page, card, metadata) {
  const checkpoint = {
    lastPage: page,
    lastCard: card,
    lastUpdated: new Date().toISOString(),
    totalItems: metadata.length
  };
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// Fungsi untuk load metadata yang sudah ada
function loadExistingMetadata() {
  const metadataFile = path.join(OUT, "metadata.json");
  if (fs.existsSync(metadataFile)) {
    try {
      return JSON.parse(fs.readFileSync(metadataFile, "utf-8"));
    } catch (err) {
      return [];
    }
  }
  return [];
}

//Fungsi untuk membuat hash SHA256 dari file (validasi file)
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function formatTanggalIndo(dateStr) {
  if(!dateStr) return "unknown-date";

  const bulanMap = {
    Januari: "01",
    Februari: "02",
    Maret: "03",
    April: "04",
    Mei: "05",
    Juni: "06",
    Juli: "07",
    Agustus: "08",
    September: "09",
    Oktober: "10",
    November: "11",
    Desember: "12",
  };

  const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if(!match) return "unknown-date";

  const [, dd, bulan, yyyy] = match;
  const mm = bulanMap[bulan] || "00";

  return `${dd.padStart(2, "0")}-${mm}-${yyyy}`;
}

async function downloadImage(page, imgUrl, savePath) // Fungsi untuk download gambar dari browser dan simpan ke disk
 {
  return await retryOperation(async () => {
    //Menjalankan kode di dalam browser, bukan di Node.js
    const buffer = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { 
          credentials: "include",
          timeout: 30000 // 30 second timeout
        });
        
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        
        const arr = await res.arrayBuffer();
        return Array.from(new Uint8Array(arr));
      } catch (error) {
        throw new Error(`Fetch failed: ${error.message}`);
      }
    }, imgUrl);

    const data = Buffer.from(buffer);
    fs.writeFileSync(savePath, data);

    return {
      size: data.length,
      sha256: sha256(data),
    };
  }, `Download gambar ${path.basename(savePath)}`);
}

// Fungsi helper untuk launch browser dengan konfigurasi optimal
async function launchBrowser() {
  console.log('🚀 Meluncurkan Google Chrome...');
  
  const launchOptions = {
    headless: USE_HEADLESS, // Gunakan konfigurasi dari konstanta di atas
    executablePath: CHROME_PATH, // Gunakan Chrome asli, bukan Chromium dari Puppeteer
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,1080"
    ],
    protocolTimeout: 180000, // 3 menit
    ignoreHTTPSErrors: true,
    defaultViewport: {
      width: 1920,
      height: 1080
    }
  };
  
  try {
    const browser = await puppeteer.launch(launchOptions);
    console.log('✅ Google Chrome berhasil diluncurkan');
    
    // Test browser connection
    const version = await browser.version();
    console.log('📱 Chrome version:', version);
    
    return browser;
  } catch (error) {
    console.error('❌ Gagal meluncurkan Chrome:', error.message);
    console.error('💡 Pastikan Google Chrome terinstall di:', CHROME_PATH);
    throw error;
  }
}

// Fungsi helper untuk setup page dengan semua event listeners
async function setupPage(browser) {
  const page = await browser.newPage();
  
  // Set timeout untuk halaman
  page.setDefaultTimeout(PAGE_TIMEOUT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  
  // Handle page errors - don't throw here, just log
  page.on('error', error => {
    console.error('❌ Page crashed:', error.message);
  });
  
  page.on('pageerror', error => {
    // Filter out common non-critical JavaScript errors
    if (error.message.includes('Unexpected end of input') || 
        error.message.includes('SyntaxError') ||
        error.message.includes('Unexpected token') ||
        error.message.includes('JSON.parse') ||
        error.message.includes('Unexpected end of JSON input')) {
      // Completely suppress these common non-critical errors
      // console.warn('⚠️  Page script warning (non-critical):', error.message);
    } else {
      console.error('❌ Page script error:', error.message);
    }
  });
  
  // Handle request failures
  page.on('requestfailed', request => {
    console.warn('⚠️  Request failed:', request.url(), request.failure()?.errorText);
  });
  
  // Handle console messages dari browser untuk debugging
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('🌐 Browser console error:', msg.text());
    }
  });

  // Set User-Agent agar terlihat seperti Chrome asli
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Set bahasa request ke Indonesia
  await page.setExtraHTTPHeaders({
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8"
  });
  
  return page;
}

// Jalankan browser
(async () => {
  let browser;
  let page;
  let metadata = []; // Deklarasi di sini agar bisa diakses di catch block
  
  try {
    browser = await launchBrowser();
    page = await setupPage(browser);
    
    // Add global error handlers untuk page
    page.on('error', (error) => {
      console.error('❌ Page error:', error.message);
      // Don't throw here to prevent unhandled rejections
    });
    
    page.on('pageerror', (error) => {
      // Filter out common non-critical errors
      if (error.message.includes('Unexpected end of input') || 
          error.message.includes('SyntaxError') ||
          error.message.includes('Unexpected token') ||
          error.message.includes('JSON.parse') ||
          error.message.includes('Unexpected end of JSON input')) {
        // Completely suppress these common non-critical errors
        // console.warn('⚠️  Page script warning (non-critical):', error.message);
      } else {
        console.error('❌ Page script error:', error.message);
      }
    });
    
    // Load checkpoint dan metadata yang sudah ada
    const checkpoint = loadCheckpoint();
    metadata = loadExistingMetadata(); // Assign ke variable yang sudah dideklarasi
    
    const startPage = checkpoint ? checkpoint.lastPage : 0;
    const startCard = checkpoint ? checkpoint.lastCard + 1 : 0;
    
    console.log("🚀 Memulai scraping dari halaman", startPage + 1, "item", startCard + 1);

  // Loop halaman list (pagination)
  for (let p = startPage; p < MAX_PAGES; p++) {
    const offset = p === 0 ? "" : `/${p * STEP}`;
    const listUrl =
      `${BASE_URL}/home/cari/${DATE_FROM}/${DATE_TO}/all/all/all/null${offset}`;

    console.log("OPEN LIST:", listUrl);
    
    // Retry untuk membuka halaman list dengan strategi yang lebih robust
    await retryOperation(async () => {
      await page.goto(listUrl, { 
        waitUntil: "domcontentloaded", // Gunakan domcontentloaded untuk lebih cepat dan stabil
        timeout: NAVIGATION_TIMEOUT 
      });
      // Tunggu sebentar untuk memastikan konten dimuat
      await sleep(2000);
    }, `Membuka halaman list ${p + 1}`);
    
    await sleep(1500 + Math.random() * 2000); //Delay acak agar tidak seperti bot (1,5 - 3,5 sec)

  // Mengambil semua data berita dari halaman
    const cards = await retryOperation(async () => {
      return await page.evaluate(() => {
        try {
          return Array.from(document.querySelectorAll(".row-cards .card")).map(card => {
            //Ambil judul dan link detail
            const titleEl = card.querySelector(".text-muted a"); 
            const title = titleEl?.innerText.trim() || null;
            const detailUrl = titleEl?.href || null;

            const media = card.querySelector(".d-flex a.text-default")?.innerText || null; //Ambil nama media
            const date = card.querySelector(".d-flex small")?.innerText || null; //Ambil tanggal berita

            return { title, detailUrl, media, date }; //Hasilnya setiap berita disimpan sebagai object
          });
        } catch (error) {
          throw new Error(`Error parsing cards: ${error.message}`);
        }
      });
    }, `Mengambil data cards halaman ${p + 1}`);

  // Program masuk ke setiap page berita satu per satu.
    for (let i = 0; i < cards.length; i++) {
      // Skip item yang sudah diproses di run sebelumnya
      if (p === startPage && i < startCard) {
        console.log(` ⏭️  Skipping Page ${p + 1}, Card ${i + 1} (sudah diproses)`);
        continue;
      }
      
      const item = cards[i];
      if (!item.detailUrl) continue;

  //monitoring proses scraping di terminal
      console.log(` Page ${p + 1}, Card ${i + 1}`);
      console.log(`  OPEN DETAIL: ${item.detailUrl}`);

  // Buka halaman detail berita dan mengambil semua gambarnya dengan strategi yang lebih robust
      await retryOperation(async () => {
        await page.goto(item.detailUrl, { 
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT 
        });
        // Tunggu sebentar untuk memastikan konten dimuat
        await sleep(2000);
      }, `Membuka detail berita ${i + 1}`);
      
      await sleep(1200 + Math.random() * 1500);

  //Ambil semua gambar di halaman detail
      const images = await retryOperation(async () => {
        return await page.evaluate(() => {
          try {
            return Array.from(
              document.querySelectorAll("a.aimage-zoom img")
            ).map(img => ({
              src: img.src,
              filename: img.closest("a")?.dataset?.gambar_filename || null
            }));
          } catch (error) {
            throw new Error(`Error parsing images: ${error.message}`);
          }
        });
      }, `Mengambil gambar dari berita ${i + 1}`);

      if (!images.length) continue; //Kalau tidak ada gambar → berita dilewati

  //Mengambil tahun dari tanggal berita
      const yearMatch = item.date?.match(/\d{4}/);
      const year = yearMatch ? yearMatch[0] : "unknown";

  //Membuat folder
      const dir = path.join(IMG_DIR, year);
      fs.mkdirSync(dir, { recursive: true });
  //Loop setiap gambar dalam satu berita

      for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        if (!img.src) continue;

  //Penamaan file
        const tanggalFormatted = formatTanggalIndo(item.date);

        const originalName = img.src.split("/").pop() || `image_${idx + 1}.jpg`;
        // memastikan ekstensi tetap .jpg
        const finalName = `${tanggalFormatted}_${originalName}`;

        const safeName = finalName.replace(/[^a-z0-9.\-_]/gi, "_");
        const fpath = path.join(dir, safeName);

        const imgMeta = await downloadImage(page, img.src, fpath);

  //Simpan metadata ke array
        metadata.push({
          title: item.title,
          date: item.date,
          media: item.media,
          detail_url: item.detailUrl,
          image_url: img.src,
          local_image: fpath,
          ...imgMeta,
          scraped_at: new Date().toISOString(),
        });

        await sleep(400 + Math.random() * 600); //Delay kecil antar download
      }
      
      // Simpan checkpoint setelah selesai memproses setiap card
      saveCheckpoint(p, i, metadata);
      
      // Simpan metadata secara berkala (setiap card selesai)
      fs.writeFileSync(
        path.join(OUT, "metadata.json"),
        JSON.stringify(metadata, null, 2)
      );
    }
  }

  console.log("✅ Scraping selesai!");
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    console.log("🗑️  Checkpoint dihapus (proses selesai)");
  }
  
  fs.writeFileSync(
    path.join(OUT, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );

  //Tutup browser
  await browser.close();
  
  } catch (error) {
    console.error('\n❌ Error fatal terjadi:', error.message);
    
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    
    // Identifikasi jenis error
    if (error.message.includes('socket hang up') || error.message.includes('ECONNRESET')) {
      console.error('💡 Koneksi internet terputus atau server tidak merespons');
      console.error('💡 Silakan coba lagi nanti atau periksa koneksi internet Anda');
    } else if (error.message.includes('timeout')) {
      console.error('💡 Operasi timeout - server terlalu lama merespons');
    } else if (error.message.includes('Navigation')) {
      console.error('💡 Gagal navigasi ke halaman - URL mungkin tidak valid');
    }
    
    // Simpan metadata yang sudah berhasil dikumpulkan
    if (metadata && metadata.length > 0) {
      console.log('\n💾 Menyimpan metadata yang sudah dikumpulkan...');
      try {
        fs.writeFileSync(
          path.join(OUT, "metadata.json"),
          JSON.stringify(metadata, null, 2)
        );
        console.log(`✅ ${metadata.length} item berhasil disimpan`);
      } catch (saveError) {
        console.error('❌ Gagal menyimpan metadata:', saveError.message);
      }
    } else {
      console.log('ℹ️  Tidak ada data yang berhasil dikumpulkan');
    }
    
    // Tutup browser jika masih terbuka
    if (browser) {
      try {
        await browser.close();
        console.log('Browser ditutup');
      } catch (closeError) {
        console.error('⚠️  Error saat menutup browser:', closeError.message);
      }
    }
    
    process.exit(1);
  }
})().catch(error => {
  console.error('\n❌ Unhandled Promise Rejection:', error.message || error);
  if (error.stack) {
    console.error('Stack:', error.stack);
  }
  
  // Identifikasi jenis error
  if (error.message && error.message.includes('socket hang up') || error.message && error.message.includes('ECONNRESET')) {
    console.error('💡 Koneksi internet terputus atau server tidak merespons');
    console.error('💡 Silakan coba lagi nanti atau periksa koneksi internet Anda');
  } else if (error.message && error.message.includes('timeout')) {
    console.error('💡 Operasi timeout - server terlalu lama merespons');
  } else if (error.message && error.message.includes('Navigation')) {
    console.error('💡 Gagal navigasi ke halaman - URL mungkin tidak valid');
  }
  
  process.exit(1);
});

// Add global process handlers untuk menangkap unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Unhandled Promise Rejection at:', promise);
  console.error('Reason:', reason);
  
  // Jika reason adalah ErrorEvent, extract message-nya
  if (reason && typeof reason === 'object') {
    if (reason.message) {
      console.error('Error message:', reason.message);
    }
    if (reason.type) {
      console.error('Error type:', reason.type);
    }
    if (reason.target) {
      console.error('Error target:', reason.target);
    }
    // Log semua properties dari ErrorEvent
    try {
      console.error('Full error object:', JSON.stringify(reason, Object.getOwnPropertyNames(reason)));
    } catch (e) {
      console.error('Could not stringify error object');
    }
  }
  
  // Jangan exit langsung, biarkan script melanjutkan
  console.error('⚠️  Script akan melanjutkan meskipun ada unhandled rejection...');
});

process.on('uncaughtException', (error) => {
  console.error('\n❌ Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
});

/**
 * ============================================================
 *  WHATSAPP GATEKEEPER BOT — v2 (dengan Gemini AI)
 *  Sistem Penyaring Tamu Otomatis + AI untuk WhatsApp Rumah
 *  Menggunakan: @whiskeysockets/baileys v7, @google/generative-ai
 *  Style: ESM (import/export)
 * ============================================================
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
} from '@whiskeysockets/baileys';
import pino from 'pino';

// ============================================================
// 1. DATABASE ANGGOTA KELUARGA
// ============================================================

const DATABASE_KELUARGA = [
  {
    namaResmi: 'M Aidil Alamsyah',
    panggilanUtama: 'Aidil',
    nomor: '6285175281143@s.whatsapp.net',
    alternatifPanggilan: ['aidil', 'edil', 'm aidil', 'm aidil alamsyah', 'edil ahtera'],
  },
];

// ============================================================
// 2. DATABASE PERUSAHAAN KURIR RESMI
// ============================================================

const DATABASE_KURIR = [
  'jne', 'j&t', 'jnt', 'sicepat', 'anteraja', 'gojek', 'grab',
  'shopee', 'shopeeexpress', 'shopee express', 'tiki', 'pos indonesia',
  'pos', 'lion parcel', 'ninja express', 'ninja', 'rpx', 'jalur nugraha',
  'ekakurir', 'wahana', 'first logistics', 'idexpress', 'id express',
  'lalamove', 'borzo', 'instant', 'paxel', 'gosend', 'grab express',
];

const KATA_KUNCI_KURIR = ['dari', 'pengirim', 'tujuan', 'kepada', 'resi', 'nomor resi', 'alamat', 'paket'];

// Ekstensi file yang DIIZINKAN (selain gambar/video yang diverifikasi tersendiri)
const EKSTENSI_DIIZINKAN = ['.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];
// Ekstensi yang DIBLOKIR
const EKSTENSI_DIBLOKIR = ['.apk', '.exe', '.bat', '.sh', '.cmd', '.msi', '.dmg', '.deb', '.rpm', '.ipa'];

// ============================================================
// 3. KONFIGURASI
// ============================================================

const NOMOR_BOT      = process.env.NOMOR_BOT      || '';
const AUTH_DIR       = process.env.AUTH_DIR        || 'auth_info_baileys';
const NAMA_BOT       = process.env.NAMA_BOT        || 'Islah';
const NAMA_KELUARGA  = process.env.NAMA_KELUARGA   || 'Dil Familie';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY  || '';

if (!NOMOR_BOT || !/^\d{10,15}$/.test(NOMOR_BOT.trim())) {
  console.error('[CONFIG] NOMOR_BOT tidak diset atau format tidak valid.');
  console.error('[CONFIG] Set environment variable NOMOR_BOT=628xxxxxxxxxx (tanpa +, 10-15 digit)');
  process.exit(1);
}

// ============================================================
// 4. SETUP GEMINI AI
// ============================================================

let geminiModel = null;
let geminiEnabled = false;

if (GEMINI_API_KEY) {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    geminiEnabled = true;
    console.log('[GEMINI] Gemini AI aktif.');
  } catch (err) {
    console.error('[GEMINI] Gagal inisialisasi (paket tidak tersedia atau API key salah):', err.message);
  }
} else {
  console.log('[GEMINI] GEMINI_API_KEY tidak diset. Mode AI dinonaktifkan, pakai skrining 3 langkah biasa.');
}

/** Daftar nama keluarga untuk sistem prompt Gemini */
const daftarNamaKeluarga = DATABASE_KELUARGA.map(a =>
  `${a.panggilanUtama} (alias: ${a.alternatifPanggilan.join(', ')})`
).join('; ');

/** System prompt untuk Gemini saat berbicara dengan tamu */
const SYSTEM_PROMPT_TAMU = `Anda adalah ${NAMA_BOT}, asisten virtual keluarga untuk sistem komunikasi privat ${NAMA_KELUARGA}.

Tugas Anda:
1. Menyapa dan berbicara sopan dengan tamu yang menghubungi sistem ini.
2. Menjawab pertanyaan umum dengan ramah dalam bahasa yang digunakan tamu (Indonesia atau Inggris).
3. Mendeteksi secara cerdas jika tamu ingin menghubungi salah satu anggota keluarga terdaftar.
4. JANGAN pernah memberitahukan atau mengkonfirmasi nomor telepon pribadi anggota keluarga.
5. JANGAN menyebutkan bahwa ini adalah sistem bot atau AI secara langsung kecuali ditanya.

Anggota keluarga yang terdaftar: ${daftarNamaKeluarga}

ATURAN DETEKSI KONTAK KELUARGA:
- Jika tamu menyebutkan nama anggota keluarga atau aliasnya dan berniat menghubungi/menemui mereka,
  tambahkan TEPAT di akhir respons Anda (tanpa spasi sebelumnya):
  [HUBUNGI:<alias_keluarga>:<nama_yang_diketik_tamu>]
  Contoh: Tamu tanya "ada edil tidak?" maka tambahkan [HUBUNGI:edil:edil] di akhir.
  Contoh: Tamu tanya "bisa ketemu Aidil?" maka tambahkan [HUBUNGI:aidil:Aidil] di akhir.
- Jangan tampilkan marker ini ke tamu. Sertakan respons normal + marker di akhir.
- Sebelum marker, katakan: "Baik. Sebelum kami sambungkan ke [nama yang diketik tamu], kami perlu mencatat beberapa informasi."

ATURAN KEAMANAN:
- DILARANG KERAS menyebutkan nomor telepon anggota keluarga.
- Jika ada yang meminta nomor telepon, katakan: "Maaf, informasi nomor pribadi tidak dapat kami bagikan."
- Jangan mengungkapkan detail pribadi anggota keluarga (alamat, jadwal, dsb.) kecuali umum.

FORMAT RESPONS:
- Jangan gunakan emoji.
- Gunakan bahasa sopan dan formal.
- Respons singkat dan padat, tidak lebih dari 3-4 kalimat kecuali diperlukan.`;

/** System prompt untuk verifikasi teks */
const SYSTEM_PROMPT_VERIFIKASI = `Anda adalah validator teks. Tentukan apakah teks berikut mengandung kata atau kalimat bermakna dalam bahasa Indonesia atau Inggris.
Teks dianggap VALID jika:
- Mengandung setidaknya 1 kata nyata yang bermakna
- Bukan rangkaian huruf/angka acak (mis: "asdfgh", "qwerty123", "xxxx")
- Bukan hanya simbol atau karakter khusus

Teks dianggap TIDAK VALID jika:
- Semua huruf acak tanpa makna
- Hanya angka atau simbol
- Terlalu pendek (kurang dari 2 karakter)

Jawab HANYA dengan: VALID atau TIDAK_VALID`;

/** System prompt untuk verifikasi link */
const SYSTEM_PROMPT_VERIFIKASI_LINK = `Anda adalah sistem keamanan link. Analisis URL berikut dan tentukan apakah aman.
URL dianggap BERBAHAYA jika:
- Terlihat seperti phishing (meniru situs resmi tapi domain mencurigakan)
- Mengandung kata kunci berbahaya (malware, hack, crack, keygen, free-money, dll.)
- Domain sangat pendek/acak yang tidak dikenal
- Menggunakan URL shortener yang berpotensi menyembunyikan tujuan berbahaya

URL dianggap AMAN jika:
- Domain resmi yang dikenal (google.com, youtube.com, tokopedia.com, shopee.co.id, dll.)
- Platform media sosial resmi
- Situs berita resmi
- E-commerce resmi Indonesia

Jawab HANYA dengan: AMAN atau BERBAHAYA`;

// ============================================================
// 5. STATE GLOBAL
// ============================================================

/**
 * State skrining tamu:
 * step: 0 = mode AI chat (tamu belum berniat hubungi keluarga)
 * step: 1 = tanya nama lengkap
 * step: 3 = tanya keperluan (step 2 dilewati jika target sudah diketahui AI)
 * step: 'selesai' = formulir selesai, menunggu keluarga
 */
const stateScreening = {};

/** Riwayat percakapan AI per tamu: { [guestJid]: Array<{role, parts}> } */
const riwayatChatAI = {};

/** State bridge aktif per keluarga: { [familyJid]: { guestJid, active, namaPanggilanKeluarga } | null } */
const stateBridge = {};

/**
 * Konfirmasi menunggu per keluarga.
 * Tamu TIDAK langsung terhubung — keluarga harus balas Y dulu.
 */
const konfirmasiPending = {};

/** Kunci atomik per keluarga untuk cegah race condition */
const bridgeLock = {};

/** Antrean tamu FIFO per keluarga */
const antreanTamu = {};

/**
 * Riwayat semua tamu (untuk panggil balik lewat kode tamu)
 * { [kodeTamu]: { guestJid, namaLengkap, tujuan, targetKeluargaNomor, namaPanggilanKeluarga } }
 */
const riwayatTamu = {};

/** Kode tamu harian (reset setiap hari) */
const kodeTamuHarian = { tanggal: null, counter: 0 };

/**
 * State "Chat keluar" menunggu nama tampilan:
 * { [familyJid]: { nomorInput } }
 * Diisi saat keluarga kirim "Chat <nomor>" dan bot menunggu nama tampilan.
 */
const stateChatKeluarMenungguNama = {};

const BATAS_WAKTU_KONFIRMASI_MS = 20 * 60 * 1000; // 20 menit
const BATAS_WAKTU_BRIDGE_MS      = 10 * 60 * 1000; // 10 menit

/** Timer tidak-aktif per sesi bridge */
const stateBridgeTimer = {};

/** Buffer debounce pesan teks */
const messageBuffer = {};

// Guard
let sock = null;
let sudahMintaPairingCode = false;
let sedangReconnect = false;
let pernahTerhubung = false;
let percobaanPairingGagal = 0;

// ============================================================
// 6. HELPER FUNCTIONS
// ============================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function kirimPesan(jid, teks) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text: teks });
  } catch (err) {
    console.error(`[ERROR] Gagal kirim ke ${jid}:`, err.message);
  }
}

/** Jenis pesan media WA */
function apakahPesanMedia(msg) {
  return !!(
    msg?.imageMessage || msg?.videoMessage || msg?.audioMessage ||
    msg?.documentMessage || msg?.documentWithCaptionMessage || msg?.stickerMessage ||
    msg?.locationMessage || msg?.liveLocationMessage ||
    msg?.contactMessage || msg?.contactsArrayMessage ||
    msg?.gifMessage
  );
}

function labelJenisMedia(msg) {
  if (msg?.stickerMessage)   return '[Stiker]';
  if (msg?.imageMessage)     return '[Gambar]';
  if (msg?.videoMessage)     return msg.videoMessage.gifPlayback ? '[GIF]' : '[Video]';
  if (msg?.audioMessage)     return msg.audioMessage.ptt ? '[Pesan Suara]' : '[Audio]';
  if (msg?.documentMessage || msg?.documentWithCaptionMessage) return '[Dokumen]';
  if (msg?.locationMessage || msg?.liveLocationMessage)        return '[Lokasi]';
  if (msg?.contactMessage || msg?.contactsArrayMessage)        return '[Kontak]';
  return '[Pesan]';
}

/** Ambil ekstensi file dari nama file dokumen */
function ambilEkstensiDokumen(msg) {
  const nama = msg?.documentMessage?.fileName
    || msg?.documentWithCaptionMessage?.message?.documentMessage?.fileName
    || '';
  if (!nama) return '';
  const dot = nama.lastIndexOf('.');
  return dot >= 0 ? nama.slice(dot).toLowerCase() : '';
}

/** Teruskan pesan media (forward Baileys) */
async function teruskanPesanMedia(toJid, message, labelPengirim) {
  if (!sock) return;
  try {
    if (labelPengirim) {
      await kirimPesan(toJid, `${labelPengirim} ${labelJenisMedia(message.message)}`);
    }
    await sock.copyNForward(toJid, message, true);
  } catch (err) {
    console.error(`[ERROR] Gagal teruskan media ke ${toJid}:`, err.message);
    if (labelPengirim) {
      await kirimPesan(toJid, `${labelPengirim} mengirim ${labelJenisMedia(message.message)} [tidak dapat diteruskan]`);
    }
  }
}

/** Buffer debounce — kumpulkan baris teks dan kirim sekaligus setelah 2,5 detik */
function bufferDanKirimPesan(fromJid, toJid, teks, label) {
  const kunci = `${fromJid}=>${toJid}`;
  if (messageBuffer[kunci]) {
    clearTimeout(messageBuffer[kunci].timer);
    messageBuffer[kunci].messages.push(teks);
  } else {
    messageBuffer[kunci] = { timer: null, messages: [teks] };
  }
  messageBuffer[kunci].timer = setTimeout(async () => {
    const buf = messageBuffer[kunci];
    if (!buf) return;
    messageBuffer[kunci] = null;
    const gabung = buf.messages.join('\n');
    await kirimPesan(toJid, `${label}\n${gabung}`);
  }, 2500);
}

function batalkanBuffer(fromJid, toJid) {
  const kunci = `${fromJid}=>${toJid}`;
  if (messageBuffer[kunci]) {
    clearTimeout(messageBuffer[kunci].timer);
    messageBuffer[kunci] = null;
  }
}

function pasangBridgeTimeout(familyJid) {
  clearTimeout(stateBridgeTimer[familyJid]);
  stateBridgeTimer[familyJid] = setTimeout(() => {
    bridgeTimeout(familyJid).catch(err =>
      console.error('[BRIDGE] Timeout error:', err.message)
    );
  }, BATAS_WAKTU_BRIDGE_MS);
}

// ── Decode JID ──────────────────────────────────────────────────────────────
function nomorDariJid(jid) {
  if (!jid) return null;
  return jidDecode(jid)?.user || null;
}

function cariKeluargaByJid(jid, jidAlt) {
  const nomorJid = nomorDariJid(jid);
  const nomorAlt = nomorDariJid(jidAlt);
  return DATABASE_KELUARGA.find(a => {
    const nomorAnggota = nomorDariJid(a.nomor);
    return nomorAnggota === nomorJid || (nomorAlt && nomorAnggota === nomorAlt);
  }) || null;
}

function cariKeluarga(namaInput) {
  const input = namaInput.trim().toLowerCase();
  return DATABASE_KELUARGA.find(a =>
    a.alternatifPanggilan.some(alias => alias.toLowerCase() === input) ||
    a.panggilanUtama.toLowerCase() === input ||
    a.namaResmi.toLowerCase() === input
  ) || null;
}

function buatJidDariNomor(nomorInput) {
  let digit = (nomorInput || '').replace(/[^0-9]/g, '');
  if (!digit) return null;
  if (digit.startsWith('0')) digit = '62' + digit.slice(1);
  else if (!digit.startsWith('62')) digit = '62' + digit;
  if (digit.length < 10 || digit.length > 15) return null;
  return `${digit}@s.whatsapp.net`;
}

function buatKodeTamu(namaLengkap) {
  const sekarang = new Date();
  const dd = String(sekarang.getDate()).padStart(2, '0');
  const mm = String(sekarang.getMonth() + 1).padStart(2, '0');
  const yyyy = sekarang.getFullYear();
  const tanggalHariIni = `${dd}${mm}${yyyy}`;

  if (kodeTamuHarian.tanggal !== tanggalHariIni) {
    kodeTamuHarian.tanggal = tanggalHariIni;
    kodeTamuHarian.counter = 0;
  }
  kodeTamuHarian.counter += 1;

  const hurufNama = namaLengkap.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5);
  return `#${kodeTamuHarian.counter}${hurufNama}${tanggalHariIni}`;
}

function formatSebutan(teks) {
  return teks.trim().split(/\s+/)
    .map(kata => kata.charAt(0).toUpperCase() + kata.slice(1).toLowerCase())
    .join(' ');
}

function deteksiKurir(teks) {
  const lower = teks.toLowerCase();
  const kataKunciDitemukan = KATA_KUNCI_KURIR.filter(k => lower.includes(k));
  if (kataKunciDitemukan.length < 3) return null;
  const kurirDitemukan = DATABASE_KURIR.find(k => lower.includes(k));
  if (!kurirDitemukan) return null;

  const namaKurir = kurirDitemukan.toUpperCase();
  const targetKeluarga = DATABASE_KELUARGA.find(a =>
    a.alternatifPanggilan.some(alias => lower.includes(alias)) ||
    lower.includes(a.panggilanUtama.toLowerCase()) ||
    lower.includes(a.namaResmi.toLowerCase())
  ) || null;

  return { namaKurir, targetKeluarga };
}

async function kirimKontakVCard(tujuanJid, anggota) {
  if (!sock) return;
  try {
    const nomorBersih = '+' + anggota.nomor.replace('@s.whatsapp.net', '');
    const waid = anggota.nomor.replace('@s.whatsapp.net', '');
    const vcard =
      `BEGIN:VCARD\nVERSION:3.0\nFN:${anggota.namaResmi}\n` +
      `TEL;type=CELL;type=VOICE;waid=${waid}:${nomorBersih}\nEND:VCARD`;
    await sock.sendMessage(tujuanJid, {
      contacts: { displayName: anggota.namaResmi, contacts: [{ vcard }] },
    });
  } catch (err) {
    console.error(`[ERROR] Gagal kirim vCard ke ${tujuanJid}:`, err.message);
  }
}

// ============================================================
// 7. GEMINI AI FUNCTIONS
// ============================================================

/**
 * Panggil Gemini dengan prompt sederhana (satu giliran, tanpa riwayat).
 * Return string atau null jika gagal/tidak diaktifkan.
 */
async function tanyaGemini(prompt, systemInstruction) {
  if (!geminiEnabled || !geminiModel) return null;
  try {
    const modelDenganSystem = systemInstruction
      ? new (geminiModel.constructor)(geminiModel._apiKey, { ...geminiModel._generationConfig, systemInstruction })
      : geminiModel;

    // Gunakan API sederhana
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    });
    return result.response.text().trim();
  } catch (err) {
    console.error('[GEMINI] Error tanya:', err.message);
    return null;
  }
}

/**
 * Chat multi-giliran dengan tamu menggunakan Gemini.
 * Mengelola riwayat percakapan per tamu.
 * Mengembalikan { teks: string, hubungiAlias: string|null, hubungiNamaKetik: string|null }
 */
async function chatGeminiTamu(guestJid, pesanTamu) {
  if (!geminiEnabled || !geminiModel) return null;

  try {
    if (!riwayatChatAI[guestJid]) {
      riwayatChatAI[guestJid] = [];
    }

    const riwayat = riwayatChatAI[guestJid];
    riwayat.push({ role: 'user', parts: [{ text: pesanTamu }] });

    const result = await geminiModel.generateContent({
      contents: riwayat,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT_TAMU }] },
    });

    const responMentah = result.response.text().trim();

    // Cek marker [HUBUNGI:<alias>:<namaKetik>]
    const markerRegex = /\[HUBUNGI:([^\]:<>]+):([^\]:<>]+)\]/i;
    const markerMatch = responMentah.match(markerRegex);

    let hubungiAlias = null;
    let hubungiNamaKetik = null;
    let teks = responMentah;

    if (markerMatch) {
      hubungiAlias = markerMatch[1].trim().toLowerCase();
      hubungiNamaKetik = markerMatch[2].trim();
      // Hapus marker dari teks yang dikirim ke tamu
      teks = responMentah.replace(markerRegex, '').trim();
    }

    // Simpan respons ke riwayat
    riwayat.push({ role: 'model', parts: [{ text: responMentah }] });

    // Batasi riwayat (jaga agar tidak terlalu panjang)
    if (riwayat.length > 40) {
      riwayatChatAI[guestJid] = riwayat.slice(-30);
    }

    return { teks, hubungiAlias, hubungiNamaKetik };
  } catch (err) {
    console.error('[GEMINI] Error chat tamu:', err.message);
    return null;
  }
}

/**
 * Verifikasi apakah teks mengandung kata bermakna (Indonesia/Inggris).
 * Return true jika valid, false jika tidak bermakna (acak/spam).
 */
async function verifikasiTeksBermakna(teks) {
  if (!geminiEnabled) return true; // jika AI nonaktif, anggap valid

  if (!teks || teks.trim().length < 2) return false;

  try {
    const prompt = `Teks: "${teks}"`;
    const hasil = await tanyaGemini(prompt, SYSTEM_PROMPT_VERIFIKASI);
    if (!hasil) return true; // jika gagal, anggap valid
    return hasil.includes('VALID') && !hasil.includes('TIDAK_VALID');
  } catch (err) {
    console.error('[GEMINI] Error verifikasi teks:', err.message);
    return true; // jika error, anggap valid
  }
}

/**
 * Verifikasi apakah link aman.
 * Return true jika aman, false jika berbahaya.
 */
async function verifikasiLink(url) {
  if (!geminiEnabled) return true;

  try {
    const prompt = `URL untuk diverifikasi: ${url}`;
    const hasil = await tanyaGemini(prompt, SYSTEM_PROMPT_VERIFIKASI_LINK);
    if (!hasil) return true;
    return hasil.includes('AMAN') && !hasil.includes('BERBAHAYA');
  } catch (err) {
    console.error('[GEMINI] Error verifikasi link:', err.message);
    return true;
  }
}

/**
 * Verifikasi file/dokumen yang dikirim tamu.
 * Return { boleh: boolean, alasan: string }
 */
async function verifikasiFile(message) {
  const msg = message?.message;
  if (!msg) return { boleh: true, alasan: '' };

  // Cek dokumen — verifikasi ekstensi
  if (msg.documentMessage || msg.documentWithCaptionMessage) {
    const ext = ambilEkstensiDokumen(msg);
    if (ext && EKSTENSI_DIBLOKIR.includes(ext)) {
      return { boleh: false, alasan: `File dengan ekstensi ${ext} tidak diizinkan.` };
    }
    if (ext && !EKSTENSI_DIIZINKAN.includes(ext) && ext !== '') {
      return { boleh: false, alasan: `Hanya file PDF, Word, PowerPoint, Excel, dan teks yang diizinkan.` };
    }
    return { boleh: true, alasan: '' };
  }

  // Gambar/video: verifikasi via Gemini Vision (jika tersedia)
  if (geminiEnabled && (msg.imageMessage || msg.videoMessage)) {
    try {
      // Cek caption untuk link berbahaya
      const caption = msg.imageMessage?.caption || msg.videoMessage?.caption || '';
      if (caption) {
        const urlRegex = /https?:\/\/[^\s]+/gi;
        const links = caption.match(urlRegex) || [];
        for (const link of links) {
          const aman = await verifikasiLink(link);
          if (!aman) {
            return { boleh: false, alasan: `Link dalam caption terdeteksi berbahaya: ${link}` };
          }
        }
      }
    } catch (err) {
      console.error('[VERIFIKASI] Error verifikasi gambar:', err.message);
    }
  }

  return { boleh: true, alasan: '' };
}

/**
 * Deteksi dan verifikasi semua link dalam teks pesan.
 * Return { aman: boolean, linkBerbahaya: string }
 */
async function cekLinkDalamTeks(teks) {
  if (!teks) return { aman: true, linkBerbahaya: '' };
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const links = teks.match(urlRegex) || [];
  for (const link of links) {
    const aman = await verifikasiLink(link);
    if (!aman) {
      return { aman: false, linkBerbahaya: link };
    }
  }
  return { aman: true, linkBerbahaya: '' };
}

// ============================================================
// 8. FUNGSI BRIDGE
// ============================================================

async function bridgeTimeout(familyJid) {
  const bridge = stateBridge[familyJid];
  if (!bridge || !bridge.active) return;
  console.log(`[BRIDGE] Timeout 10 menit tanpa aktivitas — sesi diakhiri otomatis.`);
  await akhiriLiveChatBridge(familyJid, false, true);
}

async function mulaiLiveChatBridge(familyJid, tamuData, opts = {}) {
  const { guestJid, namaLengkap, namaPanggilanKeluarga } = tamuData;
  const { kirimPesanKeGuest = true } = opts;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';
  const panggilanUntukTamu = namaPanggilanKeluarga || panggilan;

  stateBridge[familyJid] = { guestJid, active: true, namaPanggilanKeluarga: panggilanUntukTamu };
  pasangBridgeTimeout(familyJid);

  await kirimPesan(familyJid,
    `[LIVE CHAT AKTIF] Terhubung dengan *${namaLengkap}*.\n\nKetik *N* untuk mengakhiri sesi.`
  );
  if (kirimPesanKeGuest) {
    await kirimPesan(guestJid,
      `ⓘ Anda telah terhubung dengan *${panggilanUntukTamu}*.\n\nSilakan sampaikan pesan Anda.`
    );
  }
  console.log(`[BRIDGE] Aktif: ${namaLengkap} (${guestJid}) <-> ${panggilan} (${familyJid})`);
}

function pasangKonfirmasiPending(familyJid, tamuData) {
  const timer = setTimeout(() => {
    konfirmasiTimeout(familyJid).catch(err =>
      console.error('[KONFIRMASI] Gagal proses timeout:', err.message)
    );
  }, BATAS_WAKTU_KONFIRMASI_MS);

  konfirmasiPending[familyJid] = { ...tamuData, timer };
}

async function kirimPromptKonfirmasi(familyJid) {
  const pending = konfirmasiPending[familyJid];
  if (!pending) return;

  const antrean = antreanTamu[familyJid] || [];
  if (antrean.length === 0) {
    const barisPesanPertama = pending.pesanPertama && pending.pesanPertama.trim()
      ? `\n_"${pending.pesanPertama}"_`
      : '';
    await kirimPesan(familyJid,
      `[TAMU MENUNGGU]\n\n*${pending.namaLengkap}* (${pending.kode})\n_${pending.tujuan}_${barisPesanPertama}\n\n` +
      `Apakah Anda bersedia membalas pesan tamu ini?\nKetik *Y* untuk menerima.\nKetik *N* untuk menolak.`
    );
  } else {
    await kirimDaftarTungguKeKeluarga(familyJid);
  }
  console.log(`[KONFIRMASI] Menunggu jawaban untuk ${pending.namaLengkap} (${pending.kode})`);
}

async function kirimDaftarTungguKeKeluarga(familyJid) {
  const pending = konfirmasiPending[familyJid];
  const antrean = antreanTamu[familyJid] || [];
  const semua = pending ? [pending, ...antrean] : [...antrean];
  if (semua.length === 0) return;

  const daftar = semua
    .map((t, i) => {
      const barisPesanPertama = t.pesanPertama && t.pesanPertama.trim()
        ? `\n   _"${t.pesanPertama}"_`
        : '';
      return `${i + 1}. *${t.kode}* -- ${t.namaLengkap}\n   _${t.tujuan}_${barisPesanPertama}`;
    })
    .join('\n\n');

  await kirimPesan(familyJid,
    `[${semua.length} TAMU MENUNGGU BALASAN]\n\n${daftar}\n\n` +
    `Ketik *kode* tamu untuk membalas (mis. *${semua[0].kode}*).\n` +
    `Atau ketik *Y* untuk menerima tamu pertama, *N* untuk menolak tamu pertama.`
  );
}

async function konfirmasiTimeout(familyJid) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  let harusLanjutAntrean = false;
  try {
    const pending = konfirmasiPending[familyJid];
    if (!pending) return;

    konfirmasiPending[familyJid] = null;
    harusLanjutAntrean = true;

    const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
    const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

    await kirimPesan(pending.guestJid,
      `ⓘ Mohon maaf, *${pending.namaPanggilanKeluarga || panggilan}* sedang sibuk dan belum dapat dihubungi saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid,
      `⌛︎ Waktu konfirmasi (20 menit) habis. Permintaan tamu *${pending.namaLengkap}* (${pending.kode}) otomatis dianggap ditolak.`
    );

    // Kembalikan tamu ke mode AI chat
    if (stateScreening[pending.guestJid]) {
      stateScreening[pending.guestJid] = { step: 0, pesanPertama: '' };
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
  if (harusLanjutAntrean) await mintaKonfirmasiBerikutnya(familyJid);
}

async function pilihTamuDariAntreanByKode(familyJid, kodeInput) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const pending = konfirmasiPending[familyJid];
    if (pending && pending.kode === kodeInput) {
      // Tamu yang sedang dikonfirmasi
      clearTimeout(pending.timer);
      konfirmasiPending[familyJid] = null;
      await mulaiLiveChatBridge(familyJid, pending);
      return true;
    }

    const antrean = antreanTamu[familyJid] || [];
    const idx = antrean.findIndex(t => t.kode === kodeInput);
    if (idx < 0) return false;

    const tamu = antrean.splice(idx, 1)[0];

    // Kalau ada tamu lain yang sedang ditanya konfirmasi, jangan dibiarkan hilang
    if (konfirmasiPending[familyJid]) {
      antrean.unshift(konfirmasiPending[familyJid]);
      clearTimeout(konfirmasiPending[familyJid].timer);
      konfirmasiPending[familyJid] = null;
    }

    await mulaiLiveChatBridge(familyJid, tamu);

    for (let i = 0; i < antrean.length; i++) {
      await kirimPesan(antrean[i].guestJid, `ⓘ Update antrean: posisi Anda sekarang *#${i + 1}*.`);
    }
    return true;
  } finally {
    bridgeLock[familyJid] = false;
  }
}

async function batalkanTamuMenunggu(guestJid) {
  // Cek di konfirmasi pending
  for (const [familyJid, pending] of Object.entries(konfirmasiPending)) {
    if (pending && pending.guestJid === guestJid) {
      while (bridgeLock[familyJid]) await delay(50);
      bridgeLock[familyJid] = true;
      try {
        clearTimeout(pending.timer);
        konfirmasiPending[familyJid] = null;
        const namaTamu = pending.namaLengkap;
        await kirimPesan(familyJid, `ⓘ Permintaan dari tamu *${namaTamu}* telah dibatalkan oleh tamu tersebut.`);
      } finally {
        bridgeLock[familyJid] = false;
      }
      await mintaKonfirmasiBerikutnya(familyJid);
      return true;
    }
  }
  // Cek di antrean
  for (const [familyJid, antrean] of Object.entries(antreanTamu)) {
    if (!antrean) continue;
    const idx = antrean.findIndex(t => t.guestJid === guestJid);
    if (idx >= 0) {
      const tamu = antrean.splice(idx, 1)[0];
      const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
      const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';
      await kirimPesan(familyJid, `ⓘ Permintaan dari tamu *${tamu.namaLengkap}* telah dibatalkan.`);
      for (let i = 0; i < antrean.length; i++) {
        await kirimPesan(antrean[i].guestJid, `ⓘ Update antrean: posisi Anda sekarang *#${i + 1}*.`);
      }
      return true;
    }
  }
  return false;
}

async function akhiriLiveChatBridge(familyJid, diabaikan = false, karenaTimeout = false) {
  const bridge = stateBridge[familyJid];
  if (!bridge || !bridge.active) return;

  const { guestJid } = bridge;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';
  const panggilanUntukLawanBicara = bridge.namaPanggilanKeluarga || panggilan;

  stateBridge[familyJid] = null;
  clearTimeout(stateBridgeTimer[familyJid]);
  stateBridgeTimer[familyJid] = null;
  batalkanBuffer(familyJid, guestJid);

  if (karenaTimeout) {
    await kirimPesan(guestJid, `ⓘ Sesi percakapan diakhiri otomatis karena tidak ada aktivitas selama 10 menit. Terima kasih.`);
    await kirimPesan(familyJid, `⌛︎ Sesi live chat diakhiri otomatis karena tidak ada aktivitas selama 10 menit.`);
  } else if (diabaikan) {
    await kirimPesan(guestJid, `ⓘ Mohon maaf, *${panggilanUntukLawanBicara}* tidak dapat melanjutkan percakapan saat ini. Terima kasih.`);
    await kirimPesan(familyJid, `✓ Sesi telah diputuskan.`);
  } else {
    await kirimPesan(guestJid, `ⓘ Sesi percakapan telah berakhir. Terima kasih.`);
    await kirimPesan(familyJid, `✓ Sesi live chat telah berakhir.`);
  }

  console.log(`[BRIDGE] Berakhir: ${guestJid} <-> ${familyJid}${diabaikan ? ' (diabaikan)' : ''}${karenaTimeout ? ' (timeout)' : ''}`);

  // Kembalikan tamu ke mode AI chat (bukan hapus state sepenuhnya)
  if (stateScreening[guestJid]) {
    delete stateScreening[guestJid];
    if (geminiEnabled) {
      // Bersihkan riwayat percakapan AI agar sesi baru bersih
      delete riwayatChatAI[guestJid];
    }
  }

  await mintaKonfirmasiBerikutnya(familyJid);
}

async function mintaKonfirmasiBerikutnya(familyJid) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const antrean = antreanTamu[familyJid];
    if (!antrean || antrean.length === 0) return;

    const tamuBerikutnya = antrean.shift();
    console.log(`[ANTREAN] Kirim konfirmasi berikutnya untuk ${familyJid}: ${tamuBerikutnya.namaLengkap} (${tamuBerikutnya.kode})`);

    pasangKonfirmasiPending(familyJid, tamuBerikutnya);
    await kirimPromptKonfirmasi(familyJid);

    for (let i = 0; i < antrean.length; i++) {
      await kirimPesan(antrean[i].guestJid, `ⓘ Update antrean: posisi Anda sekarang *#${i + 1}*.`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
}

async function mintaKonfirmasiAtauAntre(familyJid, tamuData) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;

  try {
    const bridgeAktif = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    const adaAntrean = antreanTamu[familyJid] && antreanTamu[familyJid].length > 0;

    if ((!bridgeAktif || !bridgeAktif.active) && !konfirmasiAktif && !adaAntrean) {
      pasangKonfirmasiPending(familyJid, tamuData);
      await kirimPromptKonfirmasi(familyJid);
    } else {
      if (!antreanTamu[familyJid]) antreanTamu[familyJid] = [];
      antreanTamu[familyJid].push(tamuData);
      const posisi = antreanTamu[familyJid].length;
      const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
      const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

      await kirimPesan(tamuData.guestJid,
        `⌛︎ *${panggilan}* sedang berkomunikasi dengan tamu lain.\nPosisi antrean Anda: *#${posisi}*\nKami hubungi saat giliran tiba.`
      );

      if (konfirmasiAktif) {
        await kirimDaftarTungguKeKeluarga(familyJid);
      } else {
        await kirimPesan(familyJid,
          `[INFO ANTREAN]\nTamu baru *${tamuData.namaLengkap}* (${tamuData.kode}) menunggu di antrean #${posisi}.\nKeperluan: _${tamuData.tujuan}_`
        );
      }
      console.log(`[ANTREAN] ${tamuData.namaLengkap} (${tamuData.kode}) di antrean #${posisi} untuk ${familyJid}`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
}

// ============================================================
// 9. FUNGSI SKRINING TAMU
// ============================================================

/**
 * Mulai interaksi dengan tamu baru.
 * Jika Gemini aktif: tamu langsung masuk mode AI chat.
 * Jika Gemini nonaktif: mulai skrining 3 langkah biasa.
 */
async function mulaiInteraksiTamu(guestJid, teks) {
  if (geminiEnabled) {
    // Mode AI: simpan pesan pertama, set state AI chat
    stateScreening[guestJid] = { step: 0, pesanPertama: teks };
    console.log(`[AI] Tamu baru (mode AI): ${guestJid}`);

    const hasil = await chatGeminiTamu(guestJid, teks);
    if (!hasil) {
      // Fallback jika Gemini gagal
      await mulaiSkriningBiasa(guestJid, teks);
      return;
    }

    await kirimPesan(guestJid, hasil.teks);

    // Cek apakah Gemini mendeteksi niat hubungi keluarga
    if (hasil.hubungiAlias) {
      await prosesNiatHubungiKeluarga(guestJid, hasil.hubungiAlias, hasil.hubungiNamaKetik, teks);
    }
  } else {
    await mulaiSkriningBiasa(guestJid, teks);
  }
}

/**
 * Skrining 3 langkah biasa (tanpa AI).
 */
async function mulaiSkriningBiasa(guestJid, teks) {
  stateScreening[guestJid] = { step: 1, pesanPertama: teks };
  await kirimPesan(guestJid,
    `Selamat datang!\n\nAnda menghubungi sistem komunikasi privat ${NAMA_KELUARGA}.\nMohon jawab beberapa pertanyaan singkat.\n\n` +
    `*Pertanyaan 1 dari 3:*\nSiapa *Nama Lengkap* Anda?`
  );
}

/**
 * Proses ketika Gemini mendeteksi tamu ingin menghubungi anggota keluarga.
 * Transisi ke skrining langkah 1 (dengan target keluarga sudah diketahui).
 */
async function prosesNiatHubungiKeluarga(guestJid, alias, namaKetik, pesanPertama) {
  const keluarga = cariKeluarga(alias);
  if (!keluarga) {
    // Nama tidak ditemukan di database
    await kirimPesan(guestJid, `ⓘ Maaf, tidak ada anggota keluarga dengan nama tersebut yang terdaftar.`);
    return;
  }

  const namaTampil = formatSebutan(namaKetik || alias);

  stateScreening[guestJid] = {
    step: 1,
    targetKeluarga: keluarga,
    namaPanggilanKeluarga: namaTampil,
    pesanPertama: pesanPertama || '',
  };

  await kirimPesan(guestJid,
    `Baik. Untuk kami sambungkan ke *${namaTampil}*, kami perlu mencatat beberapa informasi.\n\n` +
    `*Pertanyaan 1:*\nSiapa *Nama Lengkap* Anda?`
  );
}

/**
 * Proses jawaban skrining tamu (langkah 1, 2, 3).
 */
async function prosesJawabanSkrining(guestJid, teks) {
  const state = stateScreening[guestJid];
  const teksTrim = teks.trim();
  const teksLower = teksTrim.toLowerCase();

  // Batal kapan saja
  if (teksLower === 'batal') {
    const berhasil = await batalkanTamuMenunggu(guestJid);
    if (berhasil) {
      stateScreening[guestJid] = { step: 0, pesanPertama: '' };
      delete riwayatChatAI[guestJid];
      await kirimPesan(guestJid, `ⓘ Permintaan Anda telah dibatalkan.`);
    } else {
      await kirimPesan(guestJid, `ⓘ Permintaan sedang diproses dan tidak dapat dibatalkan lagi.`);
    }
    return;
  }

  // ── STEP 0: Mode AI chat ──
  if (state.step === 0) {
    if (!geminiEnabled) {
      await mulaiSkriningBiasa(guestJid, teksTrim);
      return;
    }

    // Verifikasi teks (cegah spam/random)
    const valid = await verifikasiTeksBermakna(teksTrim);
    if (!valid) {
      await kirimPesan(guestJid, `ⓘ Mohon ketik pesan yang bermakna dalam bahasa Indonesia atau Inggris.`);
      return;
    }

    // Cek link dalam pesan
    const cekLink = await cekLinkDalamTeks(teksTrim);
    if (!cekLink.aman) {
      await kirimPesan(guestJid, `ⓘ Link yang Anda kirim tidak dapat diteruskan karena terdeteksi berpotensi berbahaya.`);
      console.log(`[KEAMANAN] Link berbahaya dari ${guestJid}: ${cekLink.linkBerbahaya}`);
      return;
    }

    const hasil = await chatGeminiTamu(guestJid, teksTrim);
    if (!hasil) {
      await kirimPesan(guestJid, `ⓘ Maaf, sistem sedang mengalami gangguan. Silakan coba beberapa saat lagi.`);
      return;
    }

    await kirimPesan(guestJid, hasil.teks);

    if (hasil.hubungiAlias) {
      await prosesNiatHubungiKeluarga(guestJid, hasil.hubungiAlias, hasil.hubungiNamaKetik, state.pesanPertama);
    }
    return;
  }

  // ── STEP 1: Nama lengkap ──
  if (state.step === 1) {
    if (teksTrim.length < 2) {
      await kirimPesan(guestJid, `ⓘ Mohon masukkan nama lengkap Anda (minimal 2 karakter).`);
      return;
    }

    // Verifikasi nama mengandung kata bermakna
    const valid = await verifikasiTeksBermakna(teksTrim);
    if (!valid) {
      await kirimPesan(guestJid, `ⓘ Mohon masukkan nama lengkap Anda yang sebenarnya.`);
      return;
    }

    const namaFormatted = formatSebutan(teksTrim);
    state.namaLengkap = namaFormatted;

    if (state.targetKeluarga) {
      // Target keluarga sudah diketahui dari AI — lewati step 2, langsung step 3
      state.step = 3;
      const namaTampil = state.namaPanggilanKeluarga || state.targetKeluarga.panggilanUtama;
      await kirimPesan(guestJid,
        `Terima kasih, *${namaFormatted}*.\n\n*Pertanyaan 2:*\nApa keperluan Anda dengan *${namaTampil}*?`
      );
    } else {
      // Belum tahu target keluarga — tanya step 2
      state.step = 2;
      const daftar = DATABASE_KELUARGA.map(a => `- ${a.panggilanUtama}`).join('\n');
      await kirimPesan(guestJid,
        `Terima kasih, *${namaFormatted}*.\n\n*Pertanyaan 2 dari 3:*\nSiapa yang ingin Anda hubungi?\n\n${daftar}`
      );
    }
    return;
  }

  // ── STEP 2: Siapa yang ingin ditemui ──
  if (state.step === 2) {
    const keluarga = cariKeluarga(teksTrim);
    if (!keluarga) {
      const daftar = DATABASE_KELUARGA.map(a => `- ${a.panggilanUtama}`).join('\n');
      await kirimPesan(guestJid,
        `ⓘ Maaf, tidak ditemukan anggota keluarga dengan nama "${teksTrim}".\nSilakan pilih dari daftar berikut:\n\n${daftar}`
      );
      return;
    }

    state.targetKeluarga = keluarga;
    // Simpan nama panggilan seperti yang diketik tamu (bukan nama resmi)
    state.namaPanggilanKeluarga = formatSebutan(teksTrim);
    state.step = 3;

    await kirimPesan(guestJid,
      `*Pertanyaan 3 dari 3:*\nApa keperluan Anda dengan *${state.namaPanggilanKeluarga}*?`
    );
    return;
  }

  // ── STEP 3: Keperluan ──
  if (state.step === 3) {
    if (teksTrim.length < 3) {
      await kirimPesan(guestJid, `ⓘ Mohon jelaskan keperluan Anda dengan lebih lengkap.`);
      return;
    }

    // Verifikasi keperluan mengandung kata bermakna
    const valid = await verifikasiTeksBermakna(teksTrim);
    if (!valid) {
      await kirimPesan(guestJid, `ⓘ Mohon jelaskan keperluan Anda dengan kata-kata yang jelas.`);
      return;
    }

    state.tujuan = teksTrim;
    state.step = 'selesai';

    const kode = buatKodeTamu(state.namaLengkap);
    const tamuData = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      namaPanggilanKeluarga: state.namaPanggilanKeluarga,
      kode,
      pesanPertama: state.pesanPertama || '',
    };

    // Simpan ke riwayat
    riwayatTamu[kode] = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      targetKeluargaNomor: state.targetKeluarga.nomor,
      namaPanggilanKeluarga: state.namaPanggilanKeluarga,
    };

    await kirimPesan(guestJid,
      `ⓘ Terima kasih, *${state.namaLengkap}*. Permintaan Anda telah kami catat.\n` +
      `Mohon tunggu, kami sedang menghubungi *${state.namaPanggilanKeluarga}*.\n\n` +
      `_Ketik *Batal* untuk membatalkan permintaan Anda._`
    );

    await mintaKonfirmasiAtauAntre(state.targetKeluarga.nomor, tamuData);
    return;
  }
}

// ============================================================
// 10. FUNGSI KELUARGA
// ============================================================

/**
 * Keluarga ingin menghubungi nomor baru via "Chat <nomor>".
 * Sekarang meminta nama tampilan terlebih dahulu.
 */
async function tanganiPermintaanChatKeluar(familyJid, keluarga, nomorInput) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const bridgeAktif = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    if ((bridgeAktif && bridgeAktif.active) || konfirmasiAktif) {
      await kirimPesan(familyJid, `ⓘ Selesaikan dulu sesi yang sedang berjalan sebelum menghubungi kontak baru.`);
      return;
    }

    const jidTujuan = buatJidDariNomor(nomorInput);
    if (!jidTujuan) {
      await kirimPesan(familyJid, `ⓘ Format nomor tidak valid. Contoh: Chat 08123456789`);
      return;
    }

    if (jidTujuan === keluarga.nomor || jidTujuan === `${NOMOR_BOT}@s.whatsapp.net`) {
      await kirimPesan(familyJid, `ⓘ Tidak bisa menghubungi nomor sendiri atau nomor bot.`);
      return;
    }

    // Simpan nomor sementara, tunggu nama tampilan dari keluarga
    stateChatKeluarMenungguNama[familyJid] = { nomorInput: nomorInput.trim(), jidTujuan };
    await kirimPesan(familyJid,
      `Nama apa yang ingin ditampilkan kepada kontak *${'+' + jidTujuan.replace('@s.whatsapp.net', '')}*?\n` +
      `(Nama ini yang akan muncul saat Anda berkomunikasi dengan mereka)`
    );
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/**
 * Keluarga sudah memberikan nama tampilan — lanjutkan koneksi chat keluar.
 */
async function mulaiChatKeluar(familyJid, keluarga, jidTujuan, namaTampil) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const nomorTampil = '+' + jidTujuan.replace('@s.whatsapp.net', '');
    await kirimPesan(familyJid, `⌛︎ Menghubungkan Anda ke *${nomorTampil}*, mohon menunggu sebentar.`);

    // Kirim salam pembuka ke kontak (tanpa menyebut nama anggota keluarga)
    await kirimPesan(jidTujuan,
      `Halo! Saya ${NAMA_BOT}, sistem komunikasi privat ${NAMA_KELUARGA}.\n` +
      `ⓘ Anda terhubung dengan saluran komunikasi privat. Silakan tunggu sebentar.`
    );
    await delay(1500);
    await kirimPesan(jidTujuan, `ⓘ Anda telah terhubung. Silakan mulai percakapan.`);

    await mulaiLiveChatBridge(
      familyJid,
      { guestJid: jidTujuan, namaLengkap: nomorTampil, tujuan: 'Dihubungi oleh keluarga', namaPanggilanKeluarga: namaTampil },
      { kirimPesanKeGuest: false }
    );
    console.log(`[CHAT-KELUAR] ${namaTampil} (${familyJid}) menghubungi ${jidTujuan}`);
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/**
 * Keluarga menghubungi balik tamu lama via kode tamu.
 */
async function tanganiPanggilBalik(familyJid, kodeInput, keluarga) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const bridgeAktif = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    if ((bridgeAktif && bridgeAktif.active) || konfirmasiAktif) {
      await kirimPesan(familyJid, `ⓘ Selesaikan dulu sesi/konfirmasi yang sedang berjalan.`);
      return;
    }

    const record = riwayatTamu[kodeInput];
    if (!record) {
      await kirimPesan(familyJid, `ⓘ Kode tamu "*${kodeInput}*" tidak ditemukan.`);
      return;
    }
    if (record.targetKeluargaNomor !== familyJid) {
      await kirimPesan(familyJid, `ⓘ Kode tamu ini bukan milik Anda.`);
      return;
    }

    await kirimPesan(record.guestJid,
      `ⓘ *${record.namaPanggilanKeluarga || keluarga.panggilanUtama}* menghubungi Anda kembali mengenai:\n_${record.tujuan}_`
    );
    await mulaiLiveChatBridge(familyJid, {
      guestJid: record.guestJid,
      namaLengkap: record.namaLengkap,
      tujuan: record.tujuan,
      namaPanggilanKeluarga: record.namaPanggilanKeluarga,
    });
  } finally {
    bridgeLock[familyJid] = false;
  }
}

// ============================================================
// 11. HANDLER PESAN UTAMA
// ============================================================

async function tandaiDibaca(message) {
  if (!sock || !message?.key) return;
  try {
    await sock.readMessages([message.key]);
  } catch (_) { /* abaikan error read receipt */ }
}

async function handlePesanMasuk(message) {
  const jid    = message.key?.remoteJid;
  const jidAlt = message.key?.remoteJidAlt;

  if (!jid || jid.endsWith('@g.us')) return; // abaikan grup
  if (message.key?.fromMe) return;           // abaikan pesan dari bot sendiri

  const msg = message.message;
  if (!msg) return;

  // Ekstrak teks dari berbagai jenis pesan
  const teks =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    '';

  const pesanMedia = apakahPesanMedia(msg);
  if (!teks && !pesanMedia) return; // abaikan pesan kosong/protokol

  const teksUpper = teks.trim().toUpperCase();
  const teksLower = teks.trim().toLowerCase();
  console.log(`[PESAN] ${jid}: "${pesanMedia ? labelJenisMedia(msg) : teks.substring(0, 80)}"`);

  // ── BLOK A: Anggota Keluarga ──────────────────────────────────────────────
  const keluargaPengirim = cariKeluargaByJid(jid, jidAlt);
  if (keluargaPengirim) {
    const familyJid = keluargaPengirim.nomor;
    const teksTrim  = teks.trim();

    // ── Cek apakah menunggu nama tampilan (Chat keluar) ──
    if (stateChatKeluarMenungguNama[familyJid] && !pesanMedia) {
      const { jidTujuan } = stateChatKeluarMenungguNama[familyJid];
      delete stateChatKeluarMenungguNama[familyJid];
      const namaTampil = formatSebutan(teksTrim || keluargaPengirim.panggilanUtama);
      await mulaiChatKeluar(familyJid, keluargaPengirim, jidTujuan, namaTampil);
      return;
    }

    // ── Panggil balik tamu lama via kode tamu ──
    if (/^#\d/.test(teksTrim)) {
      const dipilihDariAntrean = await pilihTamuDariAntreanByKode(familyJid, teksTrim);
      if (!dipilihDariAntrean) {
        await tanganiPanggilBalik(familyJid, teksTrim, keluargaPengirim);
      }
      return;
    }

    // ── Keluarga ingin chat ke nomor baru ──
    const cocokChat = teksTrim.match(/^chat\s+([\d+][\d+\-\s()]{6,})$/i);
    if (cocokChat) {
      await tanganiPermintaanChatKeluar(familyJid, keluargaPengirim, cocokChat[1]);
      return;
    }

    // ── Menunggu konfirmasi tamu ──
    if (konfirmasiPending[familyJid] && !bridgeLock[familyJid]) {
      bridgeLock[familyJid] = true;
      try {
        const pending = konfirmasiPending[familyJid];
        if (!pending) return;

        if (teksLower === 'y') {
          clearTimeout(pending.timer);
          konfirmasiPending[familyJid] = null;
          await mulaiLiveChatBridge(familyJid, pending);
          return;
        }
        if (teksLower === 'n') {
          clearTimeout(pending.timer);
          konfirmasiPending[familyJid] = null;
          await kirimPesan(pending.guestJid,
            `ⓘ Mohon maaf, *${pending.namaPanggilanKeluarga || keluargaPengirim.panggilanUtama}* sedang sibuk. Terima kasih.`
          );
          await kirimPesan(familyJid, `✓ Permintaan tamu telah ditolak.`);
          delete stateScreening[pending.guestJid];
          bridgeLock[familyJid] = false;
          await mintaKonfirmasiBerikutnya(familyJid);
          return;
        }

        const antreanSaatIni = antreanTamu[familyJid] || [];
        if (antreanSaatIni.length > 0) {
          await kirimDaftarTungguKeKeluarga(familyJid);
        } else {
          await kirimPesan(familyJid, `ⓘ Ada tamu menunggu. Ketik *Y* untuk menerima, *N* untuk menolak.`);
        }
        return;
      } finally {
        bridgeLock[familyJid] = false;
      }
    } else if (konfirmasiPending[familyJid]) {
      await kirimPesan(familyJid, `ⓘ Mohon tunggu sebentar lalu kirim ulang balasan Anda.`);
      return;
    }

    const bridge = stateBridge[familyJid];
    if (!bridge || !bridge.active) return;

    // ── N = mengakhiri sesi live chat (menggantikan EXIT) ──
    if (!pesanMedia && teksLower === 'n') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }

    // Tandai pesan keluarga sebagai dibaca
    await tandaiDibaca(message);

    pasangBridgeTimeout(familyJid);
    if (pesanMedia) {
      await teruskanPesanMedia(bridge.guestJid, message, `*${keluargaPengirim.panggilanUtama}:*`);
    } else {
      bufferDanKirimPesan(familyJid, bridge.guestJid, teksTrim, `*${keluargaPengirim.panggilanUtama}:*`);
    }
    return;
  }

  // ── BLOK B: Tamu / kontak yang dihubungi keluarga ─────────────────────────
  const nomorJidMasuk    = nomorDariJid(jid);
  const nomorJidAltMasuk = nomorDariJid(jidAlt);

  // Cek apakah tamu sedang dalam bridge aktif
  const bridgeEntry = Object.entries(stateBridge).find(([, val]) => {
    if (!val || !val.active) return false;
    const nomorBridge = nomorDariJid(val.guestJid);
    return nomorBridge === nomorJidMasuk || (nomorJidAltMasuk && nomorBridge === nomorJidAltMasuk);
  });

  if (bridgeEntry) {
    const [familyJid, bridgeVal] = bridgeEntry;

    // Tandai pesan tamu sebagai dibaca (read receipt)
    await tandaiDibaca(message);

    // Verifikasi file/link jika tamu mengirim media atau link
    if (pesanMedia) {
      const cekFilePesan = await verifikasiFile(message);
      if (!cekFilePesan.boleh) {
        await kirimPesan(jid, `ⓘ File yang Anda kirim tidak dapat diteruskan: ${cekFilePesan.alasan}`);
        const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
        const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';
        await kirimPesan(familyJid, `[KEAMANAN] File dari tamu *${stateScreening[jid]?.namaLengkap || 'Tamu'}* diblokir: ${cekFilePesan.alasan}`);
        console.log(`[KEAMANAN] File diblokir dari ${jid}: ${cekFilePesan.alasan}`);
        return;
      }
    } else if (teks) {
      const cekLinkMsg = await cekLinkDalamTeks(teks);
      if (!cekLinkMsg.aman) {
        await kirimPesan(jid, `ⓘ Link yang Anda kirim tidak dapat diteruskan karena terdeteksi berpotensi berbahaya.`);
        await kirimPesan(familyJid, `[KEAMANAN] Link berbahaya dari tamu *${stateScreening[jid]?.namaLengkap || 'Tamu'}*: ${cekLinkMsg.linkBerbahaya}`);
        console.log(`[KEAMANAN] Link berbahaya dari ${jid}: ${cekLinkMsg.linkBerbahaya}`);
        return;
      }
    }

    const namaLabel = stateScreening[jid]?.namaLengkap || nomorJidMasuk || 'Tamu';

    pasangBridgeTimeout(familyJid);
    if (pesanMedia) {
      await teruskanPesanMedia(familyJid, message, `*${namaLabel}:*`);
    } else {
      bufferDanKirimPesan(jid, familyJid, teks, `*${namaLabel}:*`);
    }
    return;
  }

  // ── BLOK C: Tamu dalam antrean ────────────────────────────────────────────
  const dalamAntrean = Object.values(antreanTamu).some(a => a?.some(t => t.guestJid === jid));
  if (dalamAntrean) {
    for (const [, antrean] of Object.entries(antreanTamu)) {
      const posisi = antrean?.findIndex(t => t.guestJid === jid) + 1;
      if (posisi > 0) {
        await kirimPesan(jid, `⌛︎ Anda masih di antrean posisi *#${posisi}*. Mohon bersabar.\n_Ketik *Batal* untuk membatalkan._`);
        break;
      }
    }
    return;
  }

  // ── BLOK D: Tamu dalam konfirmasi menunggu ────────────────────────────────
  const dalamKonfirmasi = Object.values(konfirmasiPending).some(p => p?.guestJid === jid);
  if (dalamKonfirmasi) {
    if (teksLower === 'batal') {
      const berhasil = await batalkanTamuMenunggu(jid);
      if (berhasil) {
        stateScreening[jid] = { step: 0, pesanPertama: '' };
        delete riwayatChatAI[jid];
        await kirimPesan(jid, `ⓘ Baik, permintaan Anda telah dibatalkan.`);
      } else {
        await kirimPesan(jid, `ⓘ Permintaan Anda sedang diproses dan tidak dapat dibatalkan lagi.`);
      }
    } else {
      await kirimPesan(jid, `⌛︎ Formulir sudah diterima. Mohon tunggu giliran Anda.\n_Ketik *Batal* untuk membatalkan._`);
    }
    return;
  }

  // ── BLOK E: Deteksi Kurir ─────────────────────────────────────────────────
  const sedangSkrining = stateScreening[jid] && stateScreening[jid].step !== 'selesai' && stateScreening[jid].step !== 0;
  const deteksi = sedangSkrining ? null : deteksiKurir(teks);
  if (deteksi) {
    console.log(`[KURIR] Terdeteksi dari ${jid}. Kurir: ${deteksi.namaKurir}`);
    if (deteksi.targetKeluarga) {
      const k = deteksi.targetKeluarga;
      await kirimPesan(k.nomor,
        `[NOTIFIKASI PAKET]\n\nKurir *${deteksi.namaKurir}*\nPesan kurir:\n_${teks}_\n\nKontak: ${jid.replace('@s.whatsapp.net', '')}`
      );
      await kirimPesan(jid, `✓ *Konfirmasi Diterima*\nPesan untuk *${k.namaResmi}* diterima. Berikut kontak yang bisa dihubungi langsung:`);
      await delay(500);
      await kirimKontakVCard(jid, k);
    } else {
      await kirimPesan(jid, `✓ Pesan kurir diterima. Mohon sebutkan nama penerima paket.`);
      for (const anggota of DATABASE_KELUARGA) {
        await kirimPesan(anggota.nomor,
          `[NOTIFIKASI PAKET]\nKurir *${deteksi.namaKurir}* -- nama penerima tidak terdeteksi.\n_${teks}_`
        );
      }
    }
    return;
  }

  // ── BLOK F: Skrining / AI Chat ────────────────────────────────────────────
  const screenState = stateScreening[jid];

  if (!screenState) {
    // Tamu baru
    console.log(`[GATEKEEPER] Tamu baru: ${jid}`);

    // Verifikasi file jika tamu pertama kali kirim media
    if (pesanMedia) {
      const cekFile = await verifikasiFile(message);
      if (!cekFile.boleh) {
        await kirimPesan(jid, `ⓘ File yang Anda kirim tidak dapat diterima: ${cekFile.alasan}`);
        return;
      }
    }

    await mulaiInteraksiTamu(jid, teks || labelJenisMedia(msg));
    return;
  }

  if (screenState.step === 'selesai') {
    await kirimPesan(jid, `ⓘ Formulir sudah diterima. Mohon tunggu giliran Anda.\n_Ketik *Batal* untuk membatalkan._`);
    return;
  }

  // Tamu dalam proses skrining — verifikasi file/link jika ada media
  if (pesanMedia) {
    const cekFile = await verifikasiFile(message);
    if (!cekFile.boleh) {
      await kirimPesan(jid, `ⓘ File yang Anda kirim tidak dapat diterima: ${cekFile.alasan}`);
      return;
    }
    // Media diterima tapi tidak relevan untuk skrining — abaikan
    if (screenState.step === 0) {
      // Tamu di mode AI chat — forward media
      // (Catatan: Gemini tidak bisa proses media secara langsung di sini)
      await kirimPesan(jid, `ⓘ Maaf, saya hanya dapat memproses pesan teks. Silakan ketik pertanyaan Anda.`);
    }
    return;
  }

  await prosesJawabanSkrining(jid, teks);
}

// ============================================================
// 12. KONEKSI BAILEYS
// ============================================================

async function mulaiKoneksi() {
  sudahMintaPairingCode = false;

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let versiWA;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    versiWA = version;
    console.log(`[VERSI] Menggunakan WA Web v${version.join('.')} (terbaru: ${isLatest})`);
  } catch (err) {
    console.error('[VERSI] Gagal ambil versi terbaru, pakai default bawaan Baileys:', err.message);
  }

  sock = makeWASocket({
    auth: authState,
    version: versiWA,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    defaultQueryTimeoutMs: 0,
    qrTimeout: 300000,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Pairing Code ──────────────────────────────────────────────────────────
  if (!authState.creds.registered && !sudahMintaPairingCode) {
    sudahMintaPairingCode = true;
    console.log('[PAIRING] Meminta kode pairing (1,5 detik)...');
    await delay(1500);
    if (!sock) return;

    try {
      const nomorBersih = NOMOR_BOT.replace(/[^0-9]/g, '');
      const pairingCode = await sock.requestPairingCode(nomorBersih);

      console.log('\n+------------------------------------------+');
      console.log('|       KODE PAIRING WHATSAPP              |');
      console.log('+------------------------------------------+');
      console.log(`|  KODE: ${pairingCode}                    |`);
      console.log('+------------------------------------------+');
      console.log('|  1. Buka WhatsApp di HP                  |');
      console.log('|  2. Pengaturan -> Perangkat Tertaut       |');
      console.log('|  3. Tautkan dengan Nomor Telepon          |');
      console.log('|  4. Masukkan kode di atas                |');
      console.log('+------------------------------------------+\n');
    } catch (err) {
      console.error('[PAIRING] Gagal minta kode:', err.message);
      sudahMintaPairingCode = false;
    }
  }

  // ── Koneksi ──────────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('\n[KONEKSI] Bot terhubung ke WhatsApp!\n');
      sedangReconnect = false;
      pernahTerhubung = true;
      percobaanPairingGagal = 0;
    }

    if (connection === 'close') {
      const statusKode = lastDisconnect?.error?.output?.statusCode;
      const alasan = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusKode) || `Kode ${statusKode}`;
      console.log(`[KONEKSI] Terputus: ${alasan}`);

      sock.ev.removeAllListeners();
      sock = null;

      if (statusKode === DisconnectReason.loggedOut) {
        if (!pernahTerhubung) {
          // loggedOut saat proses pairing = sesi pairing gagal/dibatalkan.
          // Bersihkan auth dan coba pairing ulang otomatis, dengan backoff
          // bertahap agar tidak memicu rate-limit WhatsApp saat gagal berkali-kali.
          percobaanPairingGagal += 1;
          const jedaDetik = Math.min(5 * percobaanPairingGagal, 60);
          console.log(`[PAIRING] Sesi pairing gagal (percobaan ke-${percobaanPairingGagal}). Membersihkan auth dan coba ulang dalam ${jedaDetik} detik...`);
          const fs = await import('fs/promises');
          await fs.rm(AUTH_DIR, { recursive: true, force: true });
          await delay(jedaDetik * 1000);
          mulaiKoneksi();
        } else {
          // loggedOut saat bot sudah beroperasi = pengguna sengaja logout dari HP.
          console.log('[KONEKSI] Logged out oleh pengguna. Bot berhenti.');
          process.exit(1);
        }
        return;
      }

      if (!sedangReconnect) {
        sedangReconnect = true;
        console.log('[KONEKSI] Reconnect dalam 5 detik...');
        await delay(5000);
        sedangReconnect = false;
        mulaiKoneksi();
      }
    }
  });

  // ── Pesan Masuk ──────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handlePesanMasuk(message);
      } catch (err) {
        console.error('[ERROR] Proses pesan gagal:', err.message);
      }
    }
  });

  // ── Panggilan Masuk — Tolak Otomatis ─────────────────────────────────────
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      if (call.status === 'offer') {
        console.log(`[PANGGILAN] Panggilan masuk dari ${call.from} — ditolak otomatis.`);
        try {
          await sock.rejectCall(call.id, call.from);
        } catch (err) {
          console.error('[PANGGILAN] Gagal tolak panggilan:', err.message);
        }
        // Kirim pesan ke pemanggil
        await kirimPesan(call.from,
          `ⓘ Maaf, sistem ini tidak dapat menerima panggilan telepon.\n` +
          `Silakan kirim pesan teks jika ingin menghubungi kami.`
        );
        // Beri tahu anggota keluarga
        for (const anggota of DATABASE_KELUARGA) {
          await kirimPesan(anggota.nomor,
            `[PANGGILAN MASUK]\nAda panggilan dari *${call.from.replace('@s.whatsapp.net', '')}*.\nPanggilan otomatis ditolak dan penelepon diberi tahu.`
          );
        }
      }
    }
  });

  // ── Reaksi Pesan (dalam Bridge) ───────────────────────────────────────────
  sock.ev.on('messages.reaction', async (reactions) => {
    for (const reaction of reactions) {
      try {
        const reactorJid = reaction.key?.remoteJid;
        if (!reactorJid || reaction.key?.fromMe) continue;

        const emoji = reaction.reaction?.text || '';
        const nomorReactor = nomorDariJid(reactorJid);

        // Cari bridge yang melibatkan JID ini
        // Cek apakah reaktor adalah keluarga
        const keluargaReactor = cariKeluargaByJid(reactorJid, null);
        if (keluargaReactor) {
          const bridge = stateBridge[keluargaReactor.nomor];
          if (bridge && bridge.active && emoji) {
            await kirimPesan(bridge.guestJid, `[Reaksi dari ${keluargaReactor.panggilanUtama}]: ${emoji}`);
          }
          continue;
        }

        // Cek apakah reaktor adalah tamu dalam bridge
        const bridgeEntry = Object.entries(stateBridge).find(([, val]) => {
          if (!val || !val.active) return false;
          return nomorDariJid(val.guestJid) === nomorReactor;
        });
        if (bridgeEntry && emoji) {
          const [familyJid] = bridgeEntry;
          const namaLabel = stateScreening[reactorJid]?.namaLengkap || nomorReactor || 'Tamu';
          await kirimPesan(familyJid, `[Reaksi dari ${namaLabel}]: ${emoji}`);
        }
      } catch (err) {
        console.error('[REAKSI] Error proses reaksi:', err.message);
      }
    }
  });

  // ── Pesan Diubah/Diedit (dalam Bridge) ───────────────────────────────────
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      try {
        if (!update.update?.message) continue;
        const senderJid = update.key?.remoteJid;
        if (!senderJid || update.key?.fromMe) continue;

        // Cek apakah ini edit pesan (mengandung editedMessage atau protocolMessage)
        const editedMsg =
          update.update.message?.editedMessage ||
          update.update.message?.protocolMessage?.editedMessage;
        if (!editedMsg) continue;

        const teksBaru =
          editedMsg.conversation ||
          editedMsg.extendedTextMessage?.text ||
          '';
        if (!teksBaru) continue;

        const nomorSender = nomorDariJid(senderJid);

        // Cek keluarga
        const keluargaSender = cariKeluargaByJid(senderJid, null);
        if (keluargaSender) {
          const bridge = stateBridge[keluargaSender.nomor];
          if (bridge && bridge.active) {
            await kirimPesan(bridge.guestJid, `*${keluargaSender.panggilanUtama}* [pesan diubah]: ${teksBaru}`);
          }
          continue;
        }

        // Cek tamu
        const bridgeEntry = Object.entries(stateBridge).find(([, val]) => {
          if (!val || !val.active) return false;
          return nomorDariJid(val.guestJid) === nomorSender;
        });
        if (bridgeEntry) {
          const [familyJid] = bridgeEntry;
          const namaLabel = stateScreening[senderJid]?.namaLengkap || nomorSender || 'Tamu';
          await kirimPesan(familyJid, `*${namaLabel}* [pesan diubah]: ${teksBaru}`);
        }
      } catch (err) {
        console.error('[UPDATE] Error proses update pesan:', err.message);
      }
    }
  });
}

// ============================================================
// 13. ENTRY POINT
// ============================================================

console.log('+------------------------------------------+');
console.log('|    WHATSAPP GATEKEEPER BOT DIMULAI       |');
console.log(`|    Nomor Bot: ${NOMOR_BOT.padEnd(26)} |`);
console.log(`|    Gemini AI: ${geminiEnabled ? 'AKTIF                     ' : 'NONAKTIF (set GEMINI_API_KEY)'} |`);
console.log('+------------------------------------------+\n');

mulaiKoneksi().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

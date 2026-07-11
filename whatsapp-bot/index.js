/**
 * ============================================================
 *  WHATSAPP GATEKEEPER BOT
 *  Sistem Penyaring Tamu Otomatis untuk WhatsApp Rumah
 *  Menggunakan: @whiskeysockets/baileys v7 (NPM murni, tanpa git URL)
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

// Kata kunci konten pesan kurir (minimal 3 harus ada)
const KATA_KUNCI_KURIR = ['dari', 'pengirim', 'tujuan', 'kepada', 'resi', 'nomor resi', 'alamat', 'paket'];

// Ekstensi file yang DIIZINKAN
const EKSTENSI_DIIZINKAN = ['.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv'];
// Ekstensi yang DIBLOKIR
const EKSTENSI_DIBLOKIR  = ['.apk', '.exe', '.bat', '.sh', '.cmd', '.msi', '.dmg', '.deb', '.rpm', '.ipa'];

// ============================================================
// 3. KONFIGURASI (env var — wajib diset di Railway/VPS)
// ============================================================

/**
 * NOMOR_BOT  : (WAJIB) Nomor WhatsApp bot tanpa + (contoh: 6285186655283)
 *              Set sebagai environment variable di Railway/Replit/VPS.
 * AUTH_DIR   : Path folder sesi auth (default: auth_info_baileys).
 *              Di Railway dengan volume, set ke path mount volume
 *              agar sesi tidak hilang saat redeploy.
 */
const NOMOR_BOT = process.env.NOMOR_BOT || '';
const AUTH_DIR  = process.env.AUTH_DIR  || 'auth_info_baileys';

/**
 * NAMA_BOT      : Nama persona bot saat memperkenalkan diri ke kontak yang
 *                 dihubungi keluarga lewat perintah "Chat <nomor>".
 * NAMA_KELUARGA : Nama keluarga/rumah yang disebutkan bot ke kontak tersebut.
 * GEMINI_API_KEY: (Opsional) Key Gemini AI dari Google AI Studio.
 *                 Jika tidak diset, bot pakai skrining 3 langkah biasa.
 */
const NAMA_BOT       = process.env.NAMA_BOT       || 'Islah';
const NAMA_KELUARGA  = process.env.NAMA_KELUARGA  || 'Dil Familie';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Validasi wajib — fail-fast agar kesalahan konfigurasi terdeteksi segera
if (!NOMOR_BOT || !/^\d{10,15}$/.test(NOMOR_BOT.trim())) {
  console.error('[CONFIG] ❌ NOMOR_BOT tidak diset atau format tidak valid.');
  console.error('[CONFIG]    Set environment variable NOMOR_BOT=628xxxxxxxxxx (tanpa +, 10-15 digit)');
  process.exit(1);
}

// ============================================================
// 4. SETUP GEMINI AI (dynamic import — bot tetap jalan tanpa paket ini)
// ============================================================

let geminiModel   = null;
let geminiEnabled = false;

if (GEMINI_API_KEY) {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel   = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    geminiEnabled = true;
    console.log('[GEMINI] Gemini AI aktif.');
  } catch (err) {
    console.error('[GEMINI] Gagal inisialisasi (paket tidak tersedia atau API key salah):', err.message);
  }
} else {
  console.log('[GEMINI] GEMINI_API_KEY tidak diset. Mode AI dinonaktifkan, pakai skrining 3 langkah biasa.');
}

/** Daftar nama keluarga untuk system prompt Gemini */
const daftarNamaKeluarga = DATABASE_KELUARGA.map(a =>
  `${a.panggilanUtama} (alias: ${a.alternatifPanggilan.join(', ')})`
).join('; ');

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

const SYSTEM_PROMPT_VERIFIKASI = `Anda adalah validator teks. Tentukan apakah teks berikut mengandung kata atau kalimat bermakna dalam bahasa Indonesia atau Inggris.
Teks dianggap VALID jika mengandung setidaknya 1 kata nyata yang bermakna dan bukan rangkaian huruf/angka acak.
Teks dianggap TIDAK VALID jika semua huruf acak tanpa makna, hanya angka atau simbol, atau terlalu pendek (kurang dari 2 karakter).
Jawab HANYA dengan: VALID atau TIDAK_VALID`;

const SYSTEM_PROMPT_VERIFIKASI_LINK = `Anda adalah sistem keamanan link. Analisis URL berikut dan tentukan apakah aman.
URL dianggap BERBAHAYA jika terlihat seperti phishing, mengandung kata kunci berbahaya, atau domain sangat mencurigakan.
URL dianggap AMAN jika domain resmi yang dikenal (google.com, youtube.com, tokopedia.com, shopee.co.id, dll.).
Jawab HANYA dengan: AMAN atau BERBAHAYA`;

// ============================================================
// 5. STATE GLOBAL
// ============================================================

/** State skrining: { [guestJid]: { step, namaLengkap?, targetKeluarga?, tujuan?, pesanPertama? } }
 *  step: 0 = mode AI chat, 1/2/3 = langkah skrining, 'selesai' = menunggu keluarga
 */
const stateScreening = {};

/** Riwayat percakapan AI per tamu: { [guestJid]: Array<{role, parts}> } */
const riwayatChatAI = {};

/** Bridge aktif per keluarga: { [familyJid]: { guestJid, active } | null } */
const stateBridge = {};

/**
 * Konfirmasi menunggu per keluarga: { [familyJid]: { guestJid, namaLengkap, tujuan } | null }
 * Diisi saat tamu selesai skrining dan bot sedang menanyakan ke anggota
 * keluarga apakah ia ingin membalas pesan tamu tersebut. Tamu TIDAK langsung
 * terhubung — baru terhubung setelah keluarga membalas "YA".
 */
const konfirmasiPending = {};

/** Kunci atomik per keluarga untuk cegah race condition: { [familyJid]: boolean } */
const bridgeLock = {};

/** Antrean tamu FIFO: { [familyJid]: Array<{ guestJid, namaLengkap, tujuan }> } */
const antreanTamu = {};

/**
 * Riwayat semua tamu yang pernah menghubungi, dikunci dengan "kode tamu"
 * (mis. "#1David09072026"). Dipakai agar anggota keluarga bisa menghubungi
 * balik tamu lama kapan saja — walau sudah melewati banyak sesi lain —
 * cukup dengan mengirim kode tamunya ke bot.
 * { [kodeTamu]: { guestJid, namaLengkap, tujuan, targetKeluargaNomor, dibuatPada } }
 */
const riwayatTamu = {};

// Nomor urut kode tamu — reset otomatis ke 0 setiap hari (lihat buatKodeTamu).
const kodeTamuHarian = { tanggal: null, counter: 0 };

/**
 * State "Chat keluar" menunggu nama tampilan:
 * { [familyJid]: { nomorInput, jidTujuan } }
 */
const stateChatKeluarMenungguNama = {};

// Batas waktu keluarga menjawab permintaan konfirmasi sebelum otomatis
// dianggap "sibuk" dan tamu diberi tahu tidak dapat dihubungi.
const BATAS_WAKTU_KONFIRMASI_MS = 20 * 60 * 1000; // 20 menit

/** Timer tidak-aktif per sesi live chat: { [familyJid]: timeoutHandle } */
const stateBridgeTimer = {};

// Batas waktu tidak ada aktivitas pesan selama sesi live chat sebelum sesi
// otomatis diakhiri (berlaku untuk kedua arah: keluarga <-> lawan bicara).
const BATAS_WAKTU_BRIDGE_MS = 10 * 60 * 1000; // 10 menit

/** Buffer debounce: { [`${from}=>${to}`]: { timer, messages[] } | null } */
const messageBuffer = {};

// Referensi socket aktif (satu instance)
let sock = null;

// Guard pairing: mencegah requestPairingCode dipanggil lebih dari sekali
let sudahMintaPairingCode = false;

// Guard reconnect: mencegah loop ganda
let sedangReconnect = false;

// Apakah bot pernah berhasil terhubung penuh (connection: 'open')?
// Dipakai untuk membedakan loggedOut-saat-pairing vs loggedOut-saat-operasional.
let pernahTerhubung = false;

// Hitung percobaan pairing gagal berturut-turut — dipakai untuk backoff
// agar tidak membombardir server WA dengan requestPairingCode (bisa memicu
// rate-limit sementara dari WhatsApp, yang tampak seperti "kode selalu salah").
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

/** Jenis-jenis pesan WA yang dianggap "media/fitur lain" (bukan teks biasa). */
function apakahPesanMedia(msg) {
  return !!(
    msg?.imageMessage || msg?.videoMessage || msg?.audioMessage ||
    msg?.documentMessage || msg?.documentWithCaptionMessage || msg?.stickerMessage ||
    msg?.locationMessage || msg?.liveLocationMessage ||
    msg?.contactMessage || msg?.contactsArrayMessage ||
    msg?.gifMessage
  );
}

/** Label singkat jenis media, dipakai di log & sebagai fallback teks caption kosong. */
function labelJenisMedia(msg) {
  if (msg?.stickerMessage)   return '[Stiker]';
  if (msg?.imageMessage)     return '[Gambar]';
  if (msg?.videoMessage)     return msg.videoMessage.gifPlayback ? '[GIF]' : '[Video]';
  if (msg?.audioMessage)     return msg.audioMessage.ptt ? '[Pesan Suara]' : '[Audio]';
  if (msg?.documentMessage || msg?.documentWithCaptionMessage) return '[Dokumen]';
  if (msg?.stickerMessage)   return '[Stiker]';
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

/**
 * Teruskan pesan APA ADANYA (gambar, video, voice note, dokumen, stiker,
 * lokasi, kontak, dll.) dari satu sesi live chat ke sisi lainnya, memakai
 * fitur forward bawaan Baileys agar tidak perlu unduh+unggah ulang manual
 * untuk tiap jenis media. Label pengirim dikirim sebagai pesan teks singkat
 * terlebih dahulu (media hasil forward tidak bisa disisipi label langsung).
 */
async function teruskanPesanMedia(toJid, message, labelPengirim) {
  if (!sock) return;
  try {
    if (labelPengirim) {
      await kirimPesan(toJid, `${labelPengirim} ${labelJenisMedia(message.message)}`);
    }
    await sock.sendMessage(toJid, { forward: message });
  } catch (err) {
    console.error(`[ERROR] Gagal meneruskan media ke ${toJid}:`, err.message);
  }
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

function cariKeluarga(namaInput) {
  const input = namaInput.trim().toLowerCase();
  return DATABASE_KELUARGA.find(a =>
    a.alternatifPanggilan.some(alias => alias.toLowerCase() === input) ||
    a.panggilanUtama.toLowerCase() === input ||
    a.namaResmi.toLowerCase() === input
  ) || null;
}

// ── Dukungan JID @lid (WhatsApp privacy addressing) ──────────────────────
// WhatsApp kadang mengirim remoteJid sebagai `<id>@lid` (bukan nomor telepon
// asli `<nomor>@s.whatsapp.net`) untuk kontak yang memakai mode privasi baru.
// Saat itu terjadi, Baileys menyertakan `message.key.remoteJidAlt` berisi JID
// nomor telepon aslinya. Tanpa penanganan ini, anggota keluarga yang chat
// lewat @lid tidak akan terdeteksi sebagai keluarga (dianggap tamu asing,
// malah ditanyai formulir skrining 3 langkah).
function nomorDariJid(jid) {
  if (!jid) return null;
  return jidDecode(jid)?.user || null;
}

/** Cari data keluarga berdasarkan jid utama DAN jid alternatif (kasus @lid). */
function cariKeluargaByJid(jid, jidAlt) {
  const nomorJid = nomorDariJid(jid);
  const nomorAlt = nomorDariJid(jidAlt);
  return DATABASE_KELUARGA.find(a => {
    const nomorAnggota = nomorDariJid(a.nomor);
    return nomorAnggota === nomorJid || (nomorAlt && nomorAnggota === nomorAlt);
  }) || null;
}

/**
 * Buat kode tamu unik, format: #<nomorUrut><MAKS5HURUFNAMA><DDMMYYYY>
 * Contoh: nama "David Susanto" pada 09-07-2026, urutan ke-1 → #1DAVID09072026
 */
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

/** Ubah teks bebas jadi format "Title Case" untuk sebutan yang konsisten. */
function formatSebutan(teks) {
  return teks.trim().split(/\s+/)
    .map(kata => kata.charAt(0).toUpperCase() + kata.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Ubah input nomor bebas (mis. "08123456789", "+62 812-3456-789") menjadi
 * JID WhatsApp yang valid. Nomor lokal berawalan "0" otomatis dikonversi ke
 * kode negara "62" (Indonesia). Return null jika formatnya tidak masuk akal.
 */
function buatJidDariNomor(nomorInput) {
  let digit = (nomorInput || '').replace(/[^0-9]/g, '');
  if (!digit) return null;
  if (digit.startsWith('0')) digit = '62' + digit.slice(1);
  else if (!digit.startsWith('62')) digit = '62' + digit;
  if (digit.length < 10 || digit.length > 15) return null;
  return `${digit}@s.whatsapp.net`;
}

function deteksiKurir(teks) {
  const lower = teks.toLowerCase();
  const kataKunciDitemukan = KATA_KUNCI_KURIR.filter(k => lower.includes(k));
  if (kataKunciDitemukan.length < 3) return null;
  const kurirDitemukan = DATABASE_KURIR.find(k => lower.includes(k));
  if (!kurirDitemukan) return null;
  let targetKeluarga = null;
  for (const anggota of DATABASE_KELUARGA) {
    const semuaNama = [anggota.namaResmi, anggota.panggilanUtama, ...anggota.alternatifPanggilan];
    if (semuaNama.some(n => lower.includes(n.toLowerCase()))) {
      targetKeluarga = anggota;
      break;
    }
  }
  return { adalahKurir: true, namaKurir: kurirDitemukan.toUpperCase(), targetKeluarga };
}

// ============================================================
// 7. GEMINI AI FUNCTIONS
// ============================================================

/**
 * Panggil Gemini dengan satu prompt (tanpa riwayat).
 * Return string atau null jika gagal/tidak diaktifkan.
 */
async function tanyaGemini(prompt, systemInstruction) {
  if (!geminiEnabled || !geminiModel) return null;
  try {
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
 * Return { teks, hubungiAlias, hubungiNamaKetik } atau null jika gagal.
 */
async function chatGeminiTamu(guestJid, pesanTamu) {
  if (!geminiEnabled || !geminiModel) return null;
  try {
    if (!riwayatChatAI[guestJid]) riwayatChatAI[guestJid] = [];
    const riwayat = riwayatChatAI[guestJid];
    riwayat.push({ role: 'user', parts: [{ text: pesanTamu }] });

    const result = await geminiModel.generateContent({
      contents: riwayat,
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT_TAMU }] },
    });

    const responMentah = result.response.text().trim();

    const markerRegex = /\[HUBUNGI:([^\]:<>]+):([^\]:<>]+)\]/i;
    const markerMatch = responMentah.match(markerRegex);

    let hubungiAlias = null;
    let hubungiNamaKetik = null;
    let teks = responMentah;

    if (markerMatch) {
      hubungiAlias    = markerMatch[1].trim().toLowerCase();
      hubungiNamaKetik = markerMatch[2].trim();
      teks = responMentah.replace(markerRegex, '').trim();
    }

    riwayat.push({ role: 'model', parts: [{ text: responMentah }] });
    if (riwayat.length > 40) riwayatChatAI[guestJid] = riwayat.slice(-30);

    return { teks, hubungiAlias, hubungiNamaKetik };
  } catch (err) {
    console.error('[GEMINI] Error chat tamu:', err.message);
    return null;
  }
}

/** Verifikasi apakah teks mengandung kata bermakna. Return true jika valid. */
async function verifikasiTeksBermakna(teks) {
  if (!geminiEnabled) return true;
  if (!teks || teks.trim().length < 2) return false;
  try {
    const hasil = await tanyaGemini(`Teks: "${teks}"`, SYSTEM_PROMPT_VERIFIKASI);
    if (!hasil) return true;
    return hasil.includes('VALID') && !hasil.includes('TIDAK_VALID');
  } catch (err) {
    return true;
  }
}

/** Verifikasi apakah link aman. Return true jika aman. */
async function verifikasiLink(url) {
  if (!geminiEnabled) return true;
  try {
    const hasil = await tanyaGemini(`URL untuk diverifikasi: ${url}`, SYSTEM_PROMPT_VERIFIKASI_LINK);
    if (!hasil) return true;
    return hasil.includes('AMAN') && !hasil.includes('BERBAHAYA');
  } catch (err) {
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

  // Gambar/video: cek caption untuk link berbahaya
  if (geminiEnabled && (msg.imageMessage || msg.videoMessage)) {
    const caption = msg.imageMessage?.caption || msg.videoMessage?.caption || '';
    if (caption) {
      const links = (caption.match(/https?:\/\/[^\s]+/gi) || []);
      for (const link of links) {
        if (!await verifikasiLink(link)) {
          return { boleh: false, alasan: `Link dalam caption terdeteksi berbahaya: ${link}` };
        }
      }
    }
  }

  return { boleh: true, alasan: '' };
}

/** Deteksi dan verifikasi semua link dalam teks. Return { aman, linkBerbahaya }. */
async function cekLinkDalamTeks(teks) {
  if (!teks) return { aman: true, linkBerbahaya: '' };
  const links = (teks.match(/https?:\/\/[^\s]+/gi) || []);
  for (const link of links) {
    if (!await verifikasiLink(link)) {
      return { aman: false, linkBerbahaya: link };
    }
  }
  return { aman: true, linkBerbahaya: '' };
}

// ============================================================
// 8. PEMBATALAN BUFFER DEBOUNCE
// ============================================================

function batalkanBuffer(jidA, jidB) {
  for (const key of [`${jidA}=>${jidB}`, `${jidB}=>${jidA}`]) {
    if (messageBuffer[key]) {
      if (messageBuffer[key].timer) clearTimeout(messageBuffer[key].timer);
      messageBuffer[key] = null;
    }
  }
}

// ============================================================
// 9. LIVE CHAT BRIDGE, KONFIRMASI KELUARGA, & ANTREAN
// ============================================================

/**
 * Nyalakan/reset timer tidak-aktif 10 menit untuk sesi live chat sebuah
 * keluarga. Dipanggil setiap kali ada pesan yang berhasil diteruskan lewat
 * bridge (dari kedua arah) supaya sesi hanya berakhir jika BENAR-BENAR tidak
 * ada aktivitas, bukan sekadar durasi sesi yang panjang.
 */
function pasangBridgeTimeout(familyJid) {
  clearTimeout(stateBridgeTimer[familyJid]);
  stateBridgeTimer[familyJid] = setTimeout(() => {
    bridgeTimeout(familyJid).catch(err =>
      console.error('[BRIDGE] Gagal proses timeout tidak-aktif:', err.message)
    );
  }, BATAS_WAKTU_BRIDGE_MS);
}

/** Dipanggil otomatis jika sesi live chat tidak ada aktivitas selama 10 menit. */
async function bridgeTimeout(familyJid) {
  const bridge = stateBridge[familyJid];
  if (!bridge || !bridge.active) return;
  console.log(`[BRIDGE] Timeout 10 menit tanpa aktivitas untuk ${familyJid}, sesi diakhiri otomatis.`);
  await akhiriLiveChatBridge(familyJid, false, true);
}

async function mulaiLiveChatBridge(familyJid, tamuData, opts = {}) {
  const { guestJid, namaLengkap, namaPanggilanKeluarga } = tamuData;
  const { kirimPesanKeGuest = true, dimulaiOlehKeluarga = false } = opts;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';
  const panggilanUntukTamu = namaPanggilanKeluarga || panggilan;

  stateBridge[familyJid] = { guestJid, active: true, namaPanggilanKeluarga: panggilanUntukTamu, dimulaiOlehKeluarga };
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

/**
 * Tandai tamu sebagai "menunggu konfirmasi" keluarga (belum terhubung) dan
 * nyalakan timer 20 menit — jika keluarga tidak membalas sama sekali,
 * konfirmasiTimeout() akan otomatis memberi tahu tamu bahwa keluarga sedang
 * sibuk, sama seperti keluarga membalas "Abaikan". Tidak mengirim pesan apa
 * pun sendiri — pemanggil bertanggung jawab memanggil kirimPromptKonfirmasi()
 * setelahnya agar keluarga selalu melihat daftar lengkap tamu yang menunggu.
 */
function pasangKonfirmasiPending(familyJid, tamuData) {
  const timer = setTimeout(() => {
    konfirmasiTimeout(familyJid).catch(err =>
      console.error('[KONFIRMASI] Gagal proses timeout:', err.message)
    );
  }, BATAS_WAKTU_KONFIRMASI_MS);

  konfirmasiPending[familyJid] = { ...tamuData, timer };
}

/**
 * Kirim pesan ke keluarga berisi tamu yang sedang menunggu konfirmasi.
 */
async function kirimPromptKonfirmasi(familyJid) {
  const pending = konfirmasiPending[familyJid];
  if (!pending) return;

  const antrean = antreanTamu[familyJid] || [];
  if (antrean.length === 0) {
    const barisPesanPertama = pending.pesanPertama && pending.pesanPertama.trim()
      ? `\n_"${pending.pesanPertama}"_`
      : '';
    await kirimPesan(familyJid,
      `[TAMU MENUNGGU]\n\n*${pending.namaLengkap}* (*${pending.kode}*)\n_${pending.tujuan}_${barisPesanPertama}\n\n` +
      `Apakah Anda bersedia membalas pesan tamu ini?\nKetik *Y* untuk menerima.\nKetik *N* untuk menolak.`
    );
  } else {
    await kirimDaftarTungguKeKeluarga(familyJid);
  }
  console.log(`[KONFIRMASI] Menunggu jawaban untuk ${pending.namaLengkap} (${pending.kode})`);
}

/** Kirim daftar SEMUA tamu (konfirmasi pending + antrean) beserta kode masing-masing. */
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
      return `${i + 1}. *${t.kode}* — ${t.namaLengkap}\n   _${t.tujuan}_${barisPesanPertama}`;
    })
    .join('\n\n');

  await kirimPesan(familyJid,
    `[${semua.length} TAMU MENUNGGU BALASAN]\n\n${daftar}\n\n` +
    `Ketik *kode* tamu untuk membalas tamu tersebut (mis. *${semua[0].kode}*).\n` +
    `Atau ketik *Y* untuk menerima tamu pertama, *N* untuk menolak tamu pertama.`
  );
}

/** Dipanggil otomatis jika keluarga tidak membalas konfirmasi dalam 20 menit. */
async function konfirmasiTimeout(familyJid) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  let harusLanjutAntrean = false;
  try {
    const pending = konfirmasiPending[familyJid];
    if (!pending) return; // sudah dijawab (YA/Abaikan) sebelum timer berbunyi

    konfirmasiPending[familyJid] = null;
    harusLanjutAntrean = true;

    const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
    const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

    console.log(`[KONFIRMASI] Timeout 20 menit tanpa balasan dari ${panggilan} untuk ${pending.namaLengkap} (${pending.kode})`);
    await kirimPesan(pending.guestJid,
      `ⓘ Mohon maaf, *${pending.namaPanggilanKeluarga || panggilan}* sedang sibuk dan belum dapat dihubungi saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid,
      `⌛︎ Waktu konfirmasi (20 menit) habis. Permintaan tamu *${pending.namaLengkap}* (*${pending.kode}*) otomatis dianggap ditolak.`
    );
    delete stateScreening[pending.guestJid];
  } finally {
    bridgeLock[familyJid] = false;
  }
  if (harusLanjutAntrean) await mintaKonfirmasiBerikutnya(familyJid);
}

/**
 * Keluarga memilih membalas tamu tertentu yang SEDANG menunggu (baik yang
 * lagi ditanya konfirmasi maupun yang masih di antrean) lewat kode tamunya.
 */
async function pilihTamuDariAntreanByKode(familyJid, kodeInput) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const pending = konfirmasiPending[familyJid];
    if (pending && pending.kode === kodeInput) {
      clearTimeout(pending.timer);
      konfirmasiPending[familyJid] = null;
      await mulaiLiveChatBridge(familyJid, pending);
      return true;
    }

    const antrean = antreanTamu[familyJid] || [];
    const idx = antrean.findIndex(t => t.kode === kodeInput);
    if (idx === -1) return false;

    const [dipilih] = antrean.splice(idx, 1);
    if (pending) {
      clearTimeout(pending.timer);
      konfirmasiPending[familyJid] = null;
      antrean.unshift(pending);
    }
    await mulaiLiveChatBridge(familyJid, dipilih);
    return true;
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/**
 * Batalkan permintaan tamu yang MASIH menunggu (belum tersambung).
 * Return true jika permintaan ditemukan & dibatalkan.
 */
async function batalkanTamuMenunggu(guestJid) {
  let familyJid = Object.keys(konfirmasiPending)
    .find(f => konfirmasiPending[f]?.guestJid === guestJid);
  if (!familyJid) {
    familyJid = Object.keys(antreanTamu)
      .find(f => (antreanTamu[f] || []).some(t => t.guestJid === guestJid));
  }
  if (!familyJid) return false;

  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  let hapusDariPending = false;
  let ditemukan = false;
  let namaTamu = 'Tamu';
  try {
    const pending = konfirmasiPending[familyJid];
    if (pending && pending.guestJid === guestJid) {
      clearTimeout(pending.timer);
      konfirmasiPending[familyJid] = null;
      hapusDariPending = true;
      ditemukan = true;
      namaTamu = pending.namaLengkap;
    } else {
      const antrean = antreanTamu[familyJid] || [];
      const idx = antrean.findIndex(t => t.guestJid === guestJid);
      if (idx !== -1) {
        namaTamu = antrean[idx].namaLengkap;
        antrean.splice(idx, 1);
        ditemukan = true;
      }
    }
    if (ditemukan) {
      await kirimPesan(familyJid, `ⓘ Permintaan dari tamu *${namaTamu}* telah dibatalkan oleh tamu tersebut.`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
  if (hapusDariPending) await mintaKonfirmasiBerikutnya(familyJid);
  return ditemukan;
}

/**
 * Keluarga menghubungi kontak BARU (bukan tamu yang mengisi formulir) lewat
 * perintah "Chat <nomor>". Bot menanya nama tampilan dulu, lalu membuka bridge.
 */
async function tanganiPermintaanChatKeluar(familyJid, keluarga, nomorInput) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const bridgeAktif    = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    if ((bridgeAktif && bridgeAktif.active) || konfirmasiAktif) {
      await kirimPesan(familyJid,
        `ⓘ Mohon selesaikan dulu sesi/konfirmasi yang sedang berjalan sebelum memulai percakapan baru.`
      );
      return;
    }

    const jidTujuan = buatJidDariNomor(nomorInput);
    if (!jidTujuan) {
      await kirimPesan(familyJid, `ⓘ Format nomor "*${nomorInput.trim()}*" tidak valid. Contoh: *Chat 08123456789*`);
      return;
    }
    if (jidTujuan === familyJid) {
      await kirimPesan(familyJid, `ⓘ Anda tidak dapat menghubungi nomor Anda sendiri.`);
      return;
    }
    if (DATABASE_KELUARGA.some(a => a.nomor === jidTujuan)) {
      await kirimPesan(familyJid, `ⓘ Nomor ini terdaftar sebagai anggota keluarga — silakan hubungi langsung lewat WhatsApp.`);
      return;
    }

    // Simpan nomor sementara, tunggu nama tampilan dari keluarga
    stateChatKeluarMenungguNama[familyJid] = { nomorInput: nomorInput.trim(), jidTujuan };
    const nomorTampil = '+' + jidTujuan.replace('@s.whatsapp.net', '');
    await kirimPesan(familyJid,
      `Nama apa yang ingin ditampilkan kepada kontak *${nomorTampil}*?\n` +
      `(Nama ini yang akan muncul saat Anda berkomunikasi dengan mereka)`
    );
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/** Lanjutkan koneksi chat keluar setelah keluarga memberikan nama tampilan. */
async function mulaiChatKeluar(familyJid, keluarga, jidTujuan, namaTampil) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const nomorTampil = '+' + jidTujuan.replace('@s.whatsapp.net', '');
    await kirimPesan(familyJid, `⌛︎ Menghubungkan Anda ke *${nomorTampil}*, mohon menunggu sebentar.`);

    await kirimPesan(jidTujuan,
      `Halo! Saya ${NAMA_BOT}, sistem komunikasi privat ${NAMA_KELUARGA}. Anda menerima pesan ini karena ` +
      `salah satu anggota keluarga ${NAMA_KELUARGA} ingin menghubungi Anda.\n\n` +
      `ⓘ Mohon menunggu, saya sedang menghubungkan anggota keluarga tersebut ke saluran komunikasi Anda.`
    );
    await delay(1500);
    await kirimPesan(jidTujuan, `ⓘ Anda telah terhubung. Silakan mulai percakapan.`);

    await mulaiLiveChatBridge(
      familyJid,
      { guestJid: jidTujuan, namaLengkap: nomorTampil, tujuan: 'Dihubungi langsung oleh keluarga', namaPanggilanKeluarga: namaTampil },
      { kirimPesanKeGuest: false, dimulaiOlehKeluarga: true }
    );
    console.log(`[CHAT-KELUAR] ${namaTampil} (${familyJid}) menghubungi ${jidTujuan}`);
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/**
 * Keluarga menghubungi balik tamu lama memakai kode tamu.
 */
async function tanganiPanggilBalik(familyJid, kodeInput, keluarga) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const bridgeAktif    = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    if ((bridgeAktif && bridgeAktif.active) || konfirmasiAktif) {
      await kirimPesan(familyJid,
        `ⓘ Selesaikan dulu sesi/konfirmasi yang sedang berjalan sebelum menghubungi tamu lain.`
      );
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
      `ⓘ *${keluarga.panggilanUtama}* menghubungi Anda kembali mengenai:\n_${record.tujuan}_`
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

/**
 * @param diabaikan     true jika keluarga sengaja memutus & menolak (ketik "N").
 * @param karenaTimeout true jika sesi berakhir otomatis karena 10 menit tanpa aktivitas.
 */
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
    await kirimPesan(guestJid,
      `ⓘ Sesi percakapan diakhiri otomatis karena tidak ada aktivitas selama 10 menit. Terima kasih.`
    );
    await kirimPesan(familyJid,
      `⌛︎ Sesi live chat diakhiri otomatis karena tidak ada aktivitas selama 10 menit.`
    );
  } else if (diabaikan) {
    await kirimPesan(guestJid,
      `ⓘ Mohon maaf, *${panggilanUntukLawanBicara}* tidak dapat melanjutkan percakapan saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid, `✓ Sesi telah diputuskan.`);
  } else {
    await kirimPesan(guestJid, `ⓘ Sesi percakapan telah berakhir. Terima kasih.`);
    await kirimPesan(familyJid, `✓ Sesi live chat telah berakhir.`);
  }

  console.log(`[BRIDGE] Berakhir: ${guestJid} <-> ${familyJid}${diabaikan ? ' (diabaikan)' : ''}${karenaTimeout ? ' (timeout)' : ''}`);
  delete stateScreening[guestJid];
  delete riwayatChatAI[guestJid];
  await mintaKonfirmasiBerikutnya(familyJid);
}

/**
 * Ambil tamu antrean berikutnya (jika ada) dan kirim permintaan konfirmasi ke keluarga.
 */
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

/**
 * Masukkan tamu ke alur konfirmasi (jika keluarga sedang luang) atau ke antrean.
 */
async function mintaKonfirmasiAtauAntre(familyJid, tamuData) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;

  try {
    const bridgeAktif    = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    const adaAntrean      = antreanTamu[familyJid] && antreanTamu[familyJid].length > 0;

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
          `[INFO ANTREAN]\nTamu baru *${tamuData.namaLengkap}* (*${tamuData.kode}*) menunggu di antrean #${posisi}.\nKeperluan: _${tamuData.tujuan}_`
        );
      }
      console.log(`[ANTREAN] ${tamuData.namaLengkap} (${tamuData.kode}) di antrean #${posisi} untuk ${familyJid}`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
}

// ============================================================
// 10. MESSAGE BUFFER (DEBOUNCE ANTI-SPAM 2.5 DETIK)
// ============================================================

function bufferDanKirimPesan(fromJid, toJid, teks, labelPengirim) {
  const key = `${fromJid}=>${toJid}`;
  if (!messageBuffer[key]) messageBuffer[key] = { timer: null, messages: [] };
  messageBuffer[key].messages.push(teks);

  if (messageBuffer[key].timer) clearTimeout(messageBuffer[key].timer);

  messageBuffer[key].timer = setTimeout(async () => {
    const entry = messageBuffer[key];
    messageBuffer[key] = null;
    if (!entry || entry.messages.length === 0) return;
    const gabungan = entry.messages.join('\n');
    const pesanAkhir = labelPengirim ? `${labelPengirim}\n${gabungan}` : gabungan;
    await kirimPesan(toJid, pesanAkhir);
  }, 2500);
}

// ============================================================
// 11. FORMULIR SKRINING & AI CHAT
// ============================================================

/**
 * Mulai interaksi dengan tamu baru.
 * Jika Gemini aktif: tamu langsung masuk mode AI chat (step 0).
 * Jika Gemini nonaktif: mulai skrining 3 langkah biasa.
 */
async function mulaiInteraksiTamu(guestJid, teks) {
  if (geminiEnabled) {
    stateScreening[guestJid] = { step: 0, pesanPertama: teks };
    console.log(`[AI] Tamu baru (mode AI): ${guestJid}`);
    const hasil = await chatGeminiTamu(guestJid, teks);
    if (!hasil) {
      await mulaiSkrining(guestJid, teks);
      return;
    }
    await kirimPesan(guestJid, hasil.teks);
    if (hasil.hubungiAlias) {
      await prosesNiatHubungiKeluarga(guestJid, hasil.hubungiAlias, hasil.hubungiNamaKetik, teks);
    }
  } else {
    await mulaiSkrining(guestJid, teks);
  }
}

/**
 * Skrining 3 langkah biasa (tanpa AI).
 */
async function mulaiSkrining(guestJid, pesanPertama) {
  stateScreening[guestJid] = { step: 1, pesanPertama };
  await kirimPesan(guestJid,
    `Selamat datang!\n\nAnda menghubungi sistem komunikasi privat ${NAMA_KELUARGA}.\n` +
    `Mohon jawab beberapa pertanyaan singkat.\n` +
    `_Ketik *Batal* kapan saja untuk membatalkan percakapan ini._\n\n` +
    `*Pertanyaan 1 dari 3:*\nSiapa *Nama Lengkap* Anda?`
  );
}

/**
 * Proses ketika Gemini mendeteksi tamu ingin menghubungi anggota keluarga.
 */
async function prosesNiatHubungiKeluarga(guestJid, alias, namaKetik, pesanPertama) {
  const keluarga = cariKeluarga(alias);
  if (!keluarga) {
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

async function prosesJawabanSkrining(guestJid, teks) {
  const state = stateScreening[guestJid];
  if (!state) return;

  const teksTrim = teks.trim();
  const teksLower = teksTrim.toLowerCase();

  // ── Batal kapan saja ──
  if (teksLower === 'batal') {
    const berhasil = await batalkanTamuMenunggu(guestJid);
    if (berhasil) {
      if (geminiEnabled) {
        stateScreening[guestJid] = { step: 0, pesanPertama: '' };
        delete riwayatChatAI[guestJid];
      } else {
        delete stateScreening[guestJid];
      }
      await kirimPesan(guestJid, `ⓘ Permintaan Anda telah dibatalkan.\nKirim pesan apa saja jika ingin memulai lagi.`);
    } else {
      await kirimPesan(guestJid, `ⓘ Permintaan sedang diproses dan tidak dapat dibatalkan lagi.`);
    }
    return;
  }

  // ── STEP 0: Mode AI chat ──
  if (state.step === 0) {
    if (!geminiEnabled) {
      await mulaiSkrining(guestJid, teksTrim);
      return;
    }

    const valid = await verifikasiTeksBermakna(teksTrim);
    if (!valid) {
      await kirimPesan(guestJid, `ⓘ Mohon ketik pesan yang bermakna dalam bahasa Indonesia atau Inggris.`);
      return;
    }

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
    const valid = await verifikasiTeksBermakna(teksTrim);
    if (!valid) {
      await kirimPesan(guestJid, `ⓘ Mohon masukkan nama lengkap Anda yang sebenarnya.`);
      return;
    }
    state.namaLengkap = formatSebutan(teksTrim);

    if (state.targetKeluarga) {
      // Target keluarga sudah diketahui dari AI — lewati step 2
      state.step = 3;
      const namaTampil = state.namaPanggilanKeluarga || state.targetKeluarga.panggilanUtama;
      await kirimPesan(guestJid,
        `Terima kasih, *${state.namaLengkap}*.\n\n*Pertanyaan 2:*\nApa keperluan Anda dengan *${namaTampil}*?`
      );
    } else {
      state.step = 2;
      const daftar = DATABASE_KELUARGA.map(a => `- ${a.panggilanUtama}`).join('\n');
      await kirimPesan(guestJid,
        `Terima kasih, *${state.namaLengkap}*.\n\n*Pertanyaan 2 dari 3:*\nSiapa yang ingin Anda hubungi?\n\n${daftar}`
      );
    }
    return;
  }

  // ── STEP 2: Siapa yang ingin ditemui ──
  if (state.step === 2) {
    const keluargaDitemukan = cariKeluarga(teksTrim);
    if (!keluargaDitemukan) {
      const daftar = DATABASE_KELUARGA.map(a => a.panggilanUtama).join(', ');
      await kirimPesan(guestJid,
        `ⓘ Nama "*${teksTrim}*" tidak ditemukan.\nSilakan ketik ulang.\n_Contoh: ${daftar}_`
      );
      return;
    }
    state.targetKeluarga = keluargaDitemukan;
    state.namaPanggilanKeluarga = formatSebutan(teksTrim);
    state.step = 3;
    await kirimPesan(guestJid,
      `*Pertanyaan 3 dari 3:*\nApa *Tujuan/Kepentingan* Anda menghubungi *${state.namaPanggilanKeluarga}*?\n_(Jelaskan dalam minimal 5 kata)_`
    );
    return;
  }

  // ── STEP 3: Keperluan ──
  if (state.step === 3) {
    const jumlahKata = teksTrim.split(/\s+/).filter(Boolean).length;
    if (jumlahKata < 2) {
      await kirimPesan(guestJid, `ⓘ Mohon jelaskan keperluan Anda dengan lebih lengkap.`);
      return;
    }
    const valid = await verifikasiTeksBermakna(teksTrim);
    if (!valid) {
      await kirimPesan(guestJid, `ⓘ Mohon jelaskan keperluan Anda dengan kata-kata yang jelas.`);
      return;
    }

    state.tujuan = teksTrim;
    state.step   = 'selesai';
    const keluarga = state.targetKeluarga;

    state.kodeTamu = buatKodeTamu(state.namaLengkap);
    const tamuData = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      kode: state.kodeTamu,
      namaPanggilanKeluarga: state.namaPanggilanKeluarga,
      pesanPertama: state.pesanPertama,
    };

    riwayatTamu[state.kodeTamu] = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      targetKeluargaNomor: keluarga.nomor,
      namaPanggilanKeluarga: state.namaPanggilanKeluarga,
      pesanPertama: state.pesanPertama,
      dibuatPada: new Date(),
    };

    await kirimPesan(guestJid,
      `ⓘ Terima kasih, *${state.namaLengkap}*. Permintaan Anda telah kami catat.\n` +
      `Mohon tunggu, kami sedang menghubungi *${state.namaPanggilanKeluarga}*.\n\n` +
      `_Ketik *Batal* kapan saja sebelum terhubung jika ingin membatalkan permintaan ini._`
    );
    await delay(1000);
    await mintaKonfirmasiAtauAntre(keluarga.nomor, tamuData);
  }
}

// ============================================================
// 12. TANDAI DIBACA
// ============================================================

async function tandaiDibaca(message) {
  if (!sock || !message?.key) return;
  try {
    await sock.readMessages([message.key]);
  } catch (_) { /* abaikan error read receipt */ }
}

// ============================================================
// 13. HANDLER PESAN MASUK
// ============================================================

async function handlePesanMasuk(message) {
  const jid    = message.key.remoteJid;
  const jidAlt = message.key.remoteJidAlt;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || message.key.fromMe) return;

  const msg = message.message;
  const teks =
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    msg?.documentMessage?.caption || '';

  const pesanMedia = apakahPesanMedia(msg);
  if (!teks && !pesanMedia) return;

  const teksUpper = teks.trim().toUpperCase();
  const teksLower = teks.trim().toLowerCase();
  console.log(`[PESAN] ${jid}: "${pesanMedia ? labelJenisMedia(msg) : teks.substring(0, 80)}"`);

  // ── BLOK A: Anggota Keluarga ──
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

    // ── Panggil balik tamu lama pakai kode tamu (mis. "#1David09072026") ──
    if (/^#\d/.test(teksTrim)) {
      const dipilihDariAntrean = await pilihTamuDariAntreanByKode(familyJid, teksTrim);
      if (!dipilihDariAntrean) {
        await tanganiPanggilBalik(familyJid, teksTrim, keluargaPengirim);
      }
      return;
    }

    // ── Keluarga menghubungi kontak baru: "Chat 08123456789" ──
    const cocokChat = teksTrim.match(/^chat\s+([\d+][\d+\-\s()]{6,})$/i);
    if (cocokChat) {
      await tanganiPermintaanChatKeluar(familyJid, keluargaPengirim, cocokChat[1]);
      return;
    }

    // ── Menunggu konfirmasi: tamu BELUM terhubung ──
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
            `ⓘ Mohon maaf, *${pending.namaPanggilanKeluarga || keluargaPengirim.panggilanUtama}* sedang sibuk dan belum dapat dihubungi saat ini. Terima kasih.`
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
          await kirimPesan(familyJid,
            `ⓘ Ada tamu menunggu balasan Anda.\nKetik *Y* untuk menerima, atau *N* untuk menolak.`
          );
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

    // ── N = mengakhiri sesi live chat ──
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
      bufferDanKirimPesan(familyJid, bridge.guestJid, teks, `*${keluargaPengirim.panggilanUtama}:*`);
    }
    return;
  }

  // ── BLOK B: Tamu / kontak yang dihubungi keluarga (nomor asing) ──
  const nomorJidMasuk    = nomorDariJid(jid);
  const nomorJidAltMasuk = nomorDariJid(jidAlt);
  const bridgeEntry = Object.entries(stateBridge).find(([, val]) => {
    if (!val || !val.active) return false;
    const nomorBridge = nomorDariJid(val.guestJid);
    return nomorBridge === nomorJidMasuk || (nomorJidAltMasuk && nomorBridge === nomorJidAltMasuk);
  });
  if (bridgeEntry) {
    const [familyJid, bridgeVal] = bridgeEntry;

    // Tandai pesan tamu sebagai dibaca
    await tandaiDibaca(message);

    // Verifikasi file/link jika tamu mengirim media atau link
    if (pesanMedia) {
      const cekFilePesan = await verifikasiFile(message);
      if (!cekFilePesan.boleh) {
        await kirimPesan(jid, `ⓘ File yang Anda kirim tidak dapat diteruskan: ${cekFilePesan.alasan}`);
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

    const namaLabel = stateScreening[jid]?.namaLengkap
      || (bridgeVal.dimulaiOlehKeluarga ? '+' + nomorDariJid(jid) : 'Tamu');
    pasangBridgeTimeout(familyJid);
    if (pesanMedia) {
      await teruskanPesanMedia(familyJid, message, `*${namaLabel}:*`);
    } else {
      bufferDanKirimPesan(jid, familyJid, teks, `*${namaLabel}:*`);
    }
    return;
  }

  // ── Batal: tamu yang MASIH menunggu ──
  if (teksLower === 'batal' && stateScreening[jid]?.step === 'selesai') {
    const berhasil = await batalkanTamuMenunggu(jid);
    if (berhasil) {
      delete stateScreening[jid];
      await kirimPesan(jid, `ⓘ Baik, permintaan Anda telah dibatalkan.`);
    } else {
      await kirimPesan(jid, `ⓘ Permintaan Anda sedang diproses dan tidak dapat dibatalkan lagi.`);
    }
    return;
  }

  // Cek apakah tamu dalam antrean
  const dalamAntrean = Object.values(antreanTamu).some(a => a?.some(t => t.guestJid === jid));
  if (dalamAntrean) {
    for (const [, antrean] of Object.entries(antreanTamu)) {
      const posisi = antrean?.findIndex(t => t.guestJid === jid) + 1;
      if (posisi > 0) {
        await kirimPesan(jid, `⌛︎ Anda masih di antrean posisi *#${posisi}*. Mohon bersabar.`);
        break;
      }
    }
    return;
  }

  // ── Deteksi Kurir (bypass skrining) ──
  const sedangSkrining = stateScreening[jid] && stateScreening[jid].step !== 'selesai' && stateScreening[jid].step !== 0;
  const deteksi = sedangSkrining ? null : deteksiKurir(teks);
  if (deteksi) {
    console.log(`[KURIR] Terdeteksi dari ${jid}. Kurir: ${deteksi.namaKurir}`);
    if (deteksi.targetKeluarga) {
      const k = deteksi.targetKeluarga;
      await kirimPesan(k.nomor,
        `[NOTIFIKASI PAKET]\n\nKurir *${deteksi.namaKurir}*\nPesan kurir:\n_${teks}_\n\nKontak: ${jid.replace('@s.whatsapp.net', '')}`
      );
      await kirimPesan(jid,
        `✓ *Konfirmasi Diterima*\nPesan untuk *${k.namaResmi}* diterima. Berikut kontak yang bisa dihubungi langsung:`
      );
      await delay(500);
      await kirimKontakVCard(jid, k);
    } else {
      await kirimPesan(jid, `✓ Pesan kurir diterima. Mohon sebutkan nama penerima paket.`);
      for (const anggota of DATABASE_KELUARGA) {
        await kirimPesan(anggota.nomor,
          `[NOTIFIKASI PAKET]\nKurir *${deteksi.namaKurir}* — nama penerima tidak terdeteksi.\n_${teks}_`
        );
      }
    }
    return;
  }

  // ── Skrining / AI Chat ──
  const screenState = stateScreening[jid];
  if (!screenState) {
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
    await kirimPesan(jid, `ⓘ Formulir sudah diterima. Mohon tunggu giliran Anda.\n_Ketik *Batal* untuk membatalkan permintaan Anda._`);
    return;
  }

  // Tamu di step 0 (mode AI) kirim media — tolak dengan ramah
  if (pesanMedia && screenState.step === 0) {
    await kirimPesan(jid, `ⓘ Maaf, saya hanya dapat memproses pesan teks. Silakan ketik pertanyaan Anda.`);
    return;
  }

  await prosesJawabanSkrining(jid, teks);
}

// ============================================================
// 14. KONEKSI BAILEYS (PAIRING CODE — STABIL CLOUD)
// ============================================================

async function mulaiKoneksi() {
  sudahMintaPairingCode = false;

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Ambil versi protokol WhatsApp Web terbaru — WAJIB untuk pairing code.
  // Baileys yang di-pin ke versi lama akan ditolak server WA saat pairing
  // (server WA menganggap kode/koneksi tidak valid, padahal versi protokolnya
  // yang usang), gejalanya persis "kode selalu salah" walau sudah dimasukkan benar.
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
    keepAliveIntervalMs: 10000,   // ping ke WA setiap 10 detik agar koneksi tidak dianggap idle
    defaultQueryTimeoutMs: 0,     // tidak ada batas waktu untuk query — penting saat pairing lambat
    qrTimeout: 300000,            // ← FIX UTAMA: perpanjang QR timer ke 5 menit
                                  // Baileys menjalankan QR timer (default 60 detik) bersamaan dengan
                                  // pairing code. Saat timer habis, koneksi diputus paksa SEBELUM
                                  // handshake companion_finish selesai → "gagal menautkan".
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Minta Pairing Code segera setelah socket dibuat ──────────────────────
  // Dipanggil SEBELUM server memutuskan kirim QR, bukan setelah QR muncul.
  // Jeda singkat 1,5 detik agar WebSocket selesai handshake — cukup, Noise
  // Protocol sudah selesai di layer transport sebelum event JS apapun muncul.
  if (!authState.creds.registered && !sudahMintaPairingCode) {
    sudahMintaPairingCode = true;
    console.log('[PAIRING] Meminta kode pairing (1,5 detik)...');
    await delay(1500);
    if (!sock) return;

    try {
      const nomorBersih = NOMOR_BOT.replace(/[^0-9]/g, '');
      const pairingCode = await sock.requestPairingCode(nomorBersih);

      console.log('\n╔════════════════════════════════════════╗');
      console.log('║        KODE PAIRING WHATSAPP            ║');
      console.log('╠════════════════════════════════════════╣');
      console.log(`║  KODE: ${pairingCode}                    ║`);
      console.log('╠════════════════════════════════════════╣');
      console.log('║  1. Buka WhatsApp di HP                 ║');
      console.log('║  2. Pengaturan → Perangkat Tertaut       ║');
      console.log('║  3. Tautkan dengan Nomor Telepon         ║');
      console.log('║  4. Masukkan kode di atas               ║');
      console.log('║  (kode berlaku ±60 detik)               ║');
      console.log('╚════════════════════════════════════════╝\n');
    } catch (err) {
      console.error('[PAIRING] Gagal minta kode:', err.message);
      sudahMintaPairingCode = false;
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('\n✅ [KONEKSI] Bot terhubung ke WhatsApp!\n');
      sedangReconnect = false;
      pernahTerhubung = true;
      percobaanPairingGagal = 0;
    }

    if (connection === 'close') {
      const statusKode = lastDisconnect?.error?.output?.statusCode;
      const alasan = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusKode) || `Kode ${statusKode}`;
      console.log(`⚠️ [KONEKSI] Terputus: ${alasan}`);

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
        await kirimPesan(call.from,
          `ⓘ Maaf, sistem ini tidak dapat menerima panggilan telepon.\nSilakan kirim pesan teks jika ingin menghubungi kami.`
        );
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

        const emoji        = reaction.reaction?.text || '';
        const nomorReactor = nomorDariJid(reactorJid);

        const keluargaReactor = cariKeluargaByJid(reactorJid, null);
        if (keluargaReactor) {
          const bridge = stateBridge[keluargaReactor.nomor];
          if (bridge && bridge.active && emoji) {
            await kirimPesan(bridge.guestJid, `[Reaksi dari ${keluargaReactor.panggilanUtama}]: ${emoji}`);
          }
          continue;
        }

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

        const editedMsg =
          update.update.message?.editedMessage ||
          update.update.message?.protocolMessage?.editedMessage;
        if (!editedMsg) continue;

        const teksBaru =
          editedMsg.conversation ||
          editedMsg.extendedTextMessage?.text || '';
        if (!teksBaru) continue;

        const nomorSender     = nomorDariJid(senderJid);
        const keluargaSender  = cariKeluargaByJid(senderJid, null);
        if (keluargaSender) {
          const bridge = stateBridge[keluargaSender.nomor];
          if (bridge && bridge.active) {
            await kirimPesan(bridge.guestJid, `*${keluargaSender.panggilanUtama}* [pesan diubah]: ${teksBaru}`);
          }
          continue;
        }

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
// 15. ENTRY POINT
// ============================================================

console.log('╔════════════════════════════════════════╗');
console.log('║    WHATSAPP GATEKEEPER BOT DIMULAI      ║');
console.log(`║    Nomor Bot: ${NOMOR_BOT}            ║`);
console.log('╚════════════════════════════════════════╝\n');

mulaiKoneksi().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

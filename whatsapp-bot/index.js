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
 */
const NAMA_BOT      = process.env.NAMA_BOT      || 'Islah';
const NAMA_KELUARGA = process.env.NAMA_KELUARGA || 'Dil Familie';

// Validasi wajib — fail-fast agar kesalahan konfigurasi terdeteksi segera
if (!NOMOR_BOT || !/^\d{10,15}$/.test(NOMOR_BOT.trim())) {
  console.error('[CONFIG] ❌ NOMOR_BOT tidak diset atau format tidak valid.');
  console.error('[CONFIG]    Set environment variable NOMOR_BOT=628xxxxxxxxxx (tanpa +, 10-15 digit)');
  process.exit(1);
}

// ============================================================
// 4. STATE GLOBAL
// ============================================================

/** State skrining: { [guestJid]: { step, namaLengkap?, targetKeluarga?, tujuan? } } */
const stateScreening = {};

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
// 5. HELPER FUNCTIONS
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
 * - Bagian huruf nama diambil dari 5 huruf AWAL nama (huruf saja, tanpa
 *   spasi), selalu huruf kapital.
 * - Nomor urut di-reset otomatis ke 0 setiap kali tanggal berganti (waktu server).
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
// 6. PEMBATALAN BUFFER DEBOUNCE
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
// 7. LIVE CHAT BRIDGE, KONFIRMASI KELUARGA, & ANTREAN
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

/**
 * @param tamuData.namaPanggilanKeluarga  Sebutan anggota keluarga yang dipakai
 *   TAMU saat mengisi formulir (mis. "Edil"), dipakai di pesan yang dikirim
 *   ke tamu agar konsisten dengan sebutan yang mereka kenal. Untuk sesi yang
 *   dimulai langsung oleh keluarga sendiri (perintah "Chat <nomor>"), field
 *   ini tidak relevan — pesan ke lawan bicara sudah dikirim tersendiri oleh
 *   mulaiChatKeluar(), jadi kirimPesanKeGuest di-set false.
 */
async function mulaiLiveChatBridge(familyJid, tamuData, opts = {}) {
  const { guestJid, namaLengkap, tujuan, namaPanggilanKeluarga } = tamuData;
  const { kirimPesanKeGuest = true } = opts;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';
  const panggilanUntukTamu = namaPanggilanKeluarga || panggilan;

  stateBridge[familyJid] = { guestJid, active: true, namaPanggilanKeluarga: panggilanUntukTamu };
  pasangBridgeTimeout(familyJid);

  await kirimPesan(familyJid,
    `🔔 *[LIVE CHAT AKTIF]*\n\n` +
    `Terhubung dengan:\n👤 *${namaLengkap}*\n📌 _${tujuan}_\n\n` +
    `Ketik *EXIT* untuk mengakhiri sesi.\nKetik *N* untuk memutus & menolak tamu.`
  );
  if (kirimPesanKeGuest) {
    await kirimPesan(guestJid,
      `✅ *Anda telah terhubung dengan ${panggilanUntukTamu}.*\n\nSilakan sampaikan pesan Anda.`
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
 * - Jika hanya 1 tamu menunggu (tidak ada antrean lain): tanya Y/N.
 * - Jika lebih dari 1 tamu menunggu sekaligus (keluarga belum membalas dan
 *   tamu baru ikut menunggu): kirim SEMUA kode tamu yang menunggu, agar
 *   keluarga bisa pilih membalas siapa saja lewat kode tamunya.
 */
async function kirimPromptKonfirmasi(familyJid) {
  const pending = konfirmasiPending[familyJid];
  if (!pending) return;

  const antrean = antreanTamu[familyJid] || [];
  if (antrean.length === 0) {
    await kirimPesan(familyJid,
      `🔔 *[TAMU MENUNGGU]*\n\n👤 *${pending.namaLengkap}* (*${pending.kode}*)\n📌 _${pending.tujuan}_\n\n` +
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
    .map((t, i) => `${i + 1}. *${t.kode}* — ${t.namaLengkap}\n   _${t.tujuan}_`)
    .join('\n\n');

  await kirimPesan(familyJid,
    `🔔 *[${semua.length} TAMU MENUNGGU BALASAN]*\n\n${daftar}\n\n` +
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
      `ℹ️ Mohon maaf, *${pending.namaPanggilanKeluarga || panggilan}* sedang sibuk dan belum dapat dihubungi saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid,
      `⌛ Waktu konfirmasi (20 menit) habis. Permintaan tamu *${pending.namaLengkap}* (*${pending.kode}*) otomatis dianggap ditolak.`
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
 * Dipakai saat lebih dari 1 tamu menunggu bersamaan — keluarga bebas pilih
 * mau balas siapa duluan, tidak harus urutan FIFO.
 * Return true jika kode ditemukan & langsung tersambung, false jika tidak
 * ditemukan di antara tamu yang sedang menunggu (pemanggil bisa lanjut coba
 * cari di riwayat tamu lama lewat tanganiPanggilBalik()).
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
    // Kalau ada tamu lain yang sedang ditanya konfirmasi, jangan dibiarkan
    // hilang — kembalikan ke depan antrean supaya tetap diproses nanti.
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
 * Batalkan permintaan tamu yang MASIH menunggu (belum tersambung) — baik
 * yang sedang ditanyakan konfirmasi ke keluarga, maupun yang masih di
 * antrean. Dipanggil saat tamu mengetik "Batal" setelah formulir selesai
 * tapi sebelum keluarga membalas "Y". Tidak berlaku lagi setelah tamu
 * tersambung (live chat aktif) — di situ hanya keluarga yang bisa
 * mengakhiri sesi.
 * Return true jika permintaan ditemukan & dibatalkan, false jika tidak
 * (mis. sudah keburu diproses/tersambung).
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
      await kirimPesan(familyJid, `ℹ️ Permintaan dari tamu *${namaTamu}* telah dibatalkan oleh tamu tersebut.`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
  if (hapusDariPending) await mintaKonfirmasiBerikutnya(familyJid);
  return ditemukan;
}

/**
 * Keluarga menghubungi kontak BARU (bukan tamu yang mengisi formulir) lewat
 * perintah "Chat <nomor>". Bot memperkenalkan diri ke nomor tersebut lalu
 * langsung membuka sesi live chat — tanpa tahap konfirmasi, karena
 * keluargalah yang berinisiatif memulai.
 */
async function mulaiChatKeluar(familyJid, keluarga, nomorInput) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const bridgeAktif = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    if ((bridgeAktif && bridgeAktif.active) || konfirmasiAktif) {
      await kirimPesan(familyJid,
        `ℹ️ Mohon selesaikan dulu sesi/konfirmasi yang sedang berjalan sebelum memulai percakapan baru.`
      );
      return;
    }

    const jidTujuan = buatJidDariNomor(nomorInput);
    if (!jidTujuan) {
      await kirimPesan(familyJid, `❌ Format nomor "*${nomorInput.trim()}*" tidak valid. Contoh: *Chat 08123456789*`);
      return;
    }
    if (jidTujuan === familyJid) {
      await kirimPesan(familyJid, `❌ Anda tidak dapat menghubungi nomor Anda sendiri.`);
      return;
    }
    if (DATABASE_KELUARGA.some(a => a.nomor === jidTujuan)) {
      await kirimPesan(familyJid, `ℹ️ Nomor ini terdaftar sebagai anggota keluarga — silakan hubungi langsung lewat WhatsApp.`);
      return;
    }

    const nomorTampil = '+' + jidTujuan.replace('@s.whatsapp.net', '');
    await kirimPesan(familyJid, `⏳ Menghubungkan Anda ke *${nomorTampil}*, mohon menunggu sebentar.`);

    await kirimPesan(jidTujuan,
      `Halo! Saya ${NAMA_BOT}, sistem komunikasi privat ${NAMA_KELUARGA}. Anda menerima pesan ini karena ` +
      `salah satu anggota keluarga ${NAMA_KELUARGA} ingin menghubungi Anda.\n\n` +
      `ⓘ Mohon menunggu, saya sedang menghubungkan anggota keluarga tersebut ke saluran komunikasi Anda.`
    );
    await delay(1500);
    await kirimPesan(jidTujuan, `ⓘ *${keluarga.panggilanUtama}* ingin menghubungi Anda.`);
    await delay(1500);
    await kirimPesan(jidTujuan, `ⓘ Anda telah terhubung dengan *${keluarga.panggilanUtama}*.`);

    await mulaiLiveChatBridge(
      familyJid,
      { guestJid: jidTujuan, namaLengkap: nomorTampil, tujuan: 'Dihubungi langsung oleh keluarga' },
      { kirimPesanKeGuest: false }
    );
    // Sesuaikan pesan konfirmasi ke keluarga (mulaiLiveChatBridge memakai
    // label umum "👤 *${namaLengkap}*" yang di sini kita isi nomor tujuan).
    console.log(`[CHAT-KELUAR] ${keluarga.panggilanUtama} (${familyJid}) menghubungi ${jidTujuan}`);
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/**
 * Keluarga menghubungi balik tamu lama memakai kode tamu, terlepas dari
 * berapa banyak sesi lain yang sudah berlalu sejak tamu itu menghubungi.
 * Bridge langsung dibuka (tanpa tahap konfirmasi lagi) karena keluargalah
 * yang berinisiatif menghubungi.
 */
async function tanganiPanggilBalik(familyJid, kodeInput, keluarga) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;
  try {
    const bridgeAktif = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    if ((bridgeAktif && bridgeAktif.active) || konfirmasiAktif) {
      await kirimPesan(familyJid,
        `ℹ️ Selesaikan dulu sesi/konfirmasi yang sedang berjalan sebelum menghubungi tamu lain.`
      );
      return;
    }

    const record = riwayatTamu[kodeInput];
    if (!record) {
      await kirimPesan(familyJid, `❌ Kode tamu "*${kodeInput}*" tidak ditemukan.`);
      return;
    }
    if (record.targetKeluargaNomor !== familyJid) {
      await kirimPesan(familyJid, `❌ Kode tamu ini bukan milik Anda.`);
      return;
    }

    await kirimPesan(record.guestJid,
      `📞 *${keluarga.panggilanUtama}* menghubungi Anda kembali mengenai:\n_${record.tujuan}_`
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
 * @param karenaTimeout true jika sesi berakhir otomatis karena 10 menit tanpa
 *                      aktivitas — memakai kalimat berbeda agar tidak rancu
 *                      dengan penolakan sengaja.
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
      `ℹ️ Sesi percakapan diakhiri otomatis karena tidak ada aktivitas selama 10 menit. Terima kasih.`
    );
    await kirimPesan(familyJid,
      `⌛ Sesi live chat diakhiri otomatis karena tidak ada aktivitas selama 10 menit.`
    );
  } else if (diabaikan) {
    await kirimPesan(guestJid,
      `ℹ️ Mohon maaf, *${panggilanUntukLawanBicara}* tidak dapat melanjutkan percakapan saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid, `✅ Sesi telah diputuskan.`);
  } else {
    await kirimPesan(guestJid, `👋 Sesi percakapan telah berakhir. Terima kasih.`);
    await kirimPesan(familyJid, `✅ Sesi live chat telah berakhir.`);
  }

  console.log(`[BRIDGE] Berakhir: ${guestJid} <-> ${familyJid}${diabaikan ? ' (diabaikan)' : ''}${karenaTimeout ? ' (timeout)' : ''}`);
  delete stateScreening[guestJid];
  await mintaKonfirmasiBerikutnya(familyJid);
}

/**
 * Ambil tamu antrean berikutnya (jika ada) dan kirim permintaan konfirmasi ke
 * keluarga. Dikunci dengan bridgeLock yang sama seperti mintaKonfirmasiAtauAntre
 * agar pergerakan antrean & kedatangan tamu baru tidak saling menyalip
 * (race condition) dan urutan FIFO tetap terjaga.
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
      await kirimPesan(antrean[i].guestJid, `ℹ️ Update antrean: posisi Anda sekarang *#${i + 1}*.`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
}

/**
 * Masukkan tamu ke alur konfirmasi (jika keluarga sedang luang) atau ke
 * antrean (jika keluarga sedang di sesi/konfirmasi lain), dengan penguncian
 * atomik per keluarga. Tamu TIDAK langsung terhubung ke keluarga — keluarga
 * harus membalas "Y" (atau pilih lewat kode tamu) dulu, lewat
 * pasangKonfirmasiPending() + kirimPromptKonfirmasi().
 */
async function mintaKonfirmasiAtauAntre(familyJid, tamuData) {
  while (bridgeLock[familyJid]) await delay(50);
  bridgeLock[familyJid] = true;

  try {
    const bridgeAktif = stateBridge[familyJid];
    const konfirmasiAktif = konfirmasiPending[familyJid];
    const adaAntrean = antreanTamu[familyJid] && antreanTamu[familyJid].length > 0;

    // Tamu baru hanya boleh langsung dapat konfirmasi jika TIDAK ada bridge
    // aktif, TIDAK ada konfirmasi tertunda, DAN antrean kosong — kalau ada
    // tamu lain sudah menunggu di antrean, tamu baru harus ikut antre di
    // belakang mereka (FIFO), bukan menyalip dapat giliran konfirmasi duluan.
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
        `⏳ *${panggilan}* sedang berkomunikasi dengan tamu lain.\nPosisi antrean Anda: *#${posisi}*\nKami hubungi saat giliran tiba.`
      );

      if (konfirmasiAktif) {
        // Keluarga belum membalas konfirmasi sebelumnya, dan sekarang ada
        // tamu lain lagi yang menunggu — kirim ulang daftar LENGKAP kode
        // tamu yang menunggu, agar keluarga bisa pilih mau balas siapa.
        await kirimDaftarTungguKeKeluarga(familyJid);
      } else {
        // Keluarga sedang live chat aktif dengan tamu lain — cukup info
        // singkat, kode tamu baru ini akan muncul nanti saat gilirannya tiba.
        await kirimPesan(familyJid,
          `🔔 *[INFO ANTREAN]*\nTamu baru *${tamuData.namaLengkap}* (*${tamuData.kode}*) menunggu di antrean #${posisi}.\nKeperluan: _${tamuData.tujuan}_`
        );
      }
      console.log(`[ANTREAN] ${tamuData.namaLengkap} (${tamuData.kode}) di antrean #${posisi} untuk ${familyJid}`);
    }
  } finally {
    bridgeLock[familyJid] = false;
  }
}

// ============================================================
// 8. MESSAGE BUFFER (DEBOUNCE ANTI-SPAM 2.5 DETIK)
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
// 9. FORMULIR SKRINING 3 LANGKAH
// ============================================================

async function mulaiSkrining(guestJid) {
  stateScreening[guestJid] = { step: 1 };
  await kirimPesan(guestJid,
    `👋 *Selamat datang!*\n\nAnda menghubungi sistem Gatekeeper rumah ini.\nMohon jawab beberapa pertanyaan singkat.\n` +
    `_Ketik *Batal* kapan saja untuk membatalkan percakapan ini._\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 1 dari 3:*\nSiapa *Nama Lengkap* Anda?`
  );
}

async function prosesJawabanSkrining(guestJid, teks) {
  const state = stateScreening[guestJid];
  if (!state) return;

  // ── Batal: tamu bisa membatalkan kapan saja selama pengisian formulir ──
  if (teks.trim().toLowerCase() === 'batal') {
    delete stateScreening[guestJid];
    await kirimPesan(guestJid, `❌ Baik, permintaan Anda dibatalkan.\nKirim pesan apa saja jika ingin memulai lagi.`);
    return;
  }

  if (state.step === 1) {
    const namaInput = teks.trim();
    if (namaInput.length < 5) {
      await kirimPesan(guestJid,
        `❌ Nama minimal 5 huruf (termasuk spasi). Mohon masukkan *Nama Lengkap* Anda kembali.`
      );
      return;
    }
    state.namaLengkap = namaInput;
    state.step = 2;
    // Kode tamu TIDAK diberitahukan ke tamu — hanya dikirim ke anggota
    // keluarga nanti saat bot mulai menghubunginya (lihat kirimPromptKonfirmasi).
    await kirimPesan(guestJid,
      `Terima kasih, *${state.namaLengkap}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 2 dari 3:*\n` +
      `Siapa nama anggota keluarga yang ingin Anda hubungi?\n_(Ketik nama panggilan)_`
    );

  } else if (state.step === 2) {
    const keluargaDitemukan = cariKeluarga(teks);
    if (!keluargaDitemukan) {
      const daftar = DATABASE_KELUARGA.map(a => a.panggilanUtama).join(', ');
      await kirimPesan(guestJid,
        `❌ Nama "*${teks.trim()}*" tidak ditemukan.\nSilakan ketik ulang.\n_Contoh: ${daftar}_`
      );
      return;
    }
    state.targetKeluarga = keluargaDitemukan;
    // Simpan sebutan PERSIS seperti yang diketik tamu (dirapikan Title Case)
    // — dipakai di semua pesan berikutnya ke tamu ini, agar konsisten dengan
    // nama yang mereka kenal (mis. tamu ketik "Edil" → bot tetap sebut "Edil",
    // bukan otomatis diganti ke nama panggilan utama "Aidil").
    state.namaPanggilanKeluarga = formatSebutan(teks);
    state.step = 3;
    await kirimPesan(guestJid,
      `✅ Ingin menghubungi *${state.namaPanggilanKeluarga}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 3 dari 3:*\n` +
      `Apa *Tujuan/Kepentingan* Anda menghubungi *${state.namaPanggilanKeluarga}*?\n_(Jelaskan dalam minimal 5 kata)_`
    );

  } else if (state.step === 3) {
    const tujuanInput = teks.trim();
    const jumlahKata = tujuanInput.split(/\s+/).filter(Boolean).length;
    if (jumlahKata < 5) {
      await kirimPesan(guestJid,
        `❌ Mohon jelaskan tujuan/kepentingan Anda dalam minimal 5 kata.`
      );
      return;
    }
    state.tujuan = tujuanInput;
    state.step = 'selesai';
    const keluarga = state.targetKeluarga;

    // Kode tamu dibuat sekarang (saat formulir selesai / bot mulai
    // menghubungi keluarga), BUKAN diberitahukan ke tamu — hanya keluarga
    // yang melihatnya, lewat kirimPromptKonfirmasi()/kirimDaftarTungguKeKeluarga().
    state.kodeTamu = buatKodeTamu(state.namaLengkap);
    const tamuData = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      kode: state.kodeTamu,
      namaPanggilanKeluarga: state.namaPanggilanKeluarga,
    };

    // Simpan ke riwayat tamu, dikunci dengan kode tamu — memungkinkan keluarga
    // menghubungi balik tamu ini kapan saja nanti, walau sudah lewat banyak
    // sesi percakapan lain.
    riwayatTamu[state.kodeTamu] = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      targetKeluargaNomor: keluarga.nomor,
      namaPanggilanKeluarga: state.namaPanggilanKeluarga,
      dibuatPada: new Date(),
    };

    await kirimPesan(guestJid,
      `✅ *Formulir selesai!*\n\n📋 Ringkasan:\n• Nama: ${state.namaLengkap}\n` +
      `• Bicara dengan: ${state.namaPanggilanKeluarga}\n• Keperluan: ${state.tujuan}\n\n` +
      `⏳ Mohon menunggu sebentar, kami akan menghubungkan Anda setelah *${state.namaPanggilanKeluarga}* bersedia membalas.\n` +
      `_Ketik *Batal* kapan saja sebelum terhubung jika ingin membatalkan permintaan ini._`
    );
    await delay(1000);
    await mintaKonfirmasiAtauAntre(keluarga.nomor, tamuData);
  }
}

// ============================================================
// 10. HANDLER PESAN MASUK
// ============================================================

async function handlePesanMasuk(message) {
  const jid = message.key.remoteJid;
  const jidAlt = message.key.remoteJidAlt;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || message.key.fromMe) return;

  const msg = message.message;
  const teks =
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption || '';

  if (!teks) return;

  const teksUpper = teks.trim().toUpperCase();
  console.log(`[PESAN] ${jid}: "${teks.substring(0, 80)}"`);

  // ── BLOK A: Anggota Keluarga ──
  // Dicocokkan lewat cariKeluargaByJid agar tetap terdeteksi walau WhatsApp
  // mengirim remoteJid dalam format @lid (lihat komentar di adalahKeluarga).
  const keluargaPengirim = cariKeluargaByJid(jid, jidAlt);
  if (keluargaPengirim) {
    // Gunakan nomor kanonik dari database sebagai kunci state, bukan jid
    // mentah dari WhatsApp — supaya bridge/antrean konsisten walau runtime
    // jid-nya @lid di satu sesi dan @s.whatsapp.net di sesi lain.
    const familyJid = keluargaPengirim.nomor;
    const teksTrim = teks.trim();
    const teksLower = teksTrim.toLowerCase();

    // ── Panggil balik tamu lama pakai kode tamu (mis. "#1David09072026") ──
    // Bisa dipakai kapan saja, walau sudah lewat banyak sesi lain, selama
    // keluarga sedang tidak di sesi/konfirmasi aktif lain.
    if (/^#\d/.test(teksTrim)) {
      // Coba dulu di antara tamu yang SEDANG menunggu (konfirmasi/antrean) —
      // relevan saat >1 tamu menunggu dan keluarga pilih mau balas siapa.
      const dipilihDariAntrean = await pilihTamuDariAntreanByKode(familyJid, teksTrim);
      if (!dipilihDariAntrean) {
        // Bukan tamu yang sedang menunggu — coba cari di riwayat tamu lama.
        await tanganiPanggilBalik(familyJid, teksTrim, keluargaPengirim);
      }
      return;
    }

    // ── Keluarga menghubungi kontak baru: "Chat 08123456789" ──
    const cocokChat = teksTrim.match(/^chat\s+([\d+][\d+\-\s()]{6,})$/i);
    if (cocokChat) {
      await mulaiChatKeluar(familyJid, keluargaPengirim, cocokChat[1]);
      return;
    }

    // ── Menunggu konfirmasi: tamu BELUM terhubung, tanyakan dulu ke keluarga ──
    // Dikunci dengan bridgeLock yang sama dipakai antrean, supaya balasan
    // keluarga tidak diproses bersamaan dengan perpindahan antrean lain
    // (mencegah dua tamu ter-bridge/ter-antre di posisi yang sama).
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
            `ℹ️ Mohon maaf, *${pending.namaPanggilanKeluarga || keluargaPengirim.panggilanUtama}* sedang sibuk dan belum dapat dihubungi saat ini. Terima kasih.`
          );
          await kirimPesan(familyJid, `✅ Permintaan tamu telah ditolak.`);
          delete stateScreening[pending.guestJid];
          bridgeLock[familyJid] = false;
          await mintaKonfirmasiBerikutnya(familyJid);
          return;
        }
        const antreanSaatIni = antreanTamu[familyJid] || [];
        if (antreanSaatIni.length > 0) {
          // Mode multi-tamu — arahkan keluarga memilih lewat kode, bukan Y/N generik.
          await kirimDaftarTungguKeKeluarga(familyJid);
        } else {
          await kirimPesan(familyJid,
            `ℹ️ Ada tamu menunggu balasan Anda.\nKetik *Y* untuk menerima, atau *N* untuk menolak.`
          );
        }
        return;
      } finally {
        bridgeLock[familyJid] = false;
      }
    } else if (konfirmasiPending[familyJid]) {
      // Lock sedang dipegang proses lain (mis. antrean sedang bergerak) —
      // minta keluarga coba lagi sesaat lagi daripada balapan mengubah state.
      await kirimPesan(familyJid, `ℹ️ Mohon tunggu sebentar lalu kirim ulang balasan Anda.`);
      return;
    }

    const bridge = stateBridge[familyJid];
    if (!bridge || !bridge.active) return;

    // ── EXIT/N hanya bisa dipakai oleh anggota keluarga — lawan bicara
    // (tamu atau kontak yang dihubungi lewat "Chat") tidak bisa mengakhiri
    // sesi sendiri; hanya keluarga yang mengontrol sesi.
    if (teksLower === 'n') {
      await akhiriLiveChatBridge(familyJid, true);
      return;
    }
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }

    pasangBridgeTimeout(familyJid);
    bufferDanKirimPesan(familyJid, bridge.guestJid, teks, `💬 *${keluargaPengirim.panggilanUtama}:*`);
    return;
  }

  // ── BLOK B: Tamu / kontak yang dihubungi keluarga (nomor asing) ──

  // Cek apakah tamu sedang dalam bridge aktif
  const bridgeEntry = Object.entries(stateBridge).find(
    ([, val]) => val && val.active && val.guestJid === jid
  );
  if (bridgeEntry) {
    const [familyJid, bridgeVal] = bridgeEntry;
    // Tamu/lawan bicara TIDAK bisa mengetik EXIT untuk mengakhiri sesi —
    // hanya anggota keluarga yang boleh mengakhiri (lihat Blok A di atas).
    const namaLabel = stateScreening[jid]?.namaLengkap
      || (bridgeVal.dimulaiOlehKeluarga ? '+' + nomorDariJid(jid) : 'Tamu');
    pasangBridgeTimeout(familyJid);
    bufferDanKirimPesan(jid, familyJid, teks, `📩 *${namaLabel}:*`);
    return;
  }

  // ── Batal: tamu yang MASIH menunggu (belum tersambung ke keluarga) bisa
  // membatalkan permintaannya kapan saja sebelum keluarga membalas "Y".
  if (teks.trim().toLowerCase() === 'batal' && stateScreening[jid]?.step === 'selesai') {
    const berhasil = await batalkanTamuMenunggu(jid);
    if (berhasil) {
      delete stateScreening[jid];
      await kirimPesan(jid, `❌ Baik, permintaan Anda telah dibatalkan.`);
    } else {
      await kirimPesan(jid, `ℹ️ Permintaan Anda sedang diproses dan tidak dapat dibatalkan lagi.`);
    }
    return;
  }

  // Cek apakah tamu dalam antrean
  const dalamAntrean = Object.values(antreanTamu).some(a => a?.some(t => t.guestJid === jid));
  if (dalamAntrean) {
    for (const [, antrean] of Object.entries(antreanTamu)) {
      const posisi = antrean?.findIndex(t => t.guestJid === jid) + 1;
      if (posisi > 0) {
        await kirimPesan(jid, `⏳ Anda masih di antrean posisi *#${posisi}*. Mohon bersabar.`);
        break;
      }
    }
    return;
  }

  // ── Deteksi Kurir (bypass skrining) ──
  // PENTING: hanya untuk kontak yang BELUM punya sesi skrining berjalan.
  // Sebelumnya deteksi ini jalan untuk semua pesan tamu, termasuk yang sedang
  // menjawab Pertanyaan 1-3 — kalau jawabannya (misal alamat/tujuan) kebetulan
  // mengandung ≥3 kata kunci kurir + nama ekspedisi, formulir "dibajak" jadi
  // notifikasi paket palsu alih-alih lanjut ke pertanyaan berikutnya.
  const sedangSkrining = stateScreening[jid] && stateScreening[jid].step !== 'selesai';
  const deteksi = sedangSkrining ? null : deteksiKurir(teks);
  if (deteksi) {
    console.log(`[KURIR] Terdeteksi dari ${jid}. Kurir: ${deteksi.namaKurir}`);
    if (deteksi.targetKeluarga) {
      const k = deteksi.targetKeluarga;
      await kirimPesan(k.nomor,
        `📦 *[NOTIFIKASI PAKET]*\n\nKurir *${deteksi.namaKurir}*\n📋 Pesan kurir:\n_${teks}_\n\nKontak: ${jid.replace('@s.whatsapp.net', '')}`
      );
      await kirimPesan(jid,
        `✅ *Konfirmasi Diterima*\nPesan untuk *${k.namaResmi}* diterima. Berikut kontak yang bisa dihubungi langsung:`
      );
      await delay(500);
      await kirimKontakVCard(jid, k);
    } else {
      await kirimPesan(jid, `✅ Pesan kurir diterima. Mohon sebutkan nama penerima paket.`);
      for (const anggota of DATABASE_KELUARGA) {
        await kirimPesan(anggota.nomor,
          `📦 *[NOTIFIKASI PAKET]*\nKurir *${deteksi.namaKurir}* — nama penerima tidak terdeteksi.\n📋 _${teks}_`
        );
      }
    }
    return;
  }

  // ── Skrining 3 Langkah ──
  const screenState = stateScreening[jid];
  if (!screenState) {
    console.log(`[GATEKEEPER] Tamu baru: ${jid}`);
    await mulaiSkrining(jid);
    return;
  }
  if (screenState.step === 'selesai') {
    await kirimPesan(jid, `ℹ️ Formulir sudah diterima. Mohon tunggu giliran Anda.\n_Ketik *Batal* untuk membatalkan permintaan Anda._`);
    return;
  }
  await prosesJawabanSkrining(jid, teks);
}

// ============================================================
// 11. KONEKSI BAILEYS (PAIRING CODE — STABIL CLOUD)
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
}

// ============================================================
// 12. ENTRY POINT
// ============================================================

console.log('╔════════════════════════════════════════╗');
console.log('║    WHATSAPP GATEKEEPER BOT DIMULAI      ║');
console.log(`║    Nomor Bot: ${NOMOR_BOT}            ║`);
console.log('╚════════════════════════════════════════╝\n');

mulaiKoneksi().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

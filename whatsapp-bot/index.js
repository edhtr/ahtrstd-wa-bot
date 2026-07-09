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
 * Buat kode tamu unik, format: #<nomorUrut><NamaTanpaSpasi><DDMMYYYY>
 * Contoh: #1David09072026
 * Nomor urut di-reset otomatis ke 0 setiap kali tanggal berganti (waktu server).
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

  const namaBersih = namaLengkap.replace(/\s+/g, '');
  return `#${kodeTamuHarian.counter}${namaBersih}${tanggalHariIni}`;
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

async function mulaiLiveChatBridge(familyJid, tamuData) {
  const { guestJid, namaLengkap, tujuan } = tamuData;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

  stateBridge[familyJid] = { guestJid, active: true };

  await kirimPesan(familyJid,
    `🔔 *[LIVE CHAT AKTIF]*\n\n` +
    `Terhubung dengan:\n👤 *${namaLengkap}*\n📌 _${tujuan}_\n\n` +
    `Ketik *EXIT* untuk akhiri sesi.\nKetik *Abaikan* untuk putus & tolak tamu.`
  );
  await kirimPesan(guestJid,
    `✅ *Anda terhubung dengan ${panggilan}.*\n\nSilakan kirim pesan Anda.\nKetik *EXIT* untuk mengakhiri sesi.`
  );
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
 * - Jika hanya 1 tamu menunggu (tidak ada antrean lain): tanya YA/Abaikan.
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
      `Apakah Anda ingin membalas pesan tamu ini?\nKetik *YA* untuk menerima.\nKetik *Abaikan* untuk menolak.`
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
    `Ketik *kode* tamu untuk membalas tamu itu (mis. *${semua[0].kode}*).\n` +
    `Atau ketik *YA* untuk terima tamu pertama, *Abaikan* untuk tolak tamu pertama.`
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
      `ℹ️ Maaf, *${panggilan}* sedang sibuk dan tidak dapat dihubungi saat ini. Terima kasih.`
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
    });
  } finally {
    bridgeLock[familyJid] = false;
  }
}

async function akhiriLiveChatBridge(familyJid, diabaikan = false) {
  const bridge = stateBridge[familyJid];
  if (!bridge || !bridge.active) return;

  const { guestJid } = bridge;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

  stateBridge[familyJid] = null;
  batalkanBuffer(familyJid, guestJid);

  if (diabaikan) {
    await kirimPesan(guestJid,
      `ℹ️ Maaf, *${panggilan}* tidak dapat melanjutkan percakapan saat ini. Terima kasih.`
    );
    await kirimPesan(familyJid, `✅ Sesi diputuskan.`);
  } else {
    await kirimPesan(guestJid, `👋 Sesi chat berakhir. Terima kasih!`);
    await kirimPesan(familyJid, `✅ Sesi live chat berakhir.`);
  }

  console.log(`[BRIDGE] Berakhir: ${guestJid} <-> ${familyJid}${diabaikan ? ' (diabaikan)' : ''}`);
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
 * harus membalas "YA" (atau pilih lewat kode tamu) dulu, lewat
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
    state.namaLengkap = teks.trim();
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
    state.step = 3;
    await kirimPesan(guestJid,
      `✅ Ingin hubungi *${keluargaDitemukan.panggilanUtama}*.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 3 dari 3:*\n` +
      `Apa *Tujuan/Kepentingan* Anda menghubungi *${keluargaDitemukan.panggilanUtama}*?`
    );

  } else if (state.step === 3) {
    state.tujuan = teks.trim();
    state.step = 'selesai';
    const keluarga = state.targetKeluarga;

    // Kode tamu dibuat sekarang (saat formulir selesai / bot mulai
    // menghubungi keluarga), BUKAN diberitahukan ke tamu — hanya keluarga
    // yang melihatnya, lewat kirimPromptKonfirmasi()/kirimDaftarTungguKeKeluarga().
    state.kodeTamu = buatKodeTamu(state.namaLengkap);
    const tamuData = { guestJid, namaLengkap: state.namaLengkap, tujuan: state.tujuan, kode: state.kodeTamu };

    // Simpan ke riwayat tamu, dikunci dengan kode tamu — memungkinkan keluarga
    // menghubungi balik tamu ini kapan saja nanti, walau sudah lewat banyak
    // sesi percakapan lain.
    riwayatTamu[state.kodeTamu] = {
      guestJid,
      namaLengkap: state.namaLengkap,
      tujuan: state.tujuan,
      targetKeluargaNomor: keluarga.nomor,
      dibuatPada: new Date(),
    };

    await kirimPesan(guestJid,
      `✅ *Formulir selesai!*\n\n📋 Ringkasan:\n• Nama: ${state.namaLengkap}\n` +
      `• Bicara dengan: ${keluarga.panggilanUtama}\n• Keperluan: ${state.tujuan}\n\n` +
      `⏳ Mohon tunggu sebentar, kami akan menghubungkan Anda setelah *${keluarga.panggilanUtama}* bersedia membalas._`
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

    // ── Menunggu konfirmasi: tamu BELUM terhubung, tanyakan dulu ke keluarga ──
    // Dikunci dengan bridgeLock yang sama dipakai antrean, supaya balasan
    // keluarga tidak diproses bersamaan dengan perpindahan antrean lain
    // (mencegah dua tamu ter-bridge/ter-antre di posisi yang sama).
    if (konfirmasiPending[familyJid] && !bridgeLock[familyJid]) {
      bridgeLock[familyJid] = true;
      try {
        const pending = konfirmasiPending[familyJid];
        if (!pending) return;

        if (teksLower === 'ya' || teksLower === 'terima') {
          clearTimeout(pending.timer);
          konfirmasiPending[familyJid] = null;
          await mulaiLiveChatBridge(familyJid, pending);
          return;
        }
        if (teksLower === 'abaikan') {
          clearTimeout(pending.timer);
          konfirmasiPending[familyJid] = null;
          await kirimPesan(pending.guestJid,
            `ℹ️ Maaf, *${keluargaPengirim.panggilanUtama}* sedang sibuk dan tidak dapat dihubungi saat ini. Terima kasih.`
          );
          await kirimPesan(familyJid, `✅ Permintaan tamu ditolak.`);
          delete stateScreening[pending.guestJid];
          bridgeLock[familyJid] = false;
          await mintaKonfirmasiBerikutnya(familyJid);
          return;
        }
        const antreanSaatIni = antreanTamu[familyJid] || [];
        if (antreanSaatIni.length > 0) {
          // Mode multi-tamu — arahkan keluarga memilih lewat kode, bukan YA/Abaikan generik.
          await kirimDaftarTungguKeKeluarga(familyJid);
        } else {
          await kirimPesan(familyJid,
            `ℹ️ Ada tamu menunggu balasan Anda.\nKetik *YA* untuk menerima, atau *Abaikan* untuk menolak.`
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

    if (teksLower === 'abaikan') {
      await akhiriLiveChatBridge(familyJid, true);
      return;
    }
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }

    bufferDanKirimPesan(familyJid, bridge.guestJid, teks, `💬 *${keluargaPengirim.panggilanUtama}:*`);
    return;
  }

  // ── BLOK B: Tamu (nomor asing) ──

  // Cek apakah tamu sedang dalam bridge aktif
  const bridgeEntry = Object.entries(stateBridge).find(
    ([, val]) => val && val.active && val.guestJid === jid
  );
  if (bridgeEntry) {
    const [familyJid] = bridgeEntry;
    if (teksUpper === 'EXIT') {
      await akhiriLiveChatBridge(familyJid, false);
      return;
    }
    const namaLabel = stateScreening[jid]?.namaLengkap || 'Tamu';
    bufferDanKirimPesan(jid, familyJid, teks, `📩 *${namaLabel}:*`);
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
    await kirimPesan(jid, `ℹ️ Formulir sudah diterima. Mohon tunggu giliran Anda.`);
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

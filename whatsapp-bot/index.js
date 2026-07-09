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

/** Kirim permintaan konfirmasi ke anggota keluarga (tamu belum terhubung). */
async function kirimKonfirmasiKeKeluarga(familyJid, tamuData) {
  konfirmasiPending[familyJid] = tamuData;
  const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
  const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

  await kirimPesan(familyJid,
    `🔔 *[TAMU MENUNGGU]*\n\n👤 *${tamuData.namaLengkap}*\n📌 _${tamuData.tujuan}_\n\n` +
    `Apakah Anda ingin membalas pesan tamu ini?\nKetik *YA* untuk menerima.\nKetik *Abaikan* untuk menolak.`
  );
  console.log(`[KONFIRMASI] Menunggu jawaban ${panggilan} untuk tamu ${tamuData.namaLengkap}`);
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
    console.log(`[ANTREAN] Kirim konfirmasi berikutnya untuk ${familyJid}: ${tamuBerikutnya.namaLengkap}`);

    await kirimKonfirmasiKeKeluarga(familyJid, tamuBerikutnya);

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
 * harus membalas "YA" dulu lewat kirimKonfirmasiKeKeluarga().
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
      await kirimKonfirmasiKeKeluarga(familyJid, tamuData);
    } else {
      if (!antreanTamu[familyJid]) antreanTamu[familyJid] = [];
      antreanTamu[familyJid].push(tamuData);
      const posisi = antreanTamu[familyJid].length;
      const keluarga = DATABASE_KELUARGA.find(a => a.nomor === familyJid);
      const panggilan = keluarga?.panggilanUtama || 'Anggota Keluarga';

      await kirimPesan(tamuData.guestJid,
        `⏳ *${panggilan}* sedang berkomunikasi dengan tamu lain.\nPosisi antrean Anda: *#${posisi}*\nKami hubungi saat giliran tiba.`
      );
      await kirimPesan(familyJid,
        `🔔 *[INFO ANTREAN]*\nTamu baru *${tamuData.namaLengkap}* menunggu di antrean #${posisi}.\nKeperluan: _${tamuData.tujuan}_`
      );
      console.log(`[ANTREAN] ${tamuData.namaLengkap} di antrean #${posisi} untuk ${familyJid}`);
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
    `👋 *Selamat datang!*\n\nAnda menghubungi sistem Gatekeeper rumah ini.\nMohon jawab beberapa pertanyaan singkat.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n*Pertanyaan 1 dari 3:*\nSiapa *Nama Lengkap* Anda?`
  );
}

async function prosesJawabanSkrining(guestJid, teks) {
  const state = stateScreening[guestJid];
  if (!state) return;

  if (state.step === 1) {
    state.namaLengkap = teks.trim();
    state.step = 2;
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
    const tamuData = { guestJid, namaLengkap: state.namaLengkap, tujuan: state.tujuan };

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
    const teksLower = teks.trim().toLowerCase();

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
          konfirmasiPending[familyJid] = null;
          await mulaiLiveChatBridge(familyJid, pending);
          return;
        }
        if (teksLower === 'abaikan') {
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
        await kirimPesan(familyJid,
          `ℹ️ Ada tamu menunggu balasan Anda.\nKetik *YA* untuk menerima, atau *Abaikan* untuk menolak.`
        );
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

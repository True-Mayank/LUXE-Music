"use strict";

/* =========================================================
   LUXE MUSIC V4
   Native Android Folder Picker + Browser Fallback
   ========================================================= */


/* =========================================================
   SHORTCUTS
   ========================================================= */

const $ = selector => document.querySelector(selector);

const audio = $("#audio");

const DB_NAME = "luxe_music_database";
const DB_VERSION = 1;
const FILE_STORE = "files";
const SETTINGS_STORE = "settings";

const AUDIO_EXTENSIONS =
  /\.(mp3|m4a|flac|wav|aac|ogg|opus|webm|oga)$/i;


/* =========================================================
   STATE
   ========================================================= */

let songs = [];
let current = -1;

let currentQueue = [];
let queuePosition = -1;

let repeat = false;

let viewMode =
  localStorage.getItem("luxe_view_mode") || "list";

let sortMode =
  localStorage.getItem("luxe_sort_mode") || "default";

let libraryView = "home";
let collectionType = null;
let collectionValue = null;

let folderFiles = [];

let currentPlaylistId = null;

let selectedPlaylistSongs = new Set();

let favorites = [];
let recent = [];
let playlists = [];

let creatingPlaylist = false;
let addSongsBusy = false;
let folderPickerBusy = false;

let nativeLibraryLoaded = false;
let nativeFolderMode = false;
let nativeMetadataRenderTimer = 0;
let nativePlaying = false;
let nativeDuration = 0;
let nativePosition = 0;
let nativeSeeking = false;


/* =========================================================
   RESTORE LOCAL DATA
   ========================================================= */

try {
  favorites = JSON.parse(
    localStorage.getItem("luxe_favorites") || "[]"
  );
} catch {
  favorites = [];
}

try {
  recent = JSON.parse(
    localStorage.getItem("luxe_recent") || "[]"
  );
} catch {
  recent = [];
}

try {
  playlists = JSON.parse(
    localStorage.getItem("luxe_playlists") || "[]"
  );
} catch {
  playlists = [];
}


/* =========================================================
   HELPERS
   ========================================================= */

function esc(value) {
  return String(value ?? "")
    .replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
}


function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  return (
    Math.floor(seconds / 60) +
    ":" +
    String(Math.floor(seconds % 60)).padStart(2, "0")
  );
}


function hourGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) {
    return "Good morning";
  }

  if (hour < 18) {
    return "Good afternoon";
  }

  return "Good evening";
}


function isFav(song) {
  return !!song && favorites.includes(song.id);
}


function makeId(file) {
  return [
    file.name,
    file.size,
    file.lastModified
  ].join("|");
}


function isAudioFile(file) {
  if (!file) {
    return false;
  }

  return (
    (file.type || "")
      .toLowerCase()
      .startsWith("audio/") ||
    AUDIO_EXTENSIONS.test(file.name || "")
  );
}


function parseName(file) {
  const name = file.name
    .replace(/\.[^/.]+$/, "")
    .trim();

  let artist = "Unknown Artist";
  let title = name;
  let album = "Local Music";

  const parts = name.split(/\s[-–—]\s/);

  if (parts.length >= 2) {
    artist = parts[0].trim();

    title = parts
      .slice(1)
      .join(" - ")
      .trim();
  }

  return {
    title,
    artist,
    album
  };
}




/* =========================================================
   EMBEDDED MUSIC ARTWORK — ROBUST READER
   ---------------------------------------------------------
   LUXE reads the cover stored INSIDE the audio file.
   Supported here:
     • MP3 / AAC: ID3v2 APIC + ID3v2.2 PIC
     • FLAC: METADATA_BLOCK_PICTURE
     • M4A / MP4 / M4B: covr atom
   No internet and no external metadata service is used.
   ========================================================= */

const artworkCache = new Map();
const artworkLoading = new Set();

function bytesToAscii(bytes, start = 0, length = bytes.length - start) {
  let out = "";
  const end = Math.min(bytes.length, start + length);
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function decodeText(bytes, encoding = "utf-8") {
  try {
    return new TextDecoder(encoding).decode(bytes).replace(/\0+$/g, "").trim();
  } catch {
    return bytesToAscii(bytes).replace(/\0+$/g, "").trim();
  }
}

function dataUrlFromBytes(bytes, mime = "image/jpeg") {
  if (!bytes || !bytes.length) return null;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return `data:${mime || "image/jpeg"};base64,${btoa(binary)}`;
}

function uint32BE(bytes, offset) {
  return (
    (((bytes[offset] || 0) << 24) >>> 0) +
    ((bytes[offset + 1] || 0) << 16) +
    ((bytes[offset + 2] || 0) << 8) +
    (bytes[offset + 3] || 0)
  ) >>> 0;
}

function synchsafeInt(a, b, c, d) {
  return (
    (a & 0x7f) * 2097152 +
    (b & 0x7f) * 16384 +
    (c & 0x7f) * 128 +
    (d & 0x7f)
  );
}

function removeUnsynchronisation(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return new Uint8Array(out);
}

function mimeFromImageBytes(bytes) {
  if (!bytes || bytes.length < 4) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "image/jpeg";
}

function parseAPICFrame(frame) {
  if (!frame || frame.length < 5) return null;

  const encoding = frame[0];
  let p = 1;

  let mimeEnd = p;
  while (mimeEnd < frame.length && frame[mimeEnd] !== 0) mimeEnd++;
  let mime = decodeText(frame.subarray(p, mimeEnd), "latin1").toLowerCase();
  if (!mime.startsWith("image/")) mime = "image/jpeg";
  p = mimeEnd + 1;

  if (p >= frame.length) return null;
  const pictureType = frame[p++];

  // Description is terminated by 1 or 2 zero bytes depending on encoding.
  const wide = encoding === 1 || encoding === 2 || encoding === 3;
  if (wide) {
    while (p + 1 < frame.length) {
      if (frame[p] === 0 && frame[p + 1] === 0) {
        p += 2;
        break;
      }
      p += 2;
    }
  } else {
    while (p < frame.length && frame[p] !== 0) p++;
    if (p < frame.length) p++;
  }

  if (p >= frame.length) return null;
  const image = frame.subarray(p);
  if (image.length < 16) return null;

  // Prefer front cover (type 3). If this is another picture, it is still a valid fallback.
  return {
    data: dataUrlFromBytes(image, mime || mimeFromImageBytes(image)),
    front: pictureType === 3
  };
}

function parsePICFrame(frame) {
  // ID3v2.2 PIC: encoding(1), image format(3), picture type(1), description, image data.
  if (!frame || frame.length < 6) return null;
  const encoding = frame[0];
  const format = bytesToAscii(frame, 1, 3).toUpperCase();
  let p = 4;
  const pictureType = frame[p++];
  const wide = encoding === 1 || encoding === 2;

  if (wide) {
    while (p + 1 < frame.length) {
      if (frame[p] === 0 && frame[p + 1] === 0) { p += 2; break; }
      p += 2;
    }
  } else {
    while (p < frame.length && frame[p] !== 0) p++;
    if (p < frame.length) p++;
  }

  const image = frame.subarray(p);
  if (image.length < 16) return null;
  const mime = format === "PNG" ? "image/png" : format === "GIF" ? "image/gif" : "image/jpeg";
  return { data: dataUrlFromBytes(image, mime), front: pictureType === 3 };
}

function parseID3Artwork(bytes) {
  if (!bytes || bytes.length < 10 || bytesToAscii(bytes, 0, 3) !== "ID3") return null;

  const version = bytes[3];
  if (version < 2 || version > 4) return null;

  const flags = bytes[5] || 0;
  const tagSize = synchsafeInt(bytes[6], bytes[7], bytes[8], bytes[9]);
  const end = Math.min(bytes.length, 10 + tagSize);
  let pos = 10;

  // Extended header. Frame offsets MUST be calculated from the original tag bytes;
  // unsynchronisation is removed only from an individual frame payload below.
  if (flags & 0x40) {
    if (version === 3 && pos + 4 <= end) {
      const extSize = uint32BE(bytes, pos);
      pos += 4 + extSize;
    } else if (version === 4 && pos + 4 <= end) {
      const extSize = synchsafeInt(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      pos += extSize;
    }
  }

  let fallback = null;

  while (pos < end) {
    const headerSize = version === 2 ? 6 : 10;
    if (pos + headerSize > end) break;

    const idLength = version === 2 ? 3 : 4;
    const id = bytesToAscii(bytes, pos, idLength);
    if (!id || /^\0+$/.test(id)) break;

    let frameSize;
    if (version === 2) {
      frameSize = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5];
    } else if (version === 4) {
      frameSize = synchsafeInt(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    } else {
      frameSize = uint32BE(bytes, pos + 4);
    }

    if (!frameSize || pos + headerSize + frameSize > end) break;

    const frameStart = pos + headerSize;
    let frame = bytes.subarray(frameStart, frameStart + frameSize);

    // ID3v2.4 frame flags: format byte low bits contain the unsynchronisation flag.
    // Tag-level unsynchronisation is handled here too, after frame boundaries are known.
    const frameFlags = version >= 3
      ? (((bytes[pos + 8] || 0) << 8) | (bytes[pos + 9] || 0))
      : 0;
    const frameUnsync = version === 4 && !!(frameFlags & 0x0002);
    if ((flags & 0x80) || frameUnsync) frame = removeUnsynchronisation(frame);

    let result = null;
    if (version === 2 && id === "PIC") result = parsePICFrame(frame);
    if (version >= 3 && id === "APIC") result = parseAPICFrame(frame);

    if (result?.data) {
      if (result.front) return result.data;
      if (!fallback) fallback = result.data;
    }

    pos += headerSize + frameSize;
  }

  return fallback;
}

function parseFLACArtwork(bytes) {
  if (!bytes || bytes.length < 4 || bytesToAscii(bytes, 0, 4) !== "fLaC") return null;

  let pos = 4;
  while (pos + 4 <= bytes.length) {
    const header = bytes[pos];
    const type = header & 0x7f;
    const last = !!(header & 0x80);
    const size = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const start = pos + 4;
    const end = start + size;
    if (end > bytes.length) break;

    if (type === 6 && size >= 32) {
      let p = start;
      const pictureType = uint32BE(bytes, p); p += 4;
      const mimeLen = uint32BE(bytes, p); p += 4;
      if (p + mimeLen > end) break;
      const mime = decodeText(bytes.subarray(p, p + mimeLen), "latin1") || "image/jpeg";
      p += mimeLen;
      if (p + 4 > end) break;
      const descLen = uint32BE(bytes, p); p += 4;
      p += descLen;
      if (p + 20 > end) break;
      p += 16; // width, height, depth, colors
      const dataLen = uint32BE(bytes, p); p += 4;
      if (dataLen > 0 && p + dataLen <= end) {
        const image = bytes.subarray(p, p + dataLen);
        const data = dataUrlFromBytes(image, mime.startsWith("image/") ? mime : mimeFromImageBytes(image));
        if (pictureType === 3) return data;
        if (data) return data;
      }
    }

    pos = end;
    if (last) break;
  }
  return null;
}

function readAtom(bytes, offset, limit) {
  if (offset + 8 > limit) return null;
  let size = uint32BE(bytes, offset);
  const type = bytesToAscii(bytes, offset + 4, 4);
  let header = 8;
  if (size === 1 && offset + 16 <= limit) {
    const hi = uint32BE(bytes, offset + 8);
    const lo = uint32BE(bytes, offset + 12);
    if (hi !== 0) return null;
    size = lo;
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < header || offset + size > limit) return null;
  return { start: offset, header, end: offset + size, type };
}

function findAtomRecursive(bytes, start, end, target) {
  const containers = new Set(["moov", "udta", "meta", "ilst", "trak", "mdia", "minf", "stbl"]);
  let pos = start;
  while (pos + 8 <= end) {
    const atom = readAtom(bytes, pos, end);
    if (!atom) break;
    if (atom.type === target) return atom;
    if (containers.has(atom.type)) {
      const childStart = atom.start + atom.header + (atom.type === "meta" ? 4 : 0);
      const nested = findAtomRecursive(bytes, childStart, atom.end, target);
      if (nested) return nested;
    }
    pos = atom.end;
  }
  return null;
}

function parseMP4Artwork(bytes) {
  if (!bytes || bytes.length < 16) return null;
  const moov = findAtomRecursive(bytes, 0, bytes.length, "moov");
  if (!moov) return null;
  const covr = findAtomRecursive(bytes, moov.start + moov.header, moov.end, "covr");
  if (!covr) return null;

  let pos = covr.start + covr.header;
  while (pos + 8 <= covr.end) {
    const atom = readAtom(bytes, pos, covr.end);
    if (!atom) break;
    if (atom.type === "data" && atom.end - (atom.start + atom.header) >= 16) {
      const payload = atom.start + atom.header;
      const dataType = uint32BE(bytes, payload);
      const image = bytes.subarray(payload + 16, atom.end);
      if (image.length) {
        const mime = dataType === 14 ? "image/png" : mimeFromImageBytes(image);
        return dataUrlFromBytes(image, mime);
      }
    }
    pos = atom.end;
  }
  return null;
}

function normalizeArtworkValue(value) {
  if (!value) return null;
  if (typeof value !== "string") return null;
  if (value.startsWith("data:image/")) return value;
  // Native Android may send base64 without a data prefix.
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 100) {
    return `data:image/jpeg;base64,${value.replace(/\s/g, "")}`;
  }
  return value;
}

async function getBinaryForSong(song) {
  if (song?.file instanceof Blob) {
    return new Uint8Array(await song.file.arrayBuffer());
  }
  if (song?.nativeUrl) {
    const response = await fetch(song.nativeUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Artwork fetch failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return null;
}

async function extractEmbeddedArtwork(song) {
  if (!song) return null;

  const supplied = normalizeArtworkValue(song.artwork);
  if (supplied) {
    song.artwork = supplied;
    artworkCache.set(song.id, supplied);
    return supplied;
  }

  if (artworkCache.has(song.id)) return artworkCache.get(song.id);
  if (artworkLoading.has(song.id)) return null;

  artworkLoading.add(song.id);
  try {
    const bytes = await getBinaryForSong(song);
    if (!bytes || bytes.length < 12) return null;

    const name = String(song.name || song.file?.name || "").toLowerCase();
    let artwork = null;

    // Try based on extension first, then signature-based fallbacks.
    if (/\.(mp3|aac|m4a)$/.test(name)) artwork = parseID3Artwork(bytes);
    if (!artwork && /^fLaC/i.test(bytesToAscii(bytes, 0, 4))) artwork = parseFLACArtwork(bytes);
    if (!artwork && /\.(m4a|mp4|m4b)$/.test(name)) artwork = parseMP4Artwork(bytes);

    // Signature fallback catches files whose MIME/extension is misleading.
    if (!artwork && bytesToAscii(bytes, 0, 3) === "ID3") artwork = parseID3Artwork(bytes);
    if (!artwork && bytesToAscii(bytes, 0, 4) === "fLaC") artwork = parseFLACArtwork(bytes);
    if (!artwork && (bytesToAscii(bytes, 4, 4) === "ftyp" || bytesToAscii(bytes, 4, 4) === "moov")) {
      artwork = parseMP4Artwork(bytes);
    }

    if (artwork) {
      artworkCache.set(song.id, artwork);
      song.artwork = artwork;
      return artwork;
    }
  } catch (error) {
    console.debug("LUXE artwork read skipped:", song.name || song.title, error);
  } finally {
    artworkLoading.delete(song.id);
  }

  return null;
}

function refreshArtwork(song) {
  if (!song) return;
  const safeId = CSS.escape(String(song.id));
  document.querySelectorAll(`[data-song-id="${safeId}"] .art`).forEach(el => {
    if (song.artwork) {
      el.innerHTML = `<img src="${esc(song.artwork)}" alt="" loading="lazy">`;
      el.classList.add("has-real-art");
    }
  });
  if (current >= 0 && songs[current]?.id === song.id) updatePlayerArtwork();
}

async function loadArtworkForSongs(list) {
  // Native Android extracts embedded artwork in the background. Do not fetch
  // every local audio file through WebView during render; that defeats caching.
  if (isNativeAndroid()) return;

  const unique = [];
  const seen = new Set();
  for (const song of list || []) {
    if (!song || seen.has(song.id)) continue;
    seen.add(song.id);
    unique.push(song);
  }

  // Read covers concurrently in small batches. The first batch appears quickly,
  // while the rest continues without blocking playback or scrolling.
  const batchSize = 6;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    await Promise.all(batch.map(async song => {
      if (song.artwork || artworkCache.has(song.id)) return;
      const artwork = await extractEmbeddedArtwork(song);
      if (artwork) refreshArtwork(song);
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(value)
    );
  } catch {}
}


function shuffleArray(array) {
  for (
    let i = array.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [
      array[i],
      array[j]
    ] = [
      array[j],
      array[i]
    ];
  }

  return array;
}


/* =========================================================
   ANDROID NATIVE DETECTION
   ========================================================= */

function isNativeAndroid() {
  return !!(
    window.LuxeAndroid &&
    typeof window.LuxeAndroid.pickMusicFolder ===
      "function"
  );
}


/* ---------------------------------------------------------
   ANDROID TOUCH-FOCUS CLEANUP
   Android WebView can keep a blue focus rectangle on a
   tapped button even when CSS tap highlighting is disabled.
--------------------------------------------------------- */
document.addEventListener("pointerup", event => {
  const button = event.target?.closest?.("button");
  if (!button) return;

  setTimeout(() => {
    try { button.blur(); } catch {}
  }, 0);
}, true);

document.addEventListener("touchend", event => {
  const button = event.target?.closest?.("button");
  if (!button) return;

  setTimeout(() => {
    try { button.blur(); } catch {}
  }, 0);
}, { passive: true, capture: true });


/* =========================================================
   INDEXED DB
   ========================================================= */

let dbPromise = null;


function openDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise(resolve => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }

    let request;

    try {
      request = indexedDB.open(
        DB_NAME,
        DB_VERSION
      );
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = event => {
      const db = event.target.result;

      if (
        !db.objectStoreNames.contains(
          FILE_STORE
        )
      ) {
        db.createObjectStore(
          FILE_STORE,
          {
            keyPath: "id"
          }
        );
      }

      if (
        !db.objectStoreNames.contains(
          SETTINGS_STORE
        )
      ) {
        db.createObjectStore(
          SETTINGS_STORE,
          {
            keyPath: "key"
          }
        );
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        db.close();
      };

      resolve(db);
    };

    request.onerror = () => {
      resolve(null);
    };
  });

  return dbPromise;
}


async function saveFilesToDatabase(files) {
  const db = await openDB();

  if (!db || !files.length) {
    return false;
  }

  return new Promise(resolve => {
    try {
      const transaction =
        db.transaction(
          FILE_STORE,
          "readwrite"
        );

      const store =
        transaction.objectStore(
          FILE_STORE
        );

      for (const file of files) {
        store.put({
          id: makeId(file),
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          type: file.type,
          file
        });
      }

      transaction.oncomplete =
        () => resolve(true);

      transaction.onerror =
        () => resolve(false);

      transaction.onabort =
        () => resolve(false);

    } catch {
      resolve(false);
    }
  });
}


async function loadFilesFromDatabase() {
  const db = await openDB();

  if (!db) {
    return [];
  }

  return new Promise(resolve => {
    try {
      const transaction =
        db.transaction(
          FILE_STORE,
          "readonly"
        );

      const store =
        transaction.objectStore(
          FILE_STORE
        );

      const request =
        store.getAll();

      request.onsuccess = () => {
        const result =
          request.result || [];

        resolve(
          result
            .map(item => item.file)
            .filter(Boolean)
        );
      };

      request.onerror =
        () => resolve([]);

    } catch {
      resolve([]);
    }
  });
}


async function saveSetting(key, value) {
  const db = await openDB();

  if (!db) {
    return;
  }

  try {
    const transaction =
      db.transaction(
        SETTINGS_STORE,
        "readwrite"
      );

    transaction
      .objectStore(
        SETTINGS_STORE
      )
      .put({
        key,
        value
      });

  } catch {}
}


async function getSetting(key) {
  const db = await openDB();

  if (!db) {
    return null;
  }

  return new Promise(resolve => {
    try {
      const transaction =
        db.transaction(
          SETTINGS_STORE,
          "readonly"
        );

      const request =
        transaction
          .objectStore(
            SETTINGS_STORE
          )
          .get(key);

      request.onsuccess = () => {
        resolve(
          request.result
            ? request.result.value
            : null
        );
      };

      request.onerror =
        () => resolve(null);

    } catch {
      resolve(null);
    }
  });
}


/* =========================================================
   FOLDER PICKER
   ========================================================= */

const chooseFolderBtn =
  $("#chooseFolderBtn");

const folderInput =
  $("#folderInput");


function setFolderStatus(message) {
  const status =
    $("#folderStatus");

  if (status) {
    status.textContent =
      message;
  }
}


/* ---------------------------------------------------------
   OPEN MUSIC FOLDER
--------------------------------------------------------- */

function openMusicFolder() {
  if (folderPickerBusy) {
    return;
  }

  folderPickerBusy = true;

  /*
    IMPORTANT:
    Android native picker comes FIRST.
  */

  if (isNativeAndroid()) {
    nativeFolderMode = true;

    setFolderStatus(
      "Opening music folder..."
    );

    try {
      window.LuxeAndroid.pickMusicFolder();

    } catch (error) {

      console.error(
        "Native folder picker error:",
        error
      );

      setFolderStatus(
        "Unable to open the music folder picker."
      );

      folderPickerBusy = false;
    }

    return;
  }


  /*
    Browser fallback
  */

  nativeFolderMode = false;

  if (
    typeof window.showDirectoryPicker ===
    "function"
  ) {

    window.showDirectoryPicker({
      mode: "read"
    })
    .then(async directory => {

      const files = [];

      await collectDirectoryFiles(
        directory,
        files
      );

      if (files.length) {

        await loadSelectedFiles(
          files
        );

      } else {

        setFolderStatus(
          "No supported music files were found."
        );
      }

    })
    .catch(error => {

      if (
        error &&
        error.name === "AbortError"
      ) {
        return;
      }

      if (folderInput) {
        folderInput.value = "";
        folderInput.click();
      }

    })
    .finally(() => {

      setTimeout(() => {
        folderPickerBusy = false;
      }, 300);

    });

    return;
  }


  /*
    Older browser fallback
  */

  if (folderInput) {
    folderInput.value = "";
    folderInput.click();
  }

  setTimeout(() => {
    folderPickerBusy = false;
  }, 300);
}


/* ---------------------------------------------------------
   BROWSER DIRECTORY SCANNER
   --------------------------------------------------------- */

async function collectDirectoryFiles(
  directory,
  output
) {
  for await (
    const entry of directory.values()
  ) {

    /*
      LUXE scans ONLY the selected folder.
      Subfolders are intentionally ignored.
    */

    if (entry.kind !== "file") {
      continue;
    }

    try {

      const file =
        await entry.getFile();

      if (isAudioFile(file)) {
        output.push(file);
      }

    } catch {}
  }
}


/* ---------------------------------------------------------
   SELECT BUTTON
--------------------------------------------------------- */

if (chooseFolderBtn) {

  chooseFolderBtn.addEventListener(
    "click",
    event => {

      event.preventDefault();
      event.stopPropagation();

      openMusicFolder();

    }
  );
}


/* ---------------------------------------------------------
   BROWSER FILE INPUT
--------------------------------------------------------- */

if (folderInput) {

  folderInput.addEventListener(
    "change",
    async event => {

      if (folderPickerBusy) {
        return;
      }

      const files =
        [
          ...(event.target.files || [])
        ].filter(isAudioFile);

      if (!files.length) {

        setFolderStatus(
          "No supported music files were found."
        );

        return;
      }

      await loadSelectedFiles(
        files
      );

    }
  );
}


/* =========================================================
   NATIVE ANDROID CALLBACKS
   ========================================================= */

/*
  MainActivity.java calls:

  window.LUXEAndroid.onFolderSelected(payload)

  The payload contains:

  {
    folderUri: "...",
    count: 10,
    songs: [
      {
        id: "...",
        name: "...",
        mime: "...",
        size: 123,
        lastModified: 123,
        url: "https://luxe.local/audio/TOKEN",
        title: "...",
        artist: "...",
        album: "Local Music"
      }
    ]
  }
*/

window.LUXEAndroid = {

  /* -------------------------------------------------------
     NATIVE STATUS
  ------------------------------------------------------- */

  onNativeStatus(message) {
    setFolderStatus(String(message || ""));
  },

  /* -------------------------------------------------------
     BACKGROUND NATIVE METADATA UPDATE
  ------------------------------------------------------- */

  onNativeSongMetadataUpdated(payload) {
    try {
      if (typeof payload === "string") payload = JSON.parse(payload);
      if (!payload?.id) return;

      const song = songs.find(item => item.id === payload.id);
      if (!song) return;

      if (payload.title) song.title = payload.title;
      if (payload.artist) song.artist = payload.artist;
      if (payload.album) song.album = payload.album;

      // Many files can finish metadata extraction close together. Debounce
      // rendering so hundreds of callbacks never cause hundreds of full renders.
      clearTimeout(nativeMetadataRenderTimer);
      nativeMetadataRenderTimer = setTimeout(() => {
        render();
        updatePlayer();
      }, 180);
    } catch (error) {
      console.debug("LUXE native metadata update skipped:", error);
    }
  },

  /* -------------------------------------------------------
     BACKGROUND NATIVE EMBEDDED ARTWORK UPDATE
  ------------------------------------------------------- */

  onNativeArtworkUpdated(songId, artwork) {
    try {
      const song = songs.find(item => item.id === songId);
      if (!song || !artwork) return;

      const normalized = normalizeArtworkValue(artwork);
      if (!normalized) return;

      song.artwork = normalized;
      artworkCache.set(song.id, normalized);
      refreshArtwork(song);
    } catch (error) {
      console.debug("LUXE native artwork update skipped:", error);
    }
  },

  /* -------------------------------------------------------
     NATIVE FOLDER SELECTED
  ------------------------------------------------------- */

  onFolderSelected(payload) {

    try {

      /*
        MainActivity sends a JSON string using
        JSONObject.quote(), so normally payload
        arrives here as a string.
      */

      if (
        typeof payload === "string"
      ) {
        payload =
          JSON.parse(payload);
      }


      const nativeSongs =
        Array.isArray(
          payload?.songs
        )
          ? payload.songs
          : [];


      if (!nativeSongs.length) {

        songs = [];

        nativeLibraryLoaded = true;

        setFolderStatus(
          "No supported music files were found."
        );

        $("#welcome")
          ?.classList.remove(
            "hidden"
          );

        $("#library")
          ?.classList.add(
            "hidden"
          );

        $("#nav")
          ?.classList.add(
            "hidden"
          );

        folderPickerBusy =
          false;

        return;
      }


      /*
        Native Android is now the
        source of the music library.
      */

      nativeLibraryLoaded =
        true;

      nativeFolderMode =
        true;


      songs =
        nativeSongs.map(
          (item, index) => ({

            /*
              Native content URI is used
              as the stable ID.
            */

            id:
              item.id,

            title:
              item.title ||
              item.name ||
              "Unknown",

            artist:
              item.artist ||
              "Unknown Artist",

            album:
              item.album ||
              "Local Music",

            artwork:
              normalizeArtworkValue(item.artwork) ||
              null,

            /*
              Native songs do not use
              browser File objects.
            */

            file:
              null,

            /*
              MainActivity creates this
              special intercepted URL.
            */

            nativeUrl:
              item.url,

            name:
              item.name,

            size:
              Number(
                item.size || 0
              ),

            lastModified:
              Number(
                item.lastModified || 0
              ),

            mime:
              item.mime ||
              "audio/*",

            index

          })
        );


      folderFiles = [];


      /*
        Keep favorites only for
        songs that still exist.
      */

      const validIds =
        new Set(
          songs.map(
            song =>
              song.id
          )
        );


      favorites =
        favorites.filter(
          id =>
            validIds.has(id)
        );


      recent =
        recent.filter(
          id =>
            validIds.has(id)
        );


      /*
        Clean playlist songs.
      */

      playlists =
        playlists.map(
          playlist => ({

            ...playlist,

            songs:
              Array.isArray(
                playlist.songs
              )
                ? playlist.songs.filter(
                    id =>
                      validIds.has(id)
                  )
                : []

          })
        );


      saveJSON(
        "luxe_favorites",
        favorites
      );

      saveJSON(
        "luxe_recent",
        recent
      );

      saveJSON(
        "luxe_playlists",
        playlists
      );


      /*
        Show LUXE library.
      */

      $("#welcome")
        ?.classList.add(
          "hidden"
        );

      $("#library")
        ?.classList.remove(
          "hidden"
        );

      $("#nav")
        ?.classList.remove(
          "hidden"
        );


      if ($("#hello")) {
        $("#hello").textContent =
          hourGreeting();
      }


      setFolderStatus(
        `${songs.length} music files loaded locally.`
      );


      updateStats();

      renderHome();

      render();

      updateViewButtons();


    } catch (error) {

      console.error(
        "LUXE native folder error:",error
      );

      nativeLibraryLoaded =
        false;

      setFolderStatus(
        "Unable to load the selected music folder."
      );

    } finally {

      folderPickerBusy =
        false;

    }
  },


  /* -------------------------------------------------------
     NATIVE ERROR
  ------------------------------------------------------- */

  onError(message) {

    console.error(
      "LUXE Android:",
      message
    );

    folderPickerBusy =
      false;

    setFolderStatus(
      message ||
      "Unable to read the selected folder."
    );
  },


  /* -------------------------------------------------------
     NATIVE FOLDER CLEARED
  ------------------------------------------------------- */

  onFolderCleared() {

    nativeLibraryLoaded =
      false;

    nativeFolderMode =
      true;

    songs = [];

    current = -1;

    currentQueue = [];

    queuePosition = -1;

    folderFiles = [];

    if (audio) {

      audio.pause();

      audio.removeAttribute(
        "src"
      );

      audio.load();
    }


    $("#welcome")
      ?.classList.remove(
        "hidden"
      );

    $("#library")
      ?.classList.add(
        "hidden"
      );

    $("#nav")
      ?.classList.add(
        "hidden"
      );

    $("#miniPlayer")
      ?.classList.add(
        "hidden"
      );


    setFolderStatus(
      "Music folder cleared."
    );


    updateStats();

    renderHome();

    render();

  }

};


/* =========================================================
   BUILD LIBRARY FROM BROWSER FILES
   ========================================================= */

async function loadSelectedFiles(files) {

  const validFiles =
    [...files].filter(
      isAudioFile
    );


  if (!validFiles.length) {

    setFolderStatus(
      "No supported music files were found."
    );

    return;
  }


  nativeLibraryLoaded =
    false;

  nativeFolderMode =
    false;


  folderFiles =
    [...validFiles];


  await saveFilesToDatabase(
    folderFiles
  );


  await buildLibrary(
    folderFiles
  );
}


async function buildLibrary(files) {

  folderFiles =
    [...files].filter(
      isAudioFile
    );


  songs =
    folderFiles.map(
      (file, index) => {

        const metadata =
          parseName(file);

        return {

          ...metadata,

          file,

          index,

          id:
            makeId(file),

          artwork:
            artworkCache.get(makeId(file)) ||
            null,

          nativeUrl:
            null
        };
      }
    );


  const validIds =
    new Set(
      songs.map(
        song =>
          song.id
      )
    );


  favorites =
    favorites.filter(
      id =>
        validIds.has(id)
    );


  recent =
    recent.filter(
      id =>
        validIds.has(id)
    );


  playlists =
    playlists.map(
      playlist => ({

        ...playlist,

        songs:
          Array.isArray(
            playlist.songs
          )
            ? playlist.songs.filter(
                id =>
                  validIds.has(id)
              )
            : []

      })
    );


  saveJSON(
    "luxe_favorites",
    favorites
  );

  saveJSON(
    "luxe_recent",
    recent
  );

  saveJSON(
    "luxe_playlists",
    playlists
  );


  $("#welcome")
    ?.classList.add(
      "hidden"
    );

  $("#library")
    ?.classList.remove(
      "hidden"
    );

  $("#nav")
    ?.classList.remove(
      "hidden"
    );


  if ($("#hello")) {
    $("#hello").textContent =
      hourGreeting();
  }


  setFolderStatus(
    `${songs.length} music files loaded locally.`
  );


  updateStats();

  renderHome();

  render();
}


async function tryRestoreLibrary() {

  /*
    Android handles its own persistent
    folder restoration through MainActivity.java.
  */

  if (isNativeAndroid()) {
    return false;
  }


  const storedFiles =
    await loadFilesFromDatabase();


  if (!storedFiles.length) {
    return false;
  }


  await buildLibrary(
    storedFiles
  );

  return true;
}


/* =========================================================
   STATISTICS
   ========================================================= */

function updateStats() {

  const artists =
    new Set(
      songs.map(
        song =>
          song.artist
      )
    );


  const albums =
    new Set(
      songs.map(
        song =>
          song.album
      )
    );


  if ($("#songCount")) {
    $("#songCount").textContent =
      songs.length;
  }


  if ($("#artistCount")) {
    $("#artistCount").textContent =
      artists.size;
  }


  if ($("#albumCount")) {
    $("#albumCount").textContent =
      albums.size;
  }


  if ($("#homeSongCount")) {
    $("#homeSongCount").textContent =
      `${songs.length} tracks`;
  }


  if ($("#homeArtistCount")) {
    $("#homeArtistCount").textContent =
      `${artists.size} artists`;
  }


  if ($("#homePlaylistCount")) {
    $("#homePlaylistCount").textContent =
      `${playlists.length} playlists`;
  }


  if ($("#homeFavoriteCount")) {
    $("#homeFavoriteCount").textContent =
      `${favorites.length} songs`;
  }
}


/* =========================================================
   HOME
   ========================================================= */

function renderHome() {

  const container =
    $("#recentHome");


  if (!container) {
    return;
  }


  const recentSongs =
    recent
      .map(id =>
        songs.find(
          song =>
            song.id === id
        )
      )
      .filter(Boolean)
      .slice(0, 8);


  if (!recentSongs.length) {

    container.innerHTML = `
      <div class="empty recent-empty">
        <div class="recent-empty-icon">♪</div>
        <strong>No recently played songs</strong>
        <span>Play a song and it will appear here.</span>
      </div>
    `;

    return;
  }


  container.innerHTML =
    recentSongs
      .map(song => `

        <button
          class="recent-card"
          type="button"
          data-recent-play="${esc(song.id)}"
        >

          ${artHTML(song, "small")}

          <div class="recent-card-info">

            <strong>
              ${esc(song.title)}
            </strong>

            <span>
              ${esc(song.artist)}
            </span>

          </div>

          <div class="recent-card-play">
            ▶
          </div>

        </button>

      `)
      .join("");
}


if ($("#recentHome")) {

  $("#recentHome").addEventListener(
    "click",
    event => {

      const card =
        event.target.closest(
          "[data-recent-play]"
        );


      if (!card) {
        return;
      }


      const song =
        songs.find(
          item =>
            item.id ===
            card.dataset.recentPlay
        );


      if (song) {

        playSong(
          songs.indexOf(song),
          recent
            .map(id =>
              songs.find(
                item =>
                  item.id === id
              )
            )
            .filter(Boolean)
        );
      }
    }
  );
}


/* =========================================================
   HOME ACTION BUTTONS
   ========================================================= */

document
  .querySelectorAll(
    ".library-action"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      event => {

        event.preventDefault();

        const target =
          button.dataset.library;

        collectionType = null;

        collectionValue = null;

        setLibraryView(
          target
        );

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });

      }
    );

  });


if ($("#seeRecentBtn")) {

  $("#seeRecentBtn").addEventListener(
    "click",
    () => {

      collectionType = null;

      collectionValue = null;

      setLibraryView(
        "recent"
      );

      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });

    }
  );
}


if ($("#shuffleAllBtn")) {

  $("#shuffleAllBtn").addEventListener(
    "click",
    () => {

      if (!songs.length) {
        return;
      }


      const queue =
        shuffleArray(
          [...songs]
        );


      playSong(
        songs.indexOf(
          queue[0]
        ),
        queue
      );

    }
  );
}


if ($("#playAllBtn")) {

  $("#playAllBtn").addEventListener(
    "click",
    () => {

      if (!songs.length) {
        return;
      }


      playSong(
        0,
        [...songs]
      );

    }
  );
}


/* =========================================================
   VIEW MANAGEMENT
   ========================================================= */

function setLibraryView(
  view,
  value = null
) {

  libraryView =
    view;

  collectionValue =
    value;


  if (!value) {
    collectionType = null;
  }


  updateTabs();

  render();
}


function updateTabs() {

  document
    .querySelectorAll(
      ".library-tab"
    )
    .forEach(button => {

      button.classList.toggle(
        "active",
        button.dataset.library ===
          libraryView
      );

    });
}


function getSearchResults() {

  const search =
    $("#search");


  if (!search) {
    return [...songs];
  }


  const query =
    search.value
      .toLowerCase()
      .trim();


  if (!query) {
    return [...songs];
  }


  return songs.filter(song =>

    (
      song.title +
      " " +
      song.artist +
      " " +
      song.album
    )
      .toLowerCase()
      .includes(query)

  );
}




/* =========================================================
   SORTING
   ========================================================= */

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function sortSongs(list) {
  const sorted = [...list];
  switch (sortMode) {
    case "title-desc":
      return sorted.sort((a, b) => compareText(b.title, a.title));
    case "artist-asc":
      return sorted.sort((a, b) => compareText(a.artist, b.artist) || compareText(a.title, b.title));
    case "artist-desc":
      return sorted.sort((a, b) => compareText(b.artist, a.artist) || compareText(a.title, b.title));
    case "album-asc":
      return sorted.sort((a, b) => compareText(a.album, b.album) || compareText(a.title, b.title));
    case "album-desc":
      return sorted.sort((a, b) => compareText(b.album, a.album) || compareText(a.title, b.title));
    case "newest":
      return sorted.sort((a, b) => Number(b.lastModified || 0) - Number(a.lastModified || 0));
    case "oldest":
      return sorted.sort((a, b) => Number(a.lastModified || 0) - Number(b.lastModified || 0));
    case "file-asc":
      return sorted.sort((a, b) => compareText(a.name, b.name));
    case "file-desc":
      return sorted.sort((a, b) => compareText(b.name, a.name));
    case "title-asc":
      return sorted.sort((a, b) => compareText(a.title, b.title));
    default:
      return sorted;
  }
}

function applySortToCurrentView() {
  if (!songs.length) return;
  render();
  loadArtworkForSongs(getSearchResults()).catch(() => {});
}

/* =========================================================
   MAIN RENDER
   ========================================================= */

function render() {

  if (!$("#songList")) {
    return;
  }


  const allSongs =
    getSearchResults();


  $("#quickLibrary")
    ?.classList.add(
      "hidden"
    );


  if ($("#breadcrumb")) {

    $("#breadcrumb")
      .classList.toggle(
        "hidden",
        !collectionValue
      );


    if (collectionValue) {

      $("#breadcrumb").innerHTML = `

        <button
          type="button"
          data-back-library
        >
          Library
        </button>

        <span>/</span>

        <strong>
          ${esc(collectionValue)}
        </strong>

      `;
    }
  }


  /* HOME */

  if (
    libraryView === "home" &&
    !collectionValue
  ) {

    $("#homeContent")
      ?.classList.remove(
        "hidden"
      );

    $("#songList")
      ?.classList.add(
        "hidden"
      );

    $("#collectionGrid")
      ?.classList.add(
        "hidden"
      );

    $("#playlistGrid")
      ?.classList.add(
        "hidden"
      );


    if ($("#sectionHeading")) {
      $("#sectionHeading")
        .textContent =
        "Your Music";
    }


    if ($("#resultCount")) {
      $("#resultCount")
        .textContent = "";
    }


    renderHome();

    return;
  }


  $("#homeContent")
    ?.classList.add(
      "hidden"
    );


  let list =
    [...allSongs];


  /* FAVORITES */

  if (
    libraryView === "favorites"
  ) {

    list =
      allSongs.filter(
        isFav
      );
  }


  /* RECENT */

  if (
    libraryView === "recent"
  ) {

    list =
      recent
        .map(id =>
          allSongs.find(
            song =>
              song.id === id
          )
        )
        .filter(Boolean);
  }


  /* ARTIST */

  if (
    collectionType === "artist" &&
    collectionValue
  ) {

    list =
      allSongs.filter(
        song =>
          song.artist ===
          collectionValue
      );
  }


  /* ALBUM */

  if (
    collectionType === "album" &&
    collectionValue
  ) {

    list =
      allSongs.filter(
        song =>
          song.album ===
          collectionValue
      );
  }


  list = sortSongs(list);


  /* PLAYLIST PAGE */

  if (
    libraryView === "playlists" &&
    !collectionValue
  ) {

    renderPlaylists();

    return;
  }


  /* COLLECTIONS */

  const showCollections =
    (
      libraryView === "artists" ||
      libraryView === "albums"
    ) &&
    !collectionValue;


  $("#collectionGrid")
    ?.classList.toggle(
      "hidden",
      !showCollections
    );


  $("#playlistGrid")
    ?.classList.add(
      "hidden"
    );


  $("#songList")
    ?.classList.toggle(
      "hidden",
      showCollections
    );


  if (showCollections) {

    renderCollections(
      allSongs
    );

    return;
  }


  /* NORMAL SONG LIST */

  if ($("#sectionHeading")) {

    $("#sectionHeading")
      .textContent =
      collectionValue ||
      (
        libraryView === "songs"
          ? "All Songs"
          : libraryView === "favorites"
          ? "Favorites"
          : libraryView === "recent"
          ? "Recently Played"
          : "Your Music"
      );
  }


  if ($("#resultCount")) {

    $("#resultCount")
      .textContent =
      `${list.length} tracks`;
  }


  $("#songList")
    ?.classList.remove(
      "hidden"
    );


  $("#songList")
    ?.classList.toggle(
      "grid-view",
      viewMode === "grid"
    );


  $("#empty")
    ?.classList.toggle(
      "hidden",
      list.length !== 0
    );


  $("#songList").innerHTML =
    list
      .map(
        song =>
          songHTML(song)
      )
      .join("");
}


/* =========================================================
   COLLECTIONS
   ========================================================= */

function renderCollections(
  allSongs
) {

  const key =
    libraryView === "artists"
      ? "artist"
      : "album";


  const items =
    [
      ...new Set(
        allSongs.map(
          song =>
            song[key]
        )
      )]
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.localeCompare(
            b,
            undefined,
            {
              sensitivity:
                "base"
            }
          )
      );


  if ($("#sectionHeading")) {

    $("#sectionHeading")
      .textContent =
      key === "artist"
        ? "Artists"
        : "Albums";
  }


  if ($("#resultCount")) {

    $("#resultCount")
      .textContent =
      `${items.length}`;
  }


  if ($("#collectionGrid")) {

    $("#collectionGrid").innerHTML =
      items
        .map(value => {

          const count =
            allSongs.filter(
              song =>
                song[key] ===
                value
            ).length;


          return `

            <button
              class="collection-card"
              type="button"
              data-collection="${esc(value)}"
              data-type="${key}"
            >

              <div class="collection-art">
                ${key === "artist" ? "♟" : "▣"}
              </div>

              <strong>
                ${esc(value)}
              </strong>

              <span>
                ${count} tracks
              </span>

            </button>

          `;
        })
        .join("");
  }
}


/* =========================================================
   SONG HTML
   ========================================================= */

function songHTML(song) {

  return `

    <div
      class="song"
      data-song-id="${esc(song.id)}"
      title="Tap anywhere to play"
    >

      ${artHTML(song, "small")}

      <div class="song-info">

        <strong>
          ${esc(song.title)}
        </strong>

        <span>
          ${esc(song.artist)}
          •
          ${esc(song.album)}
        </span>

      </div>

      <div class="song-actions">

        <button
          class="fav ${isFav(song) ? "" : "muted"}"
          data-fav="${esc(song.id)}"
          aria-label="Favorite"
          type="button"
        >
          ${isFav(song) ? "♥" : "♡"}
        </button>

        <button
          class="play-action"
          data-play="${esc(song.id)}"
          aria-label="Play"
          type="button"
        >
          ▶
        </button>

      </div>

    </div>

  `;
}


/* =========================================================
   ARTWORK
   ========================================================= */

function artHTML(
  song,
  size = "small"
) {

  const first =
    (song.title || "♪")
      .trim()
      .charAt(0)
      .toUpperCase();


  const className =
    size === "big"
      ? "big-art"
      : "small-art";


  if (song.artwork) {

    return `

      <div
        class="art ${className}"
      >

        <img
          src="${esc(song.artwork)}"
          alt=""
        >

      </div>

    `;
  }


  return `

    <div
      class="art ${className}"
    >
      ${esc(first || "♪")}
    </div>

  `;
}


/* =========================================================
   SONG LIST CLICK
   ========================================================= */

if ($("#songList")) {

  $("#songList").addEventListener(
    "click",
    event => {

      const fav =
        event.target.closest(
          "[data-fav]"
        );


      if (fav) {

        toggleFavorite(
          fav.dataset.fav
        );

        return;
      }


      const play =
        event.target.closest(
          "[data-play]"
        );


      if (play) {

        const song =
          songs.find(
            item =>
              item.id ===
              play.dataset.play
          );


        if (song) {

          playSong(
            songs.indexOf(song),
            getCurrentVisibleQueue()
          );
        }

        return;
      }


      const row =
        event.target.closest(
          ".song"
        );


      if (row) {

        const song =
          songs.find(
            item =>
              item.id ===
              row.dataset.songId
          );


        if (song) {

          playSong(
            songs.indexOf(song),
            getCurrentVisibleQueue()
          );
        }
      }

    }
  );
}


function getCurrentVisibleQueue() {

  let queue =
    getSearchResults();


  if (
    libraryView ===
    "favorites"
  ) {

    queue =
      queue.filter(
        isFav
      );
  }


  if (
    libraryView ===
    "recent"
  ) {

    queue =
      recent
        .map(id =>
          songs.find(
            song =>
              song.id === id
          )
        )
        .filter(Boolean);
  }


  if (
    collectionType === "artist" &&
    collectionValue
  ) {

    queue =
      queue.filter(
        song =>
          song.artist ===
          collectionValue
      );
  }


  if (
    collectionType === "album" &&
    collectionValue
  ) {

    queue =
      queue.filter(
        song =>
          song.album ===
          collectionValue
      );
  }


  return queue.length
    ? queue
    : songs;
}




if ($("#sortSelect")) {
  $("#sortSelect").value = sortMode;
  $("#sortSelect").addEventListener("change", event => {
    sortMode = event.target.value || "default";
    localStorage.setItem("luxe_sort_mode", sortMode);
    applySortToCurrentView();
  });
}

/* =========================================================
   COLLECTION CLICK
   ========================================================= */

if ($("#collectionGrid")) {

  $("#collectionGrid").addEventListener(
    "click",
    event => {

      const card =
        event.target.closest(
          "[data-collection]"
        );


      if (!card) {
        return;
      }


      collectionType =
        card.dataset.type;


      collectionValue =
        card.dataset.collection;


      libraryView =
        card.dataset.type ===
        "artist"
          ? "artists"
          : "albums";


      updateTabs();

      render();

    }
  );
}


/* =========================================================
   BREADCRUMB
   ========================================================= */

if ($("#breadcrumb")) {

  $("#breadcrumb").addEventListener(
    "click",
    event => {

      if (
        event.target.closest(
          "[data-back-library]"
        )
      ) {

        collectionType = null;

        collectionValue = null;

        render();
      }

    }
  );
}


/* =========================================================
   SEARCH
   ========================================================= */

if ($("#search")) {

  $("#search").addEventListener(
    "input",
    () => {

      if (
        libraryView === "home"
      ) {

        libraryView =
          "songs";

        updateTabs();
      }

      render();

    }
  );
}


/* =========================================================
   LIBRARY TABS
   ========================================================= */

document
  .querySelectorAll(
    ".library-tab"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      () => {

        collectionType = null;

        collectionValue = null;

        setLibraryView(
          button.dataset.library
        );

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });

      }
    );

  });


/* =========================================================
   BOTTOM NAVIGATION
   ========================================================= */

document
  .querySelectorAll(
    ".nav-item"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      () => {

        document
          .querySelectorAll(
            ".nav-item"
          )
          .forEach(item =>
            item.classList.toggle(
              "active",
              item === button
            )
          );


        collectionType = null;

        collectionValue = null;


        const tab =
          button.dataset.tab;


        if (tab === "home") {

          setLibraryView(
            "home"
          );
        }


        if (tab === "library") {

          setLibraryView(
            "songs"
          );
        }


        if (tab === "favorites") {

          setLibraryView(
            "favorites"
          );
        }


        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });

      }
    );

  });


/* =========================================================
   VIEW MODE
   ========================================================= */

function updateViewButtons() {

  $("#viewList")
    ?.classList.toggle(
      "active",
      viewMode === "list"
    );


  $("#viewGrid")
    ?.classList.toggle(
      "active",
      viewMode === "grid"
    );
}


if ($("#viewList")) {

  $("#viewList").addEventListener(
    "click",
    () => {

      viewMode =
        "list";


      localStorage.setItem(
        "luxe_view_mode",
        "list"
      );


      updateViewButtons();

      render();

    }
  );
}


if ($("#viewGrid")) {

  $("#viewGrid").addEventListener(
    "click",
    () => {

      viewMode =
        "grid";


      localStorage.setItem(
        "luxe_view_mode",
        "grid"
      );


      updateViewButtons();

      render();

    }
  );
}


/* =========================================================
   FAVORITES
   ========================================================= */

function toggleFavorite(id) {

  if (
    favorites.includes(id)
  ) {

    favorites =
      favorites.filter(
        item =>
          item !== id
      );

  } else {

    favorites.unshift(
      id
    );
  }


  saveJSON(
    "luxe_favorites",
    favorites
  );


  updateStats();

  renderHome();

  render();

  if (typeof luxeUpdatePlayerFavorite === "function") {
    luxeUpdatePlayerFavorite();
  }

  if (typeof luxeUpdateMiniControls === "function") {
    luxeUpdateMiniControls();
  }
}


/* =========================================================
   NATIVE ANDROID PLAYBACK ENGINE
   On Android, MediaPlayer/MediaSession service is the real audio engine.
   The HTML <audio> element remains for browser playback only.
   ========================================================= */
function luxeNativePlaying() {
  return isNativeAndroid() ? nativePlaying : (!audio.paused && !audio.ended);
}

function luxeNativeQueuePayload(queue) {
  return queue.filter(Boolean).map(song => ({
    id: song.id || "",
    title: song.title || "Unknown Title",
    artist: song.artist || "Unknown Artist",
    url: song.nativeUrl || ""
  }));
}

function luxeStartNativeQueue(queue, index) {
  if (!isNativeAndroid()) return false;
  if (!window.LuxeAndroid || typeof window.LuxeAndroid.nativePlayQueue !== "function") return false;

  try {
    window.LuxeAndroid.nativePlayQueue(
      JSON.stringify(luxeNativeQueuePayload(queue)),
      Math.max(0, index),
      !!repeat
    );
    return true;
  } catch {
    return false;
  }
}

window.LuxeAndroidNativeState = function(state) {
  if (!state || !isNativeAndroid()) return;

  nativePlaying = !!state.playing;
  nativePosition = Number(state.position || 0) / 1000;
  nativeDuration = Number(state.duration || 0) / 1000;

  const songId = state.id || "";
  const found = songs.findIndex(song => String(song.id) === String(songId));

  if (found >= 0) {
    current = found;
    const queueIndex = currentQueue.indexOf(found);
    if (queueIndex >= 0) queuePosition = queueIndex;
    updatePlayer();
    renderHome();
  }

  // The native service is the source of truth on Android. Refresh the player
  // display even when the song cannot be matched in the current JS queue.
  if (nativeDuration > 0) {
    const progress = document.querySelector("#progress");
    if (progress && !nativeSeeking) {
      progress.value = Math.max(0, Math.min(100, (nativePosition / nativeDuration) * 100));
      updateRangeProgress(progress);
    }
  }

  updatePlayButtons();
  luxeUpdatePlayerFavorite();
  luxeUpdateMiniControls();

  if (document.querySelector("#duration") && nativeDuration > 0) {
    document.querySelector("#duration").textContent = formatTime(nativeDuration);
  }
  if (document.querySelector("#currentTime")) {
    document.querySelector("#currentTime").textContent = formatTime(nativePosition);
  }
  if (document.querySelector("#progress") && nativeDuration > 0 && !nativeSeeking) {
    document.querySelector("#progress").value = (nativePosition / nativeDuration) * 100;
    updateRangeProgress(document.querySelector("#progress"));
  }
};

function luxeNativeTogglePlay() {
  if (!isNativeAndroid() || !window.LuxeAndroid) return;
  try {
    if (nativePlaying) window.LuxeAndroid.nativePause();
    else window.LuxeAndroid.nativePlay();
  } catch {}
}

/* =========================================================
   ANDROID BACKGROUND PLAYBACK KEEP-ALIVE
   Keeps the native WebView process alive while audio is playing.
   This is intentionally a native foreground-service bridge: a
   WebView alone is not a reliable background-audio host on Android.
   ========================================================= */
function luxeNativePlaybackKeepAlive(start) {
  if (!isNativeAndroid()) return;
  try {
    if (start && typeof window.LuxeAndroid.startPlaybackKeepAlive === "function") {
      window.LuxeAndroid.startPlaybackKeepAlive();
    }
  } catch {}
}

/* ---------------------------------------------------------
   ANDROID NOTIFICATION + LOCK-SCREEN METADATA
   The native MediaSession mirrors the HTML audio state so Android
   can show the current song and transport controls outside LUXE.
--------------------------------------------------------- */
function luxeSyncNativePlaybackNotification() {
  if (!isNativeAndroid()) return;
  // Native PlaybackKeepAliveService is the actual media session/notification.
  // The method remains for compatibility with existing UI update calls.
  return;

  const song = songs[current];
  if (!song) return;

  try {
    window.LuxeAndroid.updatePlaybackNotification(
      song.title || "Unknown Title",
      song.artist || "Unknown Artist",
      !!audio && !audio.paused && !audio.ended,
      Number.isFinite(audio?.duration) ? audio.duration : 0,
      Number.isFinite(audio?.currentTime) ? audio.currentTime : 0
    );
  } catch {}
}

function luxeTryPlayBackground() {
  if (isNativeAndroid()) return;
  if (!audio || current < 0) return;

  let attempts = 0;
  const maxAttempts = 6;

  const attempt = () => {
    if (!audio || current < 0 || !audio.paused || attempts >= maxAttempts) return;
    attempts++;

    try {
      const promise = audio.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch(() => {
          if (isNativeAndroid() && typeof window.LuxeAndroid.resumeWebPlayback === "function") {
            try { window.LuxeAndroid.resumeWebPlayback(); } catch {}
          }
          if (attempts < maxAttempts) setTimeout(attempt, 180);
        });
      }
    } catch {
      if (attempts < maxAttempts) setTimeout(attempt, 180);
    }
  };

  attempt();
}
/* =========================================================
   PLAYBACK
   ========================================================= */

function playSong(
  songIndex,
  queue = songs
) {

  if (!songs.length) {
    return;
  }


  const song =
    songs[songIndex];


  if (!song) {
    return;
  }


  current =
    songIndex;


  const validQueue =
    queue
      .filter(Boolean)
      .map(
        songItem =>
          songs.indexOf(
            songItem
          )
      )
      .filter(
        index => index >= 0
      );


  currentQueue =
    validQueue.length
      ? validQueue
      : [songIndex];


  queuePosition =
    currentQueue.indexOf(
      songIndex
    );


  if (queuePosition < 0) {

    currentQueue.unshift(
      songIndex
    );

    queuePosition =
      0;
  }


  if (isNativeAndroid() && song.nativeUrl) {
    // Android uses the real native playback service. Do not start a second
    // WebView audio pipeline, otherwise background autoplay becomes fragile.
    try { audio.pause(); } catch {}
    try {
      const queueSongs = currentQueue.map(index => songs[index]).filter(Boolean);
      const nativeIndex = Math.max(0, currentQueue.indexOf(songIndex));
      if (luxeStartNativeQueue(queueSongs, nativeIndex)) {
        nativePlaying = true;
        nativePosition = 0;
        nativeDuration = 0;
      }
    } catch {}

    recent = [
      song.id,
      ...recent.filter(id => id !== song.id)
    ].slice(0, 50);
    saveJSON("luxe_recent", recent);
    updatePlayer();
    $("#miniPlayer")?.classList.remove("hidden");
    renderHome();
    return;
  }


  /*
    Clean up previous browser
    object URL if one exists.
  */

  const oldObjectURL =
    audio.dataset.objectUrl;


  if (oldObjectURL) {

    try {

      URL.revokeObjectURL(
        oldObjectURL
      );

    } catch {}

    delete audio.dataset.objectUrl;
  }


  let audioSource = null;


  /*
    =======================================================
    NATIVE ANDROID AUDIO
    =======================================================
  */

  if (
    song.nativeUrl
  ) {

    audioSource =
      song.nativeUrl;
  }


  /*
    =======================================================
    BROWSER AUDIO
    =======================================================
  */

  else if (
    song.file
  ) {

    try {

      audioSource =
        URL.createObjectURL(
          song.file
        );

      audio.dataset.objectUrl =
        audioSource;

    } catch {

      return;
    }
  }


  if (!audioSource) {
    return;
  }


  audio.src =
    audioSource;


  audio.load();


  luxeNativePlaybackKeepAlive(true);
  luxeTryPlayBackground();


  /*
    Recently played
  */

  recent = [
    song.id,
    ...recent.filter(
      id =>
        id !== song.id
    )
  ].slice(0, 50);


  saveJSON(
    "luxe_recent",
    recent
  );


  updatePlayer();
  luxeSyncNativePlaybackNotification();


  $("#miniPlayer")
    ?.classList.remove(
      "hidden"
    );


  renderHome();
}


/* =========================================================
   PLAYER UI
   ========================================================= */

function luxeUpdateMiniControls() {

  const song = songs[current];

  const favoriteButton = $("#miniFavorite");
  const repeatButton = $("#miniRepeat");

  if (favoriteButton) {
    const favorite = !!song && isFav(song);

    favoriteButton.textContent = favorite ? "♥" : "♡";
    favoriteButton.classList.toggle("active", favorite);
    favoriteButton.setAttribute("aria-pressed", String(favorite));
  }

  if (repeatButton) {
    repeatButton.classList.toggle("active", repeat);
    repeatButton.setAttribute("aria-pressed", String(repeat));
  }
}

function updatePlayer() {

  if (current < 0) {
    return;
  }


  const song =
    songs[current];


  if (!song) {
    return;
  }


  if ($("#miniTitle")) {

    $("#miniTitle").textContent =
      song.title;
  }


  if ($("#miniArtist")) {

    $("#miniArtist").textContent =
      song.artist;
  }


  if ($("#bigTitle")) {

    $("#bigTitle").textContent =
      song.title;
  }


  if ($("#bigArtist")) {

    $("#bigArtist").textContent =
      song.artist;
  }


  updatePlayerArtwork();

  updatePlayButtons();
  luxeUpdateMiniControls();
}


function updatePlayerArtwork() {

  if (current < 0) {
    return;
  }


  const song =
    songs[current];


  if (!song) {
    return;
  }


  const mini =
    $("#miniArt");


  const big =
    $("#bigArt");


  if (!mini || !big) {
    return;
  }


  if (song.artwork) {

    mini.innerHTML =
      `<img src="${esc(song.artwork)}" alt="">`;

    big.innerHTML =
      `<img src="${esc(song.artwork)}" alt="">`;

  } else {

    const letter =
      (
        song.title ||
        "♪"
      )
        .charAt(0)
        .toUpperCase();


    mini.textContent =
      letter;


    big.textContent =
      letter;
  }
}


function updatePlayButtons() {

  const playing = luxeNativePlaying();


  if ($("#miniPlay")) {

    $("#miniPlay").textContent =
      playing
        ? "❚❚"
        : "▶";
  }


  if ($("#bigPlay")) {

    $("#bigPlay").textContent =
      playing
        ? "❚❚"
        : "▶";
  }
}


/* =========================================================
   MINI PLAYER
   ========================================================= */

if ($("#miniPlayer")) {

  $("#miniPlayer").addEventListener(
    "click",
    event => {

      if (
        event.target.closest(
          "#miniPlay"
        )
      ) {
        return;
      }


      if (
        event.target.closest("button"
        )
      ) {
        return;
      }


      $("#playerModal")
        ?.classList.remove(
          "hidden"
        );

    }
  );
}


function luxeMiniPlayPause(event) {

  event.preventDefault();
  event.stopPropagation();

  if (current < 0) return;

  if (isNativeAndroid()) {
    luxeNativeTogglePlay();
  } else if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

if ($("#miniPlay")) {

  $("#miniPlay").addEventListener(
    "click",
    luxeMiniPlayPause
  );
}

if ($("#miniPrev")) {
  $("#miniPrev").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    playPrevious();
  });
}

if ($("#miniNext")) {
  $("#miniNext").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    playNext();
  });
}

if ($("#miniFavorite")) {
  $("#miniFavorite").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();

    const song = songs[current];
    if (!song) return;

    toggleFavorite(song.id);
    luxeUpdatePlayerFavorite();
    luxeUpdateMiniControls();
    luxeHaptic(10);
  });
}

if ($("#miniShuffle")) {
  $("#miniShuffle").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();

    if (!songs.length) return;

    const queue = shuffleArray([...songs]);
    playSong(songs.indexOf(queue[0]), queue);

    $("#miniShuffle").classList.add("active", "pulse");
    setTimeout(() => $("#miniShuffle")?.classList.remove("pulse"), 260);
  });
}

if ($("#miniRepeat")) {
  $("#miniRepeat").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();

    repeat = !repeat;

    if (isNativeAndroid()) {
      try { window.LuxeAndroid?.nativeSetRepeat(repeat); } catch {}
    }

    $("#miniRepeat").classList.toggle("active", repeat);
    $("#repeatBtn")?.classList.toggle("active", repeat);
    $("#miniRepeat").classList.add("pulse");
    setTimeout(() => $("#miniRepeat")?.classList.remove("pulse"), 260);
    luxeHaptic(8);
  });
}


/* =========================================================
   MINI PLAYER SWIPE
   ========================================================= */

let touchStartY = 0;
let touchMoved = false;

const mini =
  $("#miniPlayer");


if (mini) {

  mini.addEventListener(
    "touchstart",
    event => {

      if (event.target.closest("button")) {
        touchMoved = true;
        return;
      }

      touchStartY =
        event.touches[0].clientY;

      touchMoved =
        false;


      mini.classList.add(
        "swiping"
      );

    },
    {
      passive: true
    }
  );


  mini.addEventListener(
    "touchmove",
    event => {

      if (event.target.closest("button")) return;

      const distance =
        event.touches[0].clientY -
        touchStartY;


      if (distance > 8) {

        touchMoved =
          true;


        mini.style.transform =
          `translateX(-50%) translateY(${Math.min(
            distance,
            100
          )}px)`;
      }

    },
    {
      passive: true
    }
  );


  mini.addEventListener(
    "touchend",
    event => {

      if (event.target.closest("button")) return;

      const distance =
        event.changedTouches[0].clientY -
        touchStartY;


      mini.classList.remove(
        "swiping"
      );


      mini.style.transform =
        "";


      if (distance > 55) {

        mini.classList.add(
          "minimized"
        );

        return;
      }


      if (!touchMoved) {

        $("#playerModal")
          ?.classList.remove(
            "hidden"
          );
      }

    }
  );


  mini.addEventListener(
    "click",
    event => {

      if (
        mini.classList.contains(
          "minimized"
        ) &&
        !event.target.closest(
          "#miniPlay"
        )
      ) {

        mini.classList.remove(
          "minimized"
        );


        event.stopPropagation();
      }

    }
  );
}


/* =========================================================
   FULL PLAYER
   ========================================================= */

if ($("#closePlayer")) {

  $("#closePlayer").addEventListener(
    "click",
    () => {

      $("#playerModal")
        ?.classList.add(
          "hidden"
        );

    }
  );
}


if ($("#bigPlay")) {

  $("#bigPlay").addEventListener(
    "click",
    () => {

      if (current < 0) {
        return;
      }


      if (isNativeAndroid()) {
        luxeNativeTogglePlay();
      } else if (audio.paused) {

        audio.play()
          .catch(
            () => {}
          );

      } else {

        audio.pause();
      }

    }
  );
}


if ($("#nextBtn")) {

  $("#nextBtn").addEventListener(
    "click",
    playNext
  );
}


if ($("#prevBtn")) {

  $("#prevBtn").addEventListener(
    "click",
    playPrevious
  );
}


if ($("#shuffleBtn")) {

  $("#shuffleBtn").addEventListener(
    "click",
    () => {

      if (!songs.length) {
        return;
      }


      const queue =
        shuffleArray(
          [...songs]
        );


      playSong(
        songs.indexOf(
          queue[0]
        ),
        queue
      );

    }
  );
}


if ($("#repeatBtn")) {

  $("#repeatBtn").addEventListener(
    "click",
    () => {

      repeat =
        !repeat;

      if (isNativeAndroid()) {
        try { window.LuxeAndroid?.nativeSetRepeat(repeat); } catch {}
      }


      $("#repeatBtn")
        .classList.toggle(
          "active",
          repeat
        );

      luxeUpdateMiniControls();

    }
  );
}


/* =========================================================
   NEXT / PREVIOUS
   ========================================================= */

function playNext() {

  if (isNativeAndroid()) {
    try { window.LuxeAndroid?.nativeNext(); } catch {}
    return;
  }

  if (!songs.length) {
    return;
  }


  if (
    currentQueue.length &&
    queuePosition <
      currentQueue.length - 1
  ) {

    queuePosition++;


    current =
      currentQueue[
        queuePosition
      ];


    playSong(
      current,
      currentQueue.map(
        index =>
          songs[index]
      )
    );


    return;
  }


  /*
    Queue finished.
    Do not automatically loop unless
    repeat is enabled.
  */

  return;
}


function playPrevious() {

  if (isNativeAndroid()) {
    try { window.LuxeAndroid?.nativePrevious(); } catch {}
    return;
  }

  if (
    audio.currentTime > 3
  ) {

    audio.currentTime =
      0;

    return;
  }


  if (
    queuePosition > 0
  ) {

    queuePosition--;


    current =
      currentQueue[
        queuePosition
      ];


    playSong(
      current,
      currentQueue.map(
        index =>
          songs[index]
      )
    );


    return;
  }


  if (songs.length) {

    const previous =
      (
        current -
        1 +
        songs.length
      ) % songs.length;


    playSong(
      previous,
      songs
    );
  }
}


/* =========================================================
   AUDIO EVENTS
   ========================================================= */

if (audio) {

  audio.addEventListener(
    "play",
    () => {

      updatePlayButtons();


      $("#miniPlayer")
        ?.classList.remove(
          "hidden"
        );

    }
  );


  audio.addEventListener(
    "pause",
    updatePlayButtons
  );


  audio.addEventListener(
    "loadedmetadata",
    () => {

      if ($("#duration")) {

        $("#duration").textContent =
          formatTime(
            audio.duration
          );
      }

    }
  );


  audio.addEventListener(
    "timeupdate",
    () => {

      if (
        audio.duration &&
        $("#progress")
      ) {

        $("#progress").value =
          (
            audio.currentTime /
            audio.duration
          ) * 100;
      }


      if ($("#currentTime")) {

        $("#currentTime").textContent =
          formatTime(
            audio.currentTime
          );
      }


      updateRangeProgress(
        $("#progress")
      );

    }
  );


  audio.addEventListener(
    "ended",
    () => {

      if (isNativeAndroid()) return;

      if (repeat) {

        audio.currentTime = 0;
        luxeNativePlaybackKeepAlive(true);
        luxeTryPlayBackground();

        return;
      }


      if (
        queuePosition <
        currentQueue.length - 1
      ) {

        playNext();
      }

    }
  );


  audio.addEventListener(
    "error",
    () => {

      console.error(
        "LUXE audio playback error:",
        audio.error
      );

    }
  );
}


/* =========================================================
   RANGE SLIDERS
   ========================================================= */

function updateRangeProgress(
  element
) {

  if (!element) {
    return;
  }


  const min =
    Number(
      element.min || 0
    );


  const max =
    Number(
      element.max || 100
    );


  const value =
    Number(
      element.value || 0
    );


  const percentage =
    max === min
      ? 0
      : (
          (value - min) /
          (max - min)
        ) * 100;


  element.style.setProperty(
    "--range-progress",
    `${percentage}%`
  );
}


if ($("#progress")) {

  // Android: MediaPlayer owns the real position. Keep the WebView slider
  // responsive while dragging, then commit the selected position to the
  // native service on release.
  const commitNativeSeek = element => {
    if (!isNativeAndroid() || nativeDuration <= 0) return;
    const percent = Math.max(0, Math.min(100, Number(element.value) || 0));
    const seconds = nativeDuration * (percent / 100);
    nativePosition = seconds;
    try { window.LuxeAndroid?.nativeSeek(seconds); } catch {}
    if ($("#currentTime")) {
      $("#currentTime").textContent = formatTime(seconds);
    }
    nativeSeeking = false;
  };

  $("#progress").addEventListener("pointerdown", event => {
    nativeSeeking = isNativeAndroid();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  });

  $("#progress").addEventListener("input", event => {
    updateRangeProgress(event.target);

    if (isNativeAndroid()) {
      if (nativeDuration > 0 && $("#currentTime")) {
        const seconds = nativeDuration * (Number(event.target.value) / 100);
        $("#currentTime").textContent = formatTime(seconds);
      }
    } else if (audio.duration) {
      audio.currentTime = audio.duration * (Number(event.target.value) / 100);
    }
  });

  $("#progress").addEventListener("pointerup", event => {
    if (isNativeAndroid()) commitNativeSeek(event.currentTarget);
  });

  $("#progress").addEventListener("change", event => {
    if (isNativeAndroid()) commitNativeSeek(event.target);
    updateRangeProgress(event.target);
  });

  $("#progress").addEventListener("lostpointercapture", event => {
    if (isNativeAndroid() && nativeSeeking) commitNativeSeek(event.currentTarget);
  });

  $("#progress").addEventListener("pointercancel", event => {
    if (isNativeAndroid()) nativeSeeking = false;
  });
}


if ($("#volume")) {

  $("#volume").addEventListener(
    "input",
    event => {

      audio.volume =
        Number(
          event.target.value
        );


      updateRangeProgress(
        event.target
      );


      localStorage.setItem(
        "luxe_volume",
        String(
          audio.volume
        )
      );

    }
  );
}


/* =========================================================
   RESCAN
   ========================================================= */

if ($("#rescanBtn")) {

  $("#rescanBtn").addEventListener(
    "click",
    event => {

      event.preventDefault();

      event.stopPropagation();


      if (isNativeAndroid()) {

        setFolderStatus(
          "Rescanning music folder..."
        );


        try {

          window.LuxeAndroid
            .rescanMusicFolder();

        } catch {

          setFolderStatus(
            "Unable to rescan music folder."
          );
        }


        return;
      }


      openMusicFolder();

    }
  );
}


/* =========================================================
   PLAYLIST SYSTEM
   ========================================================= */

function savePlaylists() {

  saveJSON(
    "luxe_playlists",
    playlists
  );


  updateStats();
}


function getPlaylist(id) {

  return playlists.find(
    playlist =>
      playlist.id === id
  );
}


/* =========================================================
   CREATE PLAYLIST
   ========================================================= */

function createPlaylist(name) {

  if (creatingPlaylist) {
    return;
  }


  const cleanName =
    String(name || "")
      .trim();


  if (!cleanName) {
    return;
  }


  creatingPlaylist =
    true;


  try {

    const existing =
      playlists.find(
        playlist =>
          playlist.name
            .trim()
            .toLowerCase() ===
          cleanName.toLowerCase()
      );


    if (existing) {

      closeOverlay(
        $("#playlistCreatePanel")
      );


      currentPlaylistId =
        existing.id;


      libraryView =
        "playlists";


      collectionType = null;

      collectionValue = null;


      updateTabs();

      renderPlaylists();


      return;
    }


    const playlist = {

      id:
        "playlist_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2),


      name:
        cleanName,


      songs: [],


      createdAt:
        Date.now()

    };


    playlists.push(
      playlist
    );


    savePlaylists();


    if ($("#playlistNameInput")) {

      $("#playlistNameInput")
        .value = "";
    }


    closeOverlay(
      $("#playlistCreatePanel")
    );


    libraryView =
      "playlists";


    collectionType = null;

    collectionValue = null;


    updateTabs();

    renderPlaylists();

    updateStats();


  } finally {

    setTimeout(
      () => {

        creatingPlaylist =
          false;

      },
      350
    );
  }
}


/* =========================================================
   OPEN CREATE PLAYLIST
   ========================================================= */

function openCreatePlaylist() {

  if (creatingPlaylist) {
    return;
  }


  if ($("#playlistNameInput")) {

    $("#playlistNameInput")
      .value = "";
  }


  $("#playlistCreatePanel")
    ?.classList.remove(
      "hidden"
    );


  setTimeout(
    () =>
      $("#playlistNameInput")
        ?.focus(),
    50
  );
}


if ($("#playlistCreatePanel")) {

  $("#playlistCreatePanel")
    .addEventListener(
      "click",
      event => {

        if (
          event.target ===
          $("#playlistCreatePanel")
        ) {

          closeOverlay(
            $("#playlistCreatePanel")
          );
        }

      }
    );
}


if ($("#closePlaylistCreate")) {

  $("#closePlaylistCreate")
    .addEventListener(
      "click",
      () =>
        closeOverlay(
          $("#playlistCreatePanel")
        )
    );
}


if ($("#createPlaylistConfirm")) {

  $("#createPlaylistConfirm")
    .addEventListener(
      "click",
      event => {

        event.preventDefault();

        event.stopPropagation();


        createPlaylist(
          $("#playlistNameInput")
            ?.value || ""
        );

      }
    );
}


if ($("#playlistNameInput")) {

  $("#playlistNameInput")
    .addEventListener(
      "keydown",
      event => {

        if (
          event.key ===
          "Enter"
        ) {

          event.preventDefault();


          createPlaylist(
            event.target.value
          );
        }

      }
    );
}


/* =========================================================
   RENDER PLAYLISTS
   ========================================================= */

function renderPlaylists() {

  $("#homeContent")
    ?.classList.add(
      "hidden"
    );


  $("#songList")
    ?.classList.add(
      "hidden"
    );


  $("#collectionGrid")
    ?.classList.add(
      "hidden"
    );


  $("#playlistGrid")
    ?.classList.remove(
      "hidden"
    );


  if ($("#sectionHeading")) {

    $("#sectionHeading")
      .textContent =
      "Playlists";
  }


  if ($("#resultCount")) {

    $("#resultCount")
      .textContent =
      `${playlists.length}`;
  }


  const grid =
    $("#playlistGrid");if (!grid) {
    return;
  }


  grid.innerHTML = `

    <button
      class="playlist-card create-playlist-card"
      id="createPlaylistCard"
      type="button"
    >

      <div class="playlist-art">
        ＋
      </div>

      <strong>
        Create Playlist
      </strong>

      <small>
        Build your own collection
      </small>

    </button>


    ${playlists
      .map(
        playlist => `

          <button
            class="playlist-card"
            data-playlist-id="${esc(
              playlist.id
            )}"
            type="button"
          >

            <div class="playlist-art">
              ♫
            </div>

            <strong>
              ${esc(
                playlist.name
              )}
            </strong>

            <small>
              ${playlist.songs.length}
              songs
            </small>

          </button>

        `
      )
      .join("")}

  `;
}


if ($("#playlistGrid")) {

  $("#playlistGrid").addEventListener(
    "click",
    event => {

      if (
        event.target.closest(
          "#createPlaylistCard"
        )
      ) {

        openCreatePlaylist();

        return;
      }


      const card =
        event.target.closest(
          "[data-playlist-id]"
        );


      if (!card) {
        return;
      }


      openPlaylist(
        card.dataset.playlistId
      );

    }
  );
}


/* =========================================================
   OPEN PLAYLIST
   ========================================================= */

function openPlaylist(id) {

  const playlist =
    getPlaylist(id);


  if (!playlist) {
    return;
  }


  currentPlaylistId =
    playlist.id;


  if ($("#playlistPanelTitle")) {

    $("#playlistPanelTitle")
      .textContent =
      playlist.name;
  }


  renderPlaylistSongs(
    playlist
  );


  closeOverlay(
    $("#addSongsPanel")
  );


  $("#playlistPanel")
    ?.classList.remove(
      "hidden"
    );
}


/* =========================================================
   PLAYLIST SONGS
   ========================================================= */

function renderPlaylistSongs(
  playlist
) {

  const container =
    $("#playlistSongs");


  if (!container) {
    return;
  }


  const validSongs =
    (playlist.songs || [])
      .map(
        id =>
          songs.find(
            song =>
              song.id === id
          )
      )
      .filter(Boolean);


  if (!validSongs.length) {

    container.innerHTML = `

      <div class="empty playlist-empty">

        <div class="playlist-empty-icon">
          ♫
        </div>

        <strong>
          This playlist is empty
        </strong>

        <span>
          Add songs to build your collection.
        </span>

      </div>

    `;

    return;
  }


  container.innerHTML =
    validSongs
      .map(
        song => `

          <div
            class="playlist-song"
            data-playlist-song="${esc(
              song.id
            )}"
          >

            ${artHTML(
              song,
              "small"
            )}


            <div class="playlist-song-info">

              <strong>
                ${esc(
                  song.title
                )}
              </strong>

              <span>
                ${esc(
                  song.artist
                )}
              </span>

            </div>


            <button
              class="playlist-remove"
              data-remove-playlist-song="${esc(
                song.id
              )}"
              title="Remove from playlist"
              type="button"
            >
              ×
            </button>

          </div>

        `
      )
      .join("");
}


/* =========================================================
   CLOSE PLAYLIST
   ========================================================= */

if ($("#closePlaylistPanel")) {

  $("#closePlaylistPanel")
    .addEventListener(
      "click",
      () => {

        closeOverlay(
          $("#playlistPanel")
        );


        closeOverlay(
          $("#addSongsPanel")
        );


        currentPlaylistId =
          null;

      }
    );
}


/* =========================================================
   PLAY PLAYLIST
   ========================================================= */

if ($("#playlistPlayBtn")) {

  $("#playlistPlayBtn")
    .addEventListener(
      "click",
      () => {

        const playlist =
          getPlaylist(
            currentPlaylistId
          );


        if (!playlist) {
          return;
        }


        const queue =
          playlist.songs
            .map(
              id =>
                songs.find(
                  song =>
                    song.id === id
                )
            )
            .filter(Boolean);


        if (!queue.length) {
          return;
        }


        playSong(
          songs.indexOf(
            queue[0]
          ),
          queue
        );


        closeOverlay(
          $("#playlistPanel")
        );

      }
    );
}


/* =========================================================
   DELETE PLAYLIST
   ========================================================= */

function deletePlaylist(
  playlistId
) {

  const playlist =
    getPlaylist(
      playlistId
    );


  if (!playlist) {
    return;
  }


  playlists =
    playlists.filter(
      item =>
        item.id !==
        playlistId
    );


  savePlaylists();


  closeOverlay(
    $("#addSongsPanel")
  );


  closeOverlay(
    $("#playlistPanel")
  );


  currentPlaylistId =
    null;


  libraryView =
    "playlists";


  collectionType = null;

  collectionValue = null;


  updateTabs();

  renderPlaylists();

  updateStats();
}


if ($("#playlistDeleteBtn")) {

  $("#playlistDeleteBtn")
    .addEventListener(
      "click",
      event => {

        event.preventDefault();

        event.stopPropagation();


        deletePlaylist(
          currentPlaylistId
        );

      }
    );
}


if ($("#playlistPanel")) {

  $("#playlistPanel").addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          "[data-delete-playlist]"
        );


      if (!button) {
        return;
      }


      event.preventDefault();

      event.stopPropagation();


      deletePlaylist(
        currentPlaylistId
      );

    }
  );
}


/* =========================================================
   ADD SONGS
   ========================================================= */

if ($("#playlistAddBtn")) {

  $("#playlistAddBtn")
    .addEventListener(
      "click",
      event => {

        event.preventDefault();

        event.stopPropagation();


        const playlist =
          getPlaylist(
            currentPlaylistId
          );


        if (!playlist) {
          return;
        }


        openAddSongs(
          playlist
        );

      }
    );
}


function openAddSongs(
  playlist
) {

  if (addSongsBusy) {
    return;
  }


  currentPlaylistId =
    playlist.id;


  selectedPlaylistSongs =
    new Set(
      Array.isArray(
        playlist.songs
      )
        ? playlist.songs
        : []
    );


  if ($("#addSongsTitle")) {

    $("#addSongsTitle")
      .textContent =
      `Add Songs to ${playlist.name}`;
  }


  if ($("#addSongSearch")) {

    $("#addSongSearch")
      .value = "";
  }


  closeOverlay(
    $("#playlistPanel")
  );


  renderAddSongList();


  $("#addSongsPanel")
    ?.classList.remove(
      "hidden"
    );
}


/* =========================================================
   ADD SONG LIST
   ========================================================= */

function renderAddSongList() {

  const container =
    $("#addSongList");


  if (!container) {
    return;
  }


  const query =
    (
      $("#addSongSearch")
        ?.value || ""
    )
      .toLowerCase()
      .trim();


  const list =
    songs.filter(song =>

      (
        song.title +
        " " +
        song.artist +
        " " +
        song.album
      )
        .toLowerCase()
        .includes(query)

    );


  if (!list.length) {

    container.innerHTML = `

      <div class="empty">
        No songs found.
      </div>

    `;

    return;
  }


  container.innerHTML =
    list
      .map(song => {

        const selected =
          selectedPlaylistSongs.has(
            song.id
          );


        return `

          <div
            class="
              add-song-item
              ${selected ? "selected" : ""}
            "
            data-add-song="${esc(
              song.id
            )}"
          >

            ${artHTML(
              song,
              "small"
            )}


            <div class="add-song-info">

              <strong>
                ${esc(
                  song.title
                )}
              </strong>

              <span>
                ${esc(
                  song.artist
                )}
                •
                ${esc(
                  song.album
                )}
              </span>

            </div>


            <div class="add-song-check">
              ${selected ? "✓" : ""}
            </div>

          </div>

        `;

      })
      .join("");
}


if ($("#addSongSearch")) {

  $("#addSongSearch")
    .addEventListener(
      "input",
      renderAddSongList
    );
}


if ($("#addSongList")) {

  $("#addSongList").addEventListener(
    "click",
    event => {

      const row =
        event.target.closest(
          "[data-add-song]"
        );


      if (!row) {
        return;
      }


      const id =
        row.dataset.addSong;


      if (
        selectedPlaylistSongs.has(
          id
        )
      ) {

        selectedPlaylistSongs.delete(
          id
        );

      } else {

        selectedPlaylistSongs.add(
          id
        );
      }


      renderAddSongList();

    }
  );
}


/* =========================================================
   FINISH ADDING SONGS
   ========================================================= */

function finishAddingSongs() {

  if (addSongsBusy) {
    return;
  }


  const playlist =
    getPlaylist(
      currentPlaylistId
    );


  if (!playlist) {
    return;
  }


  addSongsBusy =
    true;


  try {

    playlist.songs =
      [...selectedPlaylistSongs]
        .filter(
          id =>
            songs.some(
              song =>
                song.id === id
            )
        );


    savePlaylists();


    closeOverlay(
      $("#addSongsPanel")
    );


    renderPlaylistSongs(
      playlist
    );


    if ($("#playlistPanelTitle")) {

      $("#playlistPanelTitle")
        .textContent =
        playlist.name;
    }


    $("#playlistPanel")
      ?.classList.remove(
        "hidden"
      );


    renderPlaylists();

    updateStats();


    selectedPlaylistSongs =
      new Set();


  } finally {

    setTimeout(
      () => {

        addSongsBusy =
          false;

      },
      250
    );
  }
}


if ($("#doneAddSongs")) {

  $("#doneAddSongs")
    .addEventListener(
      "click",
      event => {

        event.preventDefault();

        event.stopPropagation();


        finishAddingSongs();

      }
    );
}


/* =========================================================
   CLOSE ADD SONGS
   ========================================================= */

if ($("#closeAddSongs")) {

  $("#closeAddSongs")
    .addEventListener(
      "click",
      event => {

        event.preventDefault();

        event.stopPropagation();


        closeOverlay(
          $("#addSongsPanel")
        );


        const playlist =
          getPlaylist(
            currentPlaylistId
          );


        if (playlist) {

          renderPlaylistSongs(
            playlist
          );


          $("#playlistPanel")
            ?.classList.remove(
              "hidden"
            );
        }

      }
    );
}


/* =========================================================
   PLAYLIST SONG CLICK
   ========================================================= */

if ($("#playlistSongs")) {

  $("#playlistSongs")
    .addEventListener(
      "click",
      event => {

        const remove =
          event.target.closest(
            "[data-remove-playlist-song]"
          );


        if (remove) {

          event.stopPropagation();


          removeSongFromPlaylist(
            currentPlaylistId,
            remove.dataset
              .removePlaylistSong
          );


          return;
        }


        const row =
          event.target.closest(
            "[data-playlist-song]"
          );


        if (!row) {
          return;
        }


        const playlist =
          getPlaylist(
            currentPlaylistId
          );


        if (!playlist) {
          return;
        }


        const queue =
          playlist.songs
            .map(
              id =>
                songs.find(
                  song =>
                    song.id === id
                )
            )
            .filter(Boolean);


        const song =
          songs.find(
            item =>
              item.id ===
              row.dataset.playlistSong
          );


        if (song) {

          playSong(
            songs.indexOf(song),
            queue
          );
        }

      }
    );
}


/* =========================================================
   REMOVE PLAYLIST SONG
   ========================================================= */

function removeSongFromPlaylist(
  playlistId,
  songId
) {

  const playlist =
    getPlaylist(
      playlistId
    );


  if (!playlist) {
    return;
  }


  playlist.songs =
    playlist.songs.filter(
      id =>
        id !== songId
    );


  savePlaylists();


  renderPlaylistSongs(
    playlist
  );


  renderPlaylists();

  updateStats();
}/* =========================================================
   PLAYLIST OVERLAYS
   ========================================================= */

if ($("#playlistPanel")) {

  $("#playlistPanel")
    .addEventListener(
      "click",
      event => {

        if (
          event.target ===
          $("#playlistPanel")
        ) {

          closeOverlay(
            $("#playlistPanel")
          );


          currentPlaylistId =
            null;
        }

      }
    );
}


if ($("#addSongsPanel")) {

  $("#addSongsPanel")
    .addEventListener(
      "click",
      event => {

        if (
          event.target ===
          $("#addSongsPanel")
        ) {

          closeOverlay(
            $("#addSongsPanel")
          );


          const playlist =
            getPlaylist(
              currentPlaylistId
            );


          if (playlist) {

            renderPlaylistSongs(
              playlist
            );


            $("#playlistPanel")
              ?.classList.remove(
                "hidden"
              );
          }

        }

      }
    );
}


/* =========================================================
   THEME
   ========================================================= */

const themeSettings = {

  deluxe: {
    accent: "#d7b56d",
    accent2: "#f2d79c"
  },

  truck: {
    accent: "#c98b4b",
    accent2: "#e7b47c"
  },

  sport: {
    accent: "#d65c5c",
    accent2: "#ff8a8a"
  }

};


function applyTheme(
  theme,
  save = true
) {

  const settings =
    themeSettings[theme] ||
    themeSettings.deluxe;


  document.documentElement
    .style
    .setProperty(
      "--accent",
      settings.accent
    );


  document.documentElement
    .style
    .setProperty(
      "--accent2",
      settings.accent2
    );


  document.body.dataset.theme =
    theme;


  if (save) {

    localStorage.setItem(
      "luxe_theme",
      theme
    );
  }


  updateRangeProgress(
    $("#progress")
  );


  updateRangeProgress(
    $("#volume")
  );
}


if ($("#themeBtn")) {

  $("#themeBtn").addEventListener(
    "click",
    () => {

      $("#themePanel")
        ?.classList.remove(
          "hidden"
        );

    }
  );
}


if ($("#closeTheme")) {

  $("#closeTheme").addEventListener(
    "click",
    () => {

      closeOverlay(
        $("#themePanel")
      );

    }
  );
}


if ($("#themePanel")) {

  $("#themePanel").addEventListener(
    "click",
    event => {

      if (
        event.target ===
        $("#themePanel")
      ) {

        closeOverlay(
          $("#themePanel")
        );
      }

    }
  );
}


document
  .querySelectorAll(
    "[data-theme-choice]"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      () => {

        applyTheme(
          button.dataset
            .themeChoice
        );

      }
    );

  });


/* =========================================================
   FONT
   ========================================================= */

if ($("#fontSelect")) {

  $("#fontSelect").addEventListener(
    "change",
    event => {

      const font =
        event.target.value;


      document.body.style.fontFamily =
        `"${font}", sans-serif`;


      localStorage.setItem(
        "luxe_font",
        font
      );

    }
  );
}


/* =========================================================
   WALLPAPERS
   ========================================================= */

const wallpaperStyles = {

  wall1:
    "radial-gradient(circle at 50% -10%,#29241b 0,#0d0d10 35%,#09090b 70%)",

  wall2:
    "radial-gradient(circle at 50% 0%,#76552c 0,#1b1510 30%,#09090b 72%)",

  wall3:
    "radial-gradient(circle at 20% 10%,#293c59 0,#0c1119 30%,#07090d 75%)",

  wall4:
    "radial-gradient(circle at 70% 10%,#375443 0,#101713 30%,#080c0b 75%)"

};


function applyWallpaper(
  name,
  save = true
) {

  const value =
    wallpaperStyles[name];


  if (!value) {
    return;
  }


  document.body.style.background =
    value;


  document.body.style.backgroundSize =
    "cover";


  document.body.style.backgroundAttachment =
    "fixed";


  if (save) {

    localStorage.setItem(
      "luxe_wallpaper",
      name
    );


    localStorage.removeItem(
      "luxe_custom_wallpaper"
    );
  }
}


document
  .querySelectorAll(
    "[data-wallpaper]"
  )
  .forEach(button => {

    button.addEventListener(
      "click",
      () => {

        applyWallpaper(
          button.dataset.wallpaper
        );

      }
    );

  });


if ($("#wallpaperInput")) {

  $("#wallpaperInput")
    .addEventListener(
      "change",
      event => {

        const file =
          event.target.files?.[0];


        if (!file) {
          return;
        }


        if (
          !file.type.startsWith(
            "image/"
          )
        ) {
          return;
        }


        const reader =
          new FileReader();


        reader.onload = () => {

          const data =
            String(
              reader.result
            );


          document.body.style.background =
            `linear-gradient(#0006,#0006),url("${data}")`;


          document.body.style.backgroundSize =
            "cover";


          document.body.style.backgroundPosition =
            "center";


          document.body.style.backgroundAttachment =
            "fixed";


          try {

            localStorage.setItem(
              "luxe_custom_wallpaper",
              data
            );


            localStorage.removeItem(
              "luxe_wallpaper"
            );

          } catch {}

        };


        reader.readAsDataURL(
          file
        );

      }
    );
}


if ($("#removeWallpaper")) {

  $("#removeWallpaper")
    .addEventListener(
      "click",
      () => {

        localStorage.removeItem(
          "luxe_custom_wallpaper"
        );


        localStorage.removeItem(
          "luxe_wallpaper"
        );


        document.body.style.background =
          wallpaperStyles.wall1;

      }
    );
}


/* =========================================================
   GENERIC OVERLAY
   ========================================================= */

function closeOverlay(element) {

  if (element) {

    element.classList.add(
      "hidden"
    );
  }
}


/* =========================================================
   KEYBOARD
   ========================================================= */

document.addEventListener(
  "keydown",
  event => {

    if (
      event.key ===
      "Escape"
    ) {

      [
        "#themePanel",
        "#playlistCreatePanel",
        "#addSongsPanel",
        "#playlistPanel",
        "#playerModal"
      ].forEach(selector => {

        const element =
          $(selector);


        if (
          element &&
          !element.classList.contains(
            "hidden"
          )
        ) {

          closeOverlay(
            element
          );
        }

      });
    }


    if (
      event.code === "Space" &&
      ![
        "INPUT",
        "TEXTAREA",
        "SELECT"
      ].includes(
        document.activeElement?.tagName
      )
    ) {

      event.preventDefault();


      if (current >= 0) {

        if (isNativeAndroid()) {
          luxeNativeTogglePlay();
        } else if (audio.paused) {

          audio.play()
            .catch(
              () => {}
            );

        } else {

          audio.pause();
        }
      }
    }

  }
);


/* =========================================================
   RESTORE APPEARANCE
   ========================================================= */

function restoreAppearance() {

  const theme =
    localStorage.getItem(
      "luxe_theme"
    ) || "deluxe";


  applyTheme(
    theme,
    false
  );


  const font =
    localStorage.getItem(
      "luxe_font"
    );


  if (font) {

    document.body.style.fontFamily =
      `"${font}", sans-serif`;


    if ($("#fontSelect")) {

      $("#fontSelect").value =
        font;
    }
  }


  const customWallpaper =
    localStorage.getItem(
      "luxe_custom_wallpaper"
    );


  if (customWallpaper) {

    document.body.style.background =
      `linear-gradient(#0006,#0006),url("${customWallpaper}")`;


    document.body.style.backgroundSize =
      "cover";


    document.body.style.backgroundPosition =
      "center";


    document.body.style.backgroundAttachment =
      "fixed";


  } else {

    const wallpaper =
      localStorage.getItem(
        "luxe_wallpaper"
      ) || "wall1";


    applyWallpaper(
      wallpaper,
      false
    );
  }
}


/* =========================================================
   RESTORE VOLUME
   ========================================================= */

function restoreVolume() {

  const saved =
    localStorage.getItem(
      "luxe_volume"
    );


  if (saved !== null) {

    const volume =
      Number(saved);


    if (isFinite(volume)) {

      audio.volume =
        Math.min(
          1,
          Math.max(
            0,
            volume
          )
        );


      if ($("#volume")) {

        $("#volume").value =
          audio.volume;
      }
    }


  } else {

    audio.volume =
      0.85;


    if ($("#volume")) {

      $("#volume").value =
        audio.volume;
    }
  }


  updateRangeProgress(
    $("#volume")
  );


  updateRangeProgress(
    $("#progress")
  );
}


/* =========================================================
   INIT
   ========================================================= */

async function init() {

  restoreAppearance();

  restoreVolume();

  updateViewButtons();

  if ($("#sortSelect")) $("#sortSelect").value = sortMode;

  updateStats();

  renderHome();


  const restored =
    await tryRestoreLibrary();


  /*
    Native Android restores its persistent folder
    asynchronously through MainActivity.java.
    Keep the startup state quiet while that scan
    is happening instead of asking the user to
    select the same folder again.
  */

  if (
    !restored &&
    !nativeLibraryLoaded &&
    !isNativeAndroid()
  ) {

    $("#welcome")
      ?.classList.remove(
        "hidden"
      );


    $("#library")
      ?.classList.add(
        "hidden"
      );


    $("#nav")
      ?.classList.add(
        "hidden"
      );
  }

  if (
    isNativeAndroid() &&
    !nativeLibraryLoaded
  ) {
    setFolderStatus("Restoring your music library…");
  }


  updateStats();

  updateViewButtons();

  render();

  renderHome();
}



/* =========================================================
   ANDROID-LIKE PLAYER FEATURES
   Added without replacing the existing playback system.
   ========================================================= */

let luxeWakeLock = null;
let luxeMediaSessionReady = false;
let luxeMediaPositionTimer = 0;
let luxePlayerSwipe = null;
let luxeGestureIgnore = false;

/* ---------------------------------------------------------
   HAPTIC FEEDBACK
--------------------------------------------------------- */
function luxeHaptic(pattern = 8) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {}
}

/* ---------------------------------------------------------
   WAKE LOCK
--------------------------------------------------------- */
async function luxeRequestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (audio.paused || audio.ended || luxeWakeLock) return;

  try {
    luxeWakeLock = await navigator.wakeLock.request('screen');
    luxeWakeLock.addEventListener('release', () => {
      luxeWakeLock = null;
    });
  } catch {}
}

async function luxeReleaseWakeLock() {
  if (!luxeWakeLock) return;
  try {
    await luxeWakeLock.release();
  } catch {}
  luxeWakeLock = null;
}

/* ---------------------------------------------------------
   MEDIA SESSION
   Connects LUXE to supported system/lock-screen controls,
   media keys and headset controls.
--------------------------------------------------------- */
function luxeArtworkForMediaSession(song) {
  if (!song || !song.artwork) return [];

  return [{
    src: song.artwork,
    sizes: '512x512',
    type: 'image/*'
  }];
}

function luxeUpdateMediaMetadata() {
  if (isNativeAndroid()) return;
  if (!('mediaSession' in navigator)) return;

  const song = songs[current];
  if (!song) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Unknown Title',
      artist: song.artist || 'Unknown Artist',
      album: song.album || 'LUXE Music',
      artwork: luxeArtworkForMediaSession(song)
    });
  } catch {}
}

function luxeUpdateMediaPosition() {
  if (isNativeAndroid()) return;
  if (!('mediaSession' in navigator)) return;
  if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;

  try {
    if ('setPositionState' in navigator.mediaSession) {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(
          Math.max(audio.currentTime || 0, 0),
          audio.duration
        )
      });
    }
  } catch {}
}

function luxeUpdateMediaPlaybackState() {
  if (isNativeAndroid()) return;
  if (!('mediaSession' in navigator)) return;

  try {
    navigator.mediaSession.playbackState =
      audio && !audio.paused && !audio.ended
        ? 'playing'
        : 'paused';
  } catch {}
}

function luxeSyncMediaSession() {
  if (isNativeAndroid()) return;
  if (!('mediaSession' in navigator)) return;
  luxeUpdateMediaMetadata();
  luxeUpdateMediaPlaybackState();
  luxeUpdateMediaPosition();
}

function luxeSeekBy(seconds) {
  if (!audio || !isFinite(audio.duration)) return;

  audio.currentTime = Math.min(
    Math.max((audio.currentTime || 0) + seconds, 0),
    audio.duration
  );

  luxeUpdateMediaPosition();
  luxeHaptic(6);
}

function luxeSetMediaSessionHandler(action, handler) {
  if (!('mediaSession' in navigator)) return;

  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {}
}

function luxeSetupMediaSession() {
  if (isNativeAndroid()) return;
  if (!('mediaSession' in navigator) || luxeMediaSessionReady) return;

  luxeMediaSessionReady = true;

  luxeSetMediaSessionHandler('play', () => {
    if (current >= 0) audio.play().catch(() => {});
  });

  luxeSetMediaSessionHandler('pause', () => {
    audio.pause();
  });

  luxeSetMediaSessionHandler('nexttrack', () => {
    playNext();
  });

  luxeSetMediaSessionHandler('previoustrack', () => {
    playPrevious();
  });

  luxeSetMediaSessionHandler('seekbackward', details => {
    luxeSeekBy(-Math.abs(details.seekOffset || 10));
  });

  luxeSetMediaSessionHandler('seekforward', details => {
    luxeSeekBy(Math.abs(details.seekOffset || 10));
  });

  luxeSetMediaSessionHandler('seekto', details => {
    if (!audio || !isFinite(audio.duration)) return;

    if (typeof details.seekTime === 'number') {
      audio.currentTime = Math.min(
        Math.max(details.seekTime, 0),
        audio.duration
      );
    }

    luxeUpdateMediaPosition();
  });

  luxeSetMediaSessionHandler('stop', () => {
    audio.pause();
    audio.currentTime = 0;
    luxeUpdateMediaPlaybackState();
    luxeUpdateMediaPosition();
  });

  luxeSyncMediaSession();
}

/* ---------------------------------------------------------
   PLAYER FAVORITE BUTTON
--------------------------------------------------------- */
function luxeUpdatePlayerFavorite() {
  const button = $('#playerFavoriteBtn');
  if (!button) return;

  const song = songs[current];
  const favorite = !!song && isFav(song);

  button.classList.toggle('active', favorite);
  button.setAttribute('aria-pressed', String(favorite));
  button.textContent = favorite ? '♥' : '♡';
}

if ($('#playerFavoriteBtn')) {
  $('#playerFavoriteBtn').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();

    const song = songs[current];
    if (!song) return;

    toggleFavorite(song.id);
    luxeUpdatePlayerFavorite();
    luxeHaptic(10);
  });
}

/* ---------------------------------------------------------
   PLAYER MORE / SONG INFORMATION
   Uses an in-app message instead of browser alert/popup.
--------------------------------------------------------- */
function luxeShowSongInfo() {
  const song = songs[current];
  if (!song) return;

  const target = [
    '#songInfoTitle',
    '#infoTitle',
    '#bigMeta'
  ].map(selector => $(selector)).find(Boolean);

  if (target) {
    target.textContent =
      `${song.artist || 'Unknown Artist'} • ${song.album || 'Local Music'}`;
    return;
  }

  const player = $('#playerModal');
  if (!player) return;

  let info = player.querySelector('.luxe-player-info');

  if (!info) {
    info = document.createElement('div');
    info.className = 'luxe-player-info';
    info.setAttribute('role', 'status');
    player.appendChild(info);
  }

  info.textContent =
    `${song.title || 'Unknown Title'} • ${song.artist || 'Unknown Artist'} • ${song.album || 'Local Music'}`;

  clearTimeout(info._luxeTimer);
  info._luxeTimer = setTimeout(() => info.remove(), 3000);
}

if ($('#playerMoreBtn')) {
  $('#playerMoreBtn').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    luxeShowSongInfo();
    luxeHaptic(8);
  });
}

/* ---------------------------------------------------------
   FULL PLAYER GESTURES
   Down = close player

   Horizontal movement is intentionally disabled so the
   entire LUXE screen never slides left/right.
--------------------------------------------------------- */
function luxeGestureTargetIsInteractive(target) {
  if (!target) return false;

  return !!target.closest(
    'button, input, select, textarea, a, label, [contenteditable="true"]'
  );
}

function luxeCloseFullPlayer() {
  $('#playerModal')?.classList.add('hidden');
  luxeHaptic(6);
}

function luxePlayerGestureStart(event) {
  if (!event.touches || event.touches.length !== 1) {
    luxePlayerSwipe = null;
    return;
  }

  if (luxeGestureTargetIsInteractive(event.target)) {
    luxeGestureIgnore = true;
    luxePlayerSwipe = null;
    return;
  }

  luxeGestureIgnore = false;
  const touch = event.touches[0];

  luxePlayerSwipe = {
    x: touch.clientX,
    y: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    moved: false
  };
}

function luxePlayerGestureMove(event) {
  if (luxeGestureIgnore || !luxePlayerSwipe) return;
  if (!event.touches || event.touches.length !== 1) return;

  const touch = event.touches[0];
  const dy = touch.clientY - luxePlayerSwipe.y;

  luxePlayerSwipe.lastX = touch.clientX;
  luxePlayerSwipe.lastY = touch.clientY;

  if (Math.abs(dy) > 12) {
    luxePlayerSwipe.moved = true;
  }

  /* Never translate the artwork horizontally. */
}

function luxePlayerGestureEnd() {
  if (luxeGestureIgnore || !luxePlayerSwipe) {
    luxeGestureIgnore = false;
    luxePlayerSwipe = null;
    return;
  }

  const swipe = luxePlayerSwipe;
  luxePlayerSwipe = null;

  const dy = swipe.lastY - swipe.y;

  if (!swipe.moved) return;

  if (dy > 75) {
    luxeCloseFullPlayer();
  }
}

const luxeGestureArea = $('#playerModal') || $('#bigArt');

if (luxeGestureArea) {
  luxeGestureArea.addEventListener('touchstart', luxePlayerGestureStart, { passive: true });
  luxeGestureArea.addEventListener('touchmove', luxePlayerGestureMove, { passive: true });
  luxeGestureArea.addEventListener('touchend', luxePlayerGestureEnd, { passive: true });
  luxeGestureArea.addEventListener('touchcancel', luxePlayerGestureEnd, { passive: true });
}

/* ---------------------------------------------------------
   DOUBLE-TAP ARTWORK = PLAY / PAUSE
--------------------------------------------------------- */
let luxeLastArtworkTap = 0;

if ($('#bigArt')) {
  $('#bigArt').addEventListener('click', event => {
    if (luxeGestureTargetIsInteractive(event.target)) return;

    const now = Date.now();

    if (now - luxeLastArtworkTap < 320) {
      if (current >= 0) {
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
        luxeHaptic(10);
      }

      luxeLastArtworkTap = 0;
      return;
    }

    luxeLastArtworkTap = now;
  });
}

/* ---------------------------------------------------------
   LIGHT HAPTIC FEEDBACK FOR EXISTING CONTROLS
--------------------------------------------------------- */
document.addEventListener('click', event => {
  const control = event.target.closest(
    'button, .library-tab, .nav-item, .song-row, .recent-card, .playlist-card, .add-song-item'
  );

  if (control) luxeHaptic(5);
}, { passive: true });

/* ---------------------------------------------------------
   MEDIA SESSION + WAKE LOCK EVENT SYNC
--------------------------------------------------------- */
if (audio) {
  audio.addEventListener('play', () => {
    luxeNativePlaybackKeepAlive(true);
    luxeSetupMediaSession();
    luxeSyncNativePlaybackNotification();
    luxeUpdateMediaMetadata();
    luxeUpdateMediaPlaybackState();
    luxeRequestWakeLock();
  });

  audio.addEventListener('pause', () => {
    luxeUpdateMediaPlaybackState();
    luxeSyncNativePlaybackNotification();
    luxeReleaseWakeLock();
  });

  audio.addEventListener('loadedmetadata', () => {
    luxeUpdateMediaMetadata();
    luxeUpdateMediaPosition();
    luxeSyncNativePlaybackNotification();
  });

  audio.addEventListener('timeupdate', () => {
    if (Date.now() - luxeMediaPositionTimer > 400) {
      luxeMediaPositionTimer = Date.now();
      luxeUpdateMediaPosition();
      luxeSyncNativePlaybackNotification();
    }
  });

  audio.addEventListener('ratechange', luxeUpdateMediaPosition);

  audio.addEventListener('ended', () => {
    luxeUpdateMediaPlaybackState();
    luxeSyncNativePlaybackNotification();
    luxeReleaseWakeLock();
    luxeUpdateMediaPosition();
  });
}

/* ---------------------------------------------------------
   VISIBILITY / BACKGROUND SYNCHRONIZATION
--------------------------------------------------------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    luxeSyncMediaSession();

    if (audio && !audio.paused && !audio.ended) {
      luxeRequestWakeLock();
    }
  } else {
    luxeUpdateMediaPlaybackState();
    luxeUpdateMediaPosition();
    luxeSyncNativePlaybackNotification();
    if (!isNativeAndroid() && audio && !audio.paused && !audio.ended) {
      luxeNativePlaybackKeepAlive(true);
      setTimeout(() => {
        if (audio && !audio.paused && !audio.ended) luxeTryPlayBackground();
      }, 80);
    }
  }
});

window.addEventListener('pageshow', luxeSyncMediaSession);

window.addEventListener('pagehide', () => {
  luxeUpdateMediaPlaybackState();
  luxeUpdateMediaPosition();
});

/* ---------------------------------------------------------
   CONNECT NEW FEATURES TO THE EXISTING PLAYER
--------------------------------------------------------- */
const luxeOriginalPlaySong = playSong;

playSong = function(songIndex, queue = songs) {
  luxeOriginalPlaySong(songIndex, queue);
  luxeUpdatePlayerFavorite();
  luxeUpdateMediaMetadata();
  luxeUpdateMediaPlaybackState();

  if (!isNativeAndroid() && audio && !audio.paused) luxeRequestWakeLock();
};

const luxeOriginalUpdatePlayer = updatePlayer;

updatePlayer = function() {
  luxeOriginalUpdatePlayer();
  luxeUpdatePlayerFavorite();
  luxeUpdateMediaMetadata();
  luxeUpdateMediaPlaybackState();
  luxeUpdateMediaPosition();
  luxeSyncNativePlaybackNotification();
};

/* ---------------------------------------------------------
   INITIAL MEDIA SESSION SETUP
--------------------------------------------------------- */
luxeSetupMediaSession();

init();
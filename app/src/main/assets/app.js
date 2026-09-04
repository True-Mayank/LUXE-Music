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
        "LUXE native folder error:",
        error
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
      )
    ]
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


  const playPromise =
    audio.play();


  if (playPromise) {

    playPromise.catch(
      () => {}
    );
  }


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


  $("#miniPlayer")
    ?.classList.remove(
      "hidden"
    );


  renderHome();
}


/* =========================================================
   PLAYER UI
   ========================================================= */

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

  const playing =
    !audio.paused &&
    !audio.ended;


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
        event.target.closest(
          "button"
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


if ($("#miniPlay")) {

  $("#miniPlay").addEventListener(
    "click",
    event => {

      event.stopPropagation();


      if (current < 0) {
        return;
      }


      if (audio.paused) {

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


      if (audio.paused) {

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


      $("#repeatBtn")
        .classList.toggle(
          "active",
          repeat
        );

    }
  );
}


/* =========================================================
   NEXT / PREVIOUS
   ========================================================= */

function playNext() {

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

      if (repeat) {

        audio.currentTime =
          0;

        audio.play()
          .catch(
            () => {}
          );

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

  $("#progress").addEventListener(
    "input",
    event => {

      if (audio.duration) {

        audio.currentTime =
          audio.duration *
          (
            Number(
              event.target.value
            ) / 100
          );
      }


      updateRangeProgress(
        event.target
      );

    }
  );
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
    $("#playlistGrid");


  if (!grid) {
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
}


/* =========================================================
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

        if (audio.paused) {

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

  updateStats();

  renderHome();


  const restored =
    await tryRestoreLibrary();


  /*
    Native Android has its own persistent
    folder restoration.

    Do not hide the native library if
    Android has already returned it.
  */

  if (
    !restored &&
    !nativeLibraryLoaded
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


  updateStats();

  updateViewButtons();

  render();

  renderHome();
}


init();
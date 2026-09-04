"use strict";

const statusEl = document.querySelector("#status");
const songsEl = document.querySelector("#songs");
const audio = document.querySelector("#audio");
let nativeSongs = [];

window.addEventListener("luxe:native-library", event => {
  const payload = event.detail || {};
  nativeSongs = Array.isArray(payload.songs) ? payload.songs : [];
  statusEl.textContent = `${nativeSongs.length} audio files found in the selected folder.`;
  renderSongs();
});

window.addEventListener("luxe:native-error", event => {
  statusEl.textContent = event.detail?.message || "Unable to read the selected folder.";
});

function renderSongs(){
  if(!nativeSongs.length){
    songsEl.innerHTML = "";
    return;
  }

  songsEl.innerHTML = nativeSongs.map((song,index) => `
    <button class="track" data-index="${index}">
      <div>
        <strong>${escapeHTML(song.title || song.name)}</strong>
        <span>${escapeHTML(song.artist || "Unknown Artist")}</span>
      </div>
      <span class="play">▶</span>
    </button>
  `).join("");
}

songsEl.addEventListener("click", event => {
  const row = event.target.closest("[data-index]");
  if(!row) return;
  const song = nativeSongs[Number(row.dataset.index)];
  if(!song) return;
  audio.src = song.url;
  audio.play().catch(() => {});
});

function escapeHTML(value){
  return String(value ?? "").replace(/[&<>\"']/g, char => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"
  })[char]);
}

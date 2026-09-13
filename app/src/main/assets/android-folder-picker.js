/*
  LUXE Android native folder bridge.
  Keep this file next to index.html/app.js and load it BEFORE app.js.
*/
(function () {
  "use strict";

  const nativeAvailable =
    typeof window.LuxeAndroid !== "undefined" &&
    typeof window.LuxeAndroid.pickMusicFolder === "function";

  window.LUXEAndroid = window.LUXEAndroid || {};
  window.LUXEAndroid.isNative = nativeAvailable;

  window.LUXEAndroid.pickFolder = function () {
    if (!nativeAvailable) return false;
    window.LuxeAndroid.pickMusicFolder();
    return true;
  };

  window.LUXEAndroid.rescan = function () {
    if (!nativeAvailable) return false;
    window.LuxeAndroid.rescanMusicFolder();
    return true;
  };

  window.LUXEAndroid.forgetFolder = function () {
    if (!nativeAvailable) return false;
    window.LuxeAndroid.forgetMusicFolder();
    return true;
  };

  window.LUXEAndroid.onFolderSelected = function (json) {
    let payload;
    try {
      payload = typeof json === "string" ? JSON.parse(json) : json;
    } catch (error) {
      console.error("Invalid native library payload", error);
      return;
    }

    window.dispatchEvent(new CustomEvent("luxe:native-library", {
      detail: payload
    }));
  };

  window.LUXEAndroid.onError = function (message) {
    window.dispatchEvent(new CustomEvent("luxe:native-error", {
      detail: { message: String(message || "Native folder error") }
    }));
  };

  window.LUXEAndroid.onFolderCleared = function () {
    window.dispatchEvent(new CustomEvent("luxe:native-folder-cleared"));
  };

  document.addEventListener("DOMContentLoaded", function () {
    const button = document.querySelector("#chooseFolderBtn");
    if (!button || !nativeAvailable) return;

    // Capture phase prevents the browser-only webkitdirectory handler
    // from running inside the Android wrapper.
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.LuxeAndroid.pickMusicFolder();
    }, true);
  });
})();

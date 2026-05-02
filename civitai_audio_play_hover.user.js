// ==UserScript==
// @name         Civitai Hover Video Audio - Synced Unlock Button
// @namespace    https://civitai.com/
// @version      1.3.1
// @description  Enable synced audio on hovered Civitai videos, with delayed switching and first-use unlock button.
// @author       alexds9
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @match        https://civitai.green/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const CONFIG = {
    hoverDelayMs: 500,
    volume: 1.0,
    debug: false,

    // Your preferred behavior.
    restartVideoWhenAudioStarts: true,

    // If true, try to play the video if it is paused.
    playIfPaused: true,

    // Prevents the "freeze on first frame" issue before audio is unlocked.
    avoidPreActivationFreeze: true,

    // First-use unlock popup.
    showUnlockPopup: true,
    unlockPopupText: "Play Audio ?",

    showStatus: true,
  };

  let hoverTimer = null;
  let hoverVideo = null;
  let activeVideo = null;
  let unlockedByUserGesture = false;
  let loopEndTimer = null;

  let lastPointerX = 0;
  let lastPointerY = 0;

  let unlockPopup = null;
  let unlockPopupVideo = null;
  let unlockPopupHideTimer = null;

  const activeListeners = new WeakMap();

  const log = (...args) => {
    if (CONFIG.debug) console.log("[Civitai Hover Synced Audio]", ...args);
  };

  const toast = (() => {
    let el = null;
    let timer = null;

    return (text) => {
      if (!CONFIG.showStatus) return;

      if (!el) {
        el = document.createElement("div");
        el.style.position = "fixed";
        el.style.left = "12px";
        el.style.bottom = "12px";
        el.style.padding = "6px 9px";
        el.style.borderRadius = "8px";
        el.style.background = "rgba(0, 0, 0, 0.72)";
        el.style.color = "#fff";
        el.style.font = "12px/1.35 system-ui, sans-serif";
        el.style.zIndex = "2147483647";
        el.style.pointerEvents = "none";
        el.style.opacity = "0";
        el.style.transition = "opacity 120ms ease";
        document.documentElement.appendChild(el);
      }

      el.textContent = text;
      el.style.opacity = "1";

      clearTimeout(timer);
      timer = setTimeout(() => {
        el.style.opacity = "0";
      }, 1200);
    };
  })();

  function hasUserActivation() {
    if (unlockedByUserGesture) return true;

    try {
      if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
        return true;
      }
    } catch (_) {
      // Ignore.
    }

    return false;
  }

  function markUnlocked() {
    unlockedByUserGesture = true;
    hideUnlockPopup();
  }

  document.addEventListener("pointerdown", (event) => {
    if (unlockPopup && unlockPopup.contains(event.target)) return;
    markUnlocked();
  }, true);

  document.addEventListener("keydown", markUnlocked, true);

  document.addEventListener("click", (event) => {
    if (unlockPopup && unlockPopup.contains(event.target)) return;
    markUnlocked();
  }, true);

  function getVideoFromEventTarget(target) {
    if (!target || !(target instanceof Element)) return null;

    const directVideo = target.closest("video");
    if (directVideo) return directVideo;

    const edgeVideoBox = target.closest('[class*="EdgeVideo_"], [class*="EdgeVideo"]');
    if (edgeVideoBox) {
      const video = edgeVideoBox.querySelector("video");
      if (video) return video;
    }

    return null;
  }

  function getVideoHoverWrapper(video) {
    if (!video) return null;
    return video.closest('[class*="EdgeVideo_"], [class*="EdgeVideo"]');
  }

  function isPopupVisible() {
    return !!(unlockPopup && unlockPopup.style.display !== "none");
  }

  function isNodeInsideUnlockPopup(node) {
    return !!(unlockPopup && node && node instanceof Node && unlockPopup.contains(node));
  }

  function isVideoStillHovered(video) {
    if (!video || !document.contains(video)) return false;

    const wrapper = getVideoHoverWrapper(video);

    return (
      video.matches(":hover") ||
      !!(wrapper && wrapper.matches(":hover")) ||
      !!(unlockPopupVideo === video && isPopupVisible() && unlockPopup.matches(":hover"))
    );
  }

  function isInsideSameVideoArea(video, node) {
    if (!video || !node || !(node instanceof Node)) return false;

    if (video.contains(node)) return true;

    const wrapper = getVideoHoverWrapper(video);
    if (wrapper && wrapper.contains(node)) return true;

    if (unlockPopupVideo === video && isNodeInsideUnlockPopup(node)) return true;

    return false;
  }

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function clearLoopEndTimer() {
    if (loopEndTimer) {
      clearTimeout(loopEndTimer);
      loopEndTimer = null;
    }
  }

  function clearUnlockPopupHideTimer() {
    if (unlockPopupHideTimer) {
      clearTimeout(unlockPopupHideTimer);
      unlockPopupHideTimer = null;
    }
  }

  function removeActiveListeners(video) {
    const listeners = activeListeners.get(video);
    if (!listeners) return;

    video.removeEventListener("ended", listeners.onEnded, true);
    video.removeEventListener("pause", listeners.onPause, true);
    video.removeEventListener("emptied", listeners.onInvalid, true);
    video.removeEventListener("error", listeners.onInvalid, true);
    activeListeners.delete(video);
  }

  function muteVideo(video) {
    if (!video) return;

    try {
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
    } catch (err) {
      log("mute error", err);
    }
  }

  function stopActiveAudio(reason = "stop") {
    clearHoverTimer();
    clearLoopEndTimer();

    if (activeVideo) {
      removeActiveListeners(activeVideo);
      muteVideo(activeVideo);
    }

    activeVideo = null;

    if (reason !== "switch") {
      toast("Audio stopped");
    }
  }

  function attachActiveListeners(video) {
    removeActiveListeners(video);

    const listeners = {
      onEnded: () => {
        if (video !== activeVideo) return;

        if (isVideoStillHovered(video)) {
          enableAudioForVideo(video, { fromEnded: true });
        } else {
          stopActiveAudio();
        }
      },

      onPause: () => {
        if (video !== activeVideo) return;

        if (!isVideoStillHovered(video)) {
          stopActiveAudio();
        }
      },

      onInvalid: () => {
        if (video === activeVideo) {
          stopActiveAudio();
        }
      },
    };

    activeListeners.set(video, listeners);

    video.addEventListener("ended", listeners.onEnded, true);
    video.addEventListener("pause", listeners.onPause, true);
    video.addEventListener("emptied", listeners.onInvalid, true);
    video.addEventListener("error", listeners.onInvalid, true);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function createUnlockPopup() {
    if (unlockPopup) return unlockPopup;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = CONFIG.unlockPopupText;

    btn.style.position = "fixed";
    btn.style.zIndex = "2147483647";
    btn.style.display = "none";

    // Larger, clearer, still compact.
    btn.style.padding = "10px 15px";
    btn.style.minWidth = "118px";
    btn.style.border = "1px solid rgba(255, 255, 255, 0.55)";
    btn.style.borderRadius = "999px";
    btn.style.background = "rgba(18, 18, 18, 0.94)";
    btn.style.color = "#ffffff";
    btn.style.font = "700 15px/1.2 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    btn.style.letterSpacing = "0.01em";
    btn.style.boxShadow = "0 8px 22px rgba(0, 0, 0, 0.42)";
    btn.style.backdropFilter = "blur(6px)";
    btn.style.cursor = "pointer";
    btn.style.pointerEvents = "auto";
    btn.style.userSelect = "none";
    btn.style.opacity = "0";
    btn.style.transform = "translateY(3px) scale(0.98)";
    btn.style.transition = "opacity 120ms ease, transform 120ms ease, background 120ms ease, border-color 120ms ease";

    btn.addEventListener("mouseenter", () => {
      clearUnlockPopupHideTimer();
      btn.style.background = "rgba(35, 35, 35, 0.98)";
      btn.style.borderColor = "rgba(255, 255, 255, 0.75)";
    });

    btn.addEventListener("mouseleave", () => {
      btn.style.background = "rgba(18, 18, 18, 0.94)";
      btn.style.borderColor = "rgba(255, 255, 255, 0.55)";

      const video = unlockPopupVideo;
      unlockPopupHideTimer = setTimeout(() => {
        if (video && !isVideoStillHovered(video)) {
          hideUnlockPopup();
        }
      }, 250);
    });

    btn.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      unlockedByUserGesture = true;
    }, true);

    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const video = unlockPopupVideo;

      unlockedByUserGesture = true;
      hideUnlockPopup();

      if (video && document.contains(video)) {
        await enableAudioForVideo(video, {
          forceAfterUnlockClick: true,
          allowPopupClickStart: true,
        });
      }
    }, true);

    document.documentElement.appendChild(btn);
    unlockPopup = btn;
    return btn;
  }

  function showUnlockPopupNearCursor(video, clientX = lastPointerX, clientY = lastPointerY) {
    if (!CONFIG.showUnlockPopup) return;
    if (!video || !document.contains(video)) return;

    clearUnlockPopupHideTimer();

    const btn = createUnlockPopup();
    unlockPopupVideo = video;

    btn.style.display = "block";

    const offsetX = 16;
    const offsetY = 18;

    btn.style.opacity = "0";
    btn.style.left = "0px";
    btn.style.top = "0px";

    const rect = btn.getBoundingClientRect();
    const width = rect.width || 120;
    const height = rect.height || 40;

    const x = clamp(clientX + offsetX, 8, window.innerWidth - width - 8);
    const y = clamp(clientY + offsetY, 8, window.innerHeight - height - 8);

    btn.style.left = `${x}px`;
    btn.style.top = `${y}px`;

    requestAnimationFrame(() => {
      if (!unlockPopup || unlockPopup !== btn) return;
      btn.style.opacity = "1";
      btn.style.transform = "translateY(0) scale(1)";
    });
  }

  function hideUnlockPopup() {
    if (!unlockPopup) return;

    clearUnlockPopupHideTimer();

    unlockPopup.style.opacity = "0";
    unlockPopup.style.transform = "translateY(3px) scale(0.98)";

    const popupToHide = unlockPopup;
    setTimeout(() => {
      if (unlockPopup !== popupToHide) return;
      popupToHide.style.display = "none";
      unlockPopupVideo = null;
    }, 130);
  }

  async function enableAudioForVideo(video, options = {}) {
    if (!video || !document.contains(video)) return;

    // Normal hover start requires the video area to still be hovered.
    // Popup click start is allowed because the cursor may be over the popup, not the video.
    if (!options.allowPopupClickStart && !isVideoStillHovered(video)) return;

    const browserHasActivation = hasUserActivation() || options.forceAfterUnlockClick;

    if (CONFIG.avoidPreActivationFreeze && !browserHasActivation) {
      showUnlockPopupNearCursor(video);
      log("Showing unlock popup instead of starting audio before user activation");
      return;
    }

    hideUnlockPopup();

    // Only stop the old active audio after the new video really passed the delay
    // and is actually going to start audio.
    if (activeVideo && activeVideo !== video) {
      stopActiveAudio("switch");
    }

    activeVideo = video;
    attachActiveListeners(video);
    clearLoopEndTimer();

    try {
      if (CONFIG.restartVideoWhenAudioStarts && !options.fromEnded) {
        video.currentTime = 0;
      }

      video.muted = false;
      video.defaultMuted = false;
      video.volume = CONFIG.volume;

      if (CONFIG.playIfPaused && video.paused) {
        await video.play();
      }

      toast("Synced audio enabled");
      log("Audio enabled on visible video", {
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        muted: video.muted,
      });
    } catch (err) {
      log("enable audio failed", err);

      muteVideo(video);

      if (!hasUserActivation()) {
        showUnlockPopupNearCursor(video);
      } else {
        toast("Could not enable audio");
      }

      if (activeVideo === video) {
        removeActiveListeners(video);
        activeVideo = null;
      }
    }
  }

  function schedulePlay(video) {
    clearHoverTimer();

    if (!video || !document.contains(video)) return;

    hoverVideo = video;

    hoverTimer = setTimeout(() => {
      hoverTimer = null;

      if (hoverVideo !== video) return;
      if (!document.contains(video)) return;
      if (!isVideoStillHovered(video)) return;

      enableAudioForVideo(video);
    }, CONFIG.hoverDelayMs);
  }

  function scheduleMuteAtEndOfCurrentLoop(video) {
    clearLoopEndTimer();

    if (!video || video !== activeVideo) return;

    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);

    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) {
      loopEndTimer = setTimeout(() => {
        if (video === activeVideo && !isVideoStillHovered(video)) {
          stopActiveAudio();
        }
      }, 1000);
      return;
    }

    const remainingSeconds = Math.max(0.05, duration - currentTime);
    const remainingMs = Math.ceil(remainingSeconds * 1000) + 80;

    loopEndTimer = setTimeout(() => {
      if (video !== activeVideo) return;

      if (isVideoStillHovered(video)) {
        enableAudioForVideo(video, { fromEnded: true });
      } else {
        stopActiveAudio();
      }
    }, remainingMs);
  }

  function handlePointerOver(event) {
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    if (isNodeInsideUnlockPopup(event.target)) {
      clearUnlockPopupHideTimer();
      return;
    }

    const video = getVideoFromEventTarget(event.target);
    if (!video) return;

    if (hoverVideo === video || activeVideo === video) return;

    // Do not stop active audio here.
    // The old audio keeps playing unless the new video really starts after hoverDelayMs.
    schedulePlay(video);
  }

  function handlePointerOut(event) {
    if (isNodeInsideUnlockPopup(event.target)) {
      const video = unlockPopupVideo;

      unlockPopupHideTimer = setTimeout(() => {
        if (video && !isVideoStillHovered(video)) {
          hideUnlockPopup();
        }
      }, 250);

      return;
    }

    const video = getVideoFromEventTarget(event.target);
    if (!video) return;

    if (isInsideSameVideoArea(video, event.relatedTarget)) return;

    if (hoverVideo === video) {
      hoverVideo = null;
      clearHoverTimer();
    }

    if (unlockPopupVideo === video) {
      unlockPopupHideTimer = setTimeout(() => {
        if (unlockPopupVideo === video && !isVideoStillHovered(video)) {
          hideUnlockPopup();
        }
      }, 250);
    }

    if (activeVideo === video) {
      scheduleMuteAtEndOfCurrentLoop(video);
    }
  }

  function handlePointerMove(event) {
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    if (isNodeInsideUnlockPopup(event.target)) {
      clearUnlockPopupHideTimer();
      return;
    }

    if (unlockPopup && unlockPopup.style.display !== "none" && unlockPopupVideo) {
      if (!isVideoStillHovered(unlockPopupVideo)) {
        unlockPopupHideTimer = setTimeout(() => {
          if (unlockPopupVideo && !isVideoStillHovered(unlockPopupVideo)) {
            hideUnlockPopup();
          }
        }, 250);
      }
    }

    if (!activeVideo) return;

    const video = getVideoFromEventTarget(event.target);

    if (video === activeVideo && isVideoStillHovered(activeVideo)) {
      clearLoopEndTimer();
    }
  }

  document.addEventListener("pointerover", handlePointerOver, true);
  document.addEventListener("pointerout", handlePointerOut, true);
  document.addEventListener("pointermove", handlePointerMove, true);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hideUnlockPopup();
      stopActiveAudio();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideUnlockPopup();
      stopActiveAudio();
    }
  }, true);
})();
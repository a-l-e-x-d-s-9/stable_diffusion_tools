// ==UserScript==
// @name         Grok Imagine Prompt Inspector
// @namespace    https://grok.com/
// @version      1.0.0
// @description  Inspect original prompts and prompt history directly inside Grok Imagine with an inline inspector.
// @match        https://grok.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const postStore = {};
  let activePanel = null;
  let hoverTimer = null;

  // Hook fetch to capture media post list
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);

    try {
      const url = args[0] && args[0].toString ? args[0].toString() : '';
      if (url.includes('/rest/media/post/list')) {
        res.clone().json().then((data) => {
          if (data && data.posts && data.posts.length > 0) {
            data.posts.forEach((post) => {
              if (!post) return;
              if (post.originalPostId) {
                postStore[post.originalPostId] = post;
              } else {
                postStore[post.id] = post;
              }
            });
          }
        });
      }
    } catch (e) {}

    return res;
  };

  function isImaginePage() {
    return (
      location.pathname === '/imagine' ||
      location.pathname.startsWith('/imagine/')
    );
  }

  function isPublicImagineImage(src) {
    if (!src) return false;
    return src.includes('xai-images-public');
  }

  function extractPostIdFromCard(card) {
    const media = card.querySelector('img, video');
    if (!media) return null;

    const src = media.src || media.poster;
    if (!src) return null;

    // imagine-public (share-images)
    if (isImaginePage() && src.includes('imagine-public')) {
      const m = src.match(/\/([0-9a-fA-F-]{36})\.(jpg|png|webp|mp4)(\?|$)/);
      if (m) return m[1];
    }

    // grok assets (content / preview)
    const m = src.match(/\/([0-9a-fA-F-]{36})\/(content|preview_image|generated_video)/);
    if (m) return m[1];

    return null;
  }

  function injectUI() {
    const cards = document.querySelectorAll('[role="listitem"] .group\\/media-post-masonry-card');
    cards.forEach((card) => {
      if (card.querySelector('.prompt-inspector-btn')) return;

      const media = card.querySelector('img, video');
      if (!media) return;

      const src = media.src || media.poster;
      if (!src) return;

      const btn = document.createElement('button');
      btn.className = 'prompt-inspector-btn';
      btn.textContent = '*';
      Object.assign(btn.style, {
        position: 'absolute',
        top: '8px',
        left: '8px',
        background: 'rgba(0,0,0,0.6)',
        color: '#fff',
        borderRadius: '999px',
        width: '32px',
        height: '32px',
        cursor: 'pointer',
        pointerEvents: 'auto',
        zIndex: 9999
      });

      btn.addEventListener('mouseenter', (e) => {
        e.stopPropagation();
        openPanel(card);
      });

      btn.addEventListener('mouseleave', () => {
        scheduleClosePanel();
      });

      card.style.position = 'relative';

      if (!isPublicImagineImage(src)) {
        card.appendChild(btn);
      }
    });
  }

  function scheduleClosePanel() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      closeExistingPanel();
    }, 150);
  }

  function closeExistingPanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
  }

  function formatTime(iso) {
    if (!iso) return 'unknown time';

    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown time';

    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function renderPromptBlock(title, text, time, postId) {
    if (!text) return '';

    const safeTitle = String(title || '');
    const safeText = String(text || '');

    return `
      <div style="
        margin-top:6px;
        padding:8px;
        border-radius:10px;
        background:rgba(255,255,255,0.06);
      ">
        <div style="
          display:flex;
          justify-content:space-between;
          align-items:center;
          margin-bottom:6px;
        ">
          <div style="font-size:11px;opacity:.8;">
            <b>${safeTitle}</b>
            ${time ? `<span style="margin-left:6px;"> - ${formatTime(time)}</span>` : ''}
          </div>
        </div>

        <pre style="
          white-space:pre-wrap;
          margin:0;
          font-size:12px;
        ">${safeText}</pre><br/>
        <div style="display:flex;gap:6px;">
          <button
            data-copy="${encodeURIComponent(safeText)}"
            style="
              font-size:11px;
              padding:4px 6px;
              border-radius:6px;
              background:#222;
              color:#fff;
              border:1px solid rgba(255,255,255,.15);
              cursor:pointer;
            "
          >Copy</button>

          ${postId ? `<button
            data-open="${postId}"
            style="
              font-size:11px;
              padding:4px 6px;
              border-radius:6px;
              background:#222;
              color:#fff;
              border:1px solid rgba(255,255,255,.15);
              cursor:pointer;
            "
          >Open</button>` : ''}
        </div>
      </div>
    `;
  }

  function openPanel(card) {
    clearTimeout(hoverTimer);
    closeExistingPanel();

    const postId = extractPostIdFromCard(card);
    const post = postStore[postId];
    // console.log('post', post);

    const panel = document.createElement('div');
    panel.className = 'prompt-inspector-panel';

    let html = `<strong>Prompt Inspector</strong><br/>`;

    if (!post) {
      html += `<em>Post data not loaded yet</em>`;
    } else {
      const w = (post.resolution && post.resolution.width) ? post.resolution.width : '?';
      const h = (post.resolution && post.resolution.height) ? post.resolution.height : '?';

      html += `
        <div style="margin-top:6px;font-size:12px;">
          <div style="margin-bottom:10px;">
            <b>Metadata</b>
            <div style="margin-top:4px;line-height:1.5;">
              <div><b>Model:</b> ${post.modelName || 'unknown'}</div>
              <div><b>Resolution:</b> ${w}x${h}</div>
              <div><b>Created:</b> ${formatTime(post.createTime)}</div>
            </div>
          </div>

          <div style="margin-top:8px;">
            <b>Prompt Layers</b>

            ${renderPromptBlock(
              'Original (Root)',
              post.originalPost && post.originalPost.originalPrompt,
              post.originalPost && post.originalPost.createTime,
              post.originalPost && post.originalPost.id
            )}

            ${renderPromptBlock(
              'User Input',
              post.originalPrompt,
              post.createTime,
              post.id
            )}

            ${renderPromptBlock(
              'Effective (Sent to Model)',
              post.prompt,
              post.createTime,
              post.id
            )}
          </div>
        </div>
      `;

      if (post.childPosts && post.childPosts.length) {
        html += `<div style="margin-top:8px;"><b>Prompt History:</b></div>`;

        post.childPosts.forEach((child, i) => {
          const promptText = (child && (child.originalPrompt || child.prompt)) || '(empty)';

          html += `
            <div style="
              margin-top:6px;
              padding:6px;
              border-radius:8px;
              background:rgba(255,255,255,0.06);
            ">
              <div style="font-size:11px;opacity:.7;display:flex;justify-content:space-between;">
                <span>Prompt ${i + 1}</span>
                <span>${formatTime(child && child.createTime)}</span>
              </div>

              <pre style="white-space:pre-wrap;margin:4px 0 6px 0;">${String(promptText)}</pre>

              <div style="display:flex;gap:6px;">
                <button
                  data-copy="${encodeURIComponent(String(promptText))}"
                  style="
                    font-size:11px;
                    padding:4px 6px;
                    border-radius:6px;
                    background:#222;
                    color:#fff;
                    border:1px solid rgba(255,255,255,.15);
                    cursor:pointer;
                  "
                >Copy</button>

                <button
                  data-open="${child && child.id}"
                  style="
                    font-size:11px;
                    padding:4px 6px;
                    border-radius:6px;
                    background:#222;
                    color:#fff;
                    border:1px solid rgba(255,255,255,.15);
                    cursor:pointer;
                  "
                >Open</button>
              </div>
            </div>
          `;
        });
      }
    }

    panel.innerHTML = html;

    Object.assign(panel.style, {
      position: 'absolute',
      inset: '0',
      background: 'rgba(0,0,0,0.85)',
      color: '#fff',
      padding: '12px',
      paddingTop: '40px',
      borderRadius: '16px',
      zIndex: 20,
      overflowY: 'auto',
      fontSize: '12px',
      pointerEvents: 'auto'
    });

    panel.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
    panel.addEventListener('mouseleave', () => scheduleClosePanel());

    // COPY BUTTON
    panel.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.onclick = (e) => {
        navigator.clipboard.writeText(decodeURIComponent(btn.dataset.copy || ''));
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 800);
        e.stopImmediatePropagation();
      };
    });

    // OPEN DETAIL
    panel.querySelectorAll('[data-open]').forEach((btn) => {
      btn.onclick = (e) => {
        const id = btn.dataset.open;
        if (id) {
          window.open(`https://grok.com/imagine/post/${id}`, '_blank');
        }
        e.stopImmediatePropagation();
      };
    });

    panel.addEventListener('mouseleave', () => {
      card.style.pointerEvents = '';
      scheduleClosePanel();
    });

    card.style.position = 'relative';
    card.appendChild(panel);
    activePanel = panel;
  }

  function waitForBody() {
    if (!document.body) {
      return setTimeout(waitForBody, 50);
    }

    const observer = new MutationObserver(injectUI);
    observer.observe(document.body, { childList: true, subtree: true });

    injectUI();
  }

  waitForBody();
})();

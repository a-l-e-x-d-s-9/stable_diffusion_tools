// ==UserScript==
// @name         Extract files to clipboard
// @namespace    http://tampermonkey.net/
// @version      2026-04-24.2
// @description  Extract download links from Civitai using the API first, with CORS-safe requests and DOM fallbacks
// @author       You
// @match        https://civitai.com/models/*
// @match        https://civitai.green/models/*
// @match        https://civitai.red/models/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=civitai.com
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      civitai.com
// @connect      civitai.red
// @connect      civitai.green
// ==/UserScript==

(function() {
    'use strict';

    const API_BASE = window.location.origin;

    function getCurrentUrl() {
        return new URL(window.location.href);
    }

    function getModelIdFromUrl() {
        const match = window.location.pathname.match(/\/models\/(\d+)/);
        return match ? match[1] : '';
    }

    function getModelVersionIdFromUrl() {
        const url = getCurrentUrl();
        return url.searchParams.get('modelVersionId') || '';
    }

    function getModelVersionIdFromDomFallback() {
        const selectors = [
            'a[href*="modelVersionId="]',
            'a[href*="/api/download/models/"]'
        ];

        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                const href = element.getAttribute('href') || '';

                const versionParamMatch = href.match(/[?&]modelVersionId=(\d+)/);
                if (versionParamMatch) return versionParamMatch[1];

                const downloadPathMatch = href.match(/\/api\/download\/models\/(\d+)/);
                if (downloadPathMatch) return downloadPathMatch[1];
            }
        }

        return '';
    }

    function getModelTitleFromDomFallback() {
        const titleElement = document.querySelector('h1') || document.querySelector('.mantine-Title-root');
        return titleElement ? titleElement.innerText.trim() : '';
    }

    function sanitizeFilename(value) {
        return String(value || '')
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    function shellQuoteDouble(value) {
        return String(value || '').replace(/["\\$`]/g, '\\$&');
    }

    function buildUrl(path, base, token) {
        const url = new URL(path, base);
        if (token) {
            url.searchParams.set('token', token);
        }
        return url.toString();
    }

    function parseJsonSafely(text, sourceUrl) {
        try {
            return JSON.parse(text);
        } catch (error) {
            throw new Error(`Failed to parse JSON from ${sourceUrl}: ${error.message}`);
        }
    }

    function gmFetchJson(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest is not available.'));
                return;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'Accept': 'application/json'
                },
                anonymous: false,
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`GM_xmlhttpRequest failed: HTTP ${response.status} ${response.statusText || ''} ${url}`.trim()));
                        return;
                    }

                    try {
                        resolve(parseJsonSafely(response.responseText, url));
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: error => {
                    reject(new Error(`GM_xmlhttpRequest network error for ${url}: ${error && error.error ? error.error : 'unknown error'}`));
                },
                ontimeout: () => {
                    reject(new Error(`GM_xmlhttpRequest timeout for ${url}`));
                }
            });
        });
    }

    async function fetchJson(path, token) {
        const sameOriginUrl = buildUrl(path, API_BASE, token);

        try {
            const response = await fetch(sameOriginUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                },
                credentials: 'same-origin',
                mode: 'same-origin'
            });

            if (response.ok) {
                return response.json();
            }

            console.warn(`Same-origin API request failed: HTTP ${response.status} ${response.statusText}`, sameOriginUrl);
        } catch (error) {
            console.warn('Same-origin API request failed, trying GM_xmlhttpRequest fallback.', error);
        }

        const canonicalUrl = buildUrl(path, 'https://civitai.com', token);
        return gmFetchJson(canonicalUrl);
    }

    function findVersionInModelData(modelData, versionId) {
        const versions = Array.isArray(modelData && modelData.modelVersions) ? modelData.modelVersions : [];
        if (!versions.length) return null;
        if (!versionId) return versions[0];
        return versions.find(version => String(version.id) === String(versionId)) || null;
    }

    function mergeVersionData(versionFromModel, versionFromEndpoint) {
        return Object.assign({}, versionFromModel || {}, versionFromEndpoint || {}, {
            files: Array.isArray(versionFromEndpoint && versionFromEndpoint.files) && versionFromEndpoint.files.length
                ? versionFromEndpoint.files
                : Array.isArray(versionFromModel && versionFromModel.files)
                    ? versionFromModel.files
                    : []
        });
    }

    async function resolveModelAndVersionData(token) {
        const modelIdFromUrl = getModelIdFromUrl();
        let versionId = getModelVersionIdFromUrl() || getModelVersionIdFromDomFallback();
        let modelData = null;
        let versionFromModel = null;
        let versionFromEndpoint = null;

        if (modelIdFromUrl) {
            modelData = await fetchJson(`/api/v1/models/${modelIdFromUrl}`, token);
            versionFromModel = findVersionInModelData(modelData, versionId);
            if (!versionId && versionFromModel && versionFromModel.id) {
                versionId = String(versionFromModel.id);
            }
        }

        if (versionId) {
            versionFromEndpoint = await fetchJson(`/api/v1/model-versions/${versionId}`, token);
        }

        if (!modelData && versionFromEndpoint && versionFromEndpoint.modelId) {
            modelData = await fetchJson(`/api/v1/models/${versionFromEndpoint.modelId}`, token);
            versionFromModel = findVersionInModelData(modelData, versionId);
        }

        const versionData = mergeVersionData(versionFromModel, versionFromEndpoint);
        const title = (modelData && modelData.name) || getModelTitleFromDomFallback() || 'civitai_model';
        const versionName = versionData.name || 'version';
        const files = Array.isArray(versionData.files) ? versionData.files : [];

        return { modelData, versionData, title, versionName, versionId, files };
    }

    function appendTokenToDownloadUrl(rawUrl, token) {
        const url = new URL(rawUrl, API_BASE);
        if (token) {
            url.searchParams.set('token', token);
        }
        return url.toString();
    }

    function getFileType(file) {
        const fromFile = file && file.type;
        if (fromFile) return String(fromFile);

        try {
            const url = new URL(file.downloadUrl, API_BASE);
            return url.searchParams.get('type') || '';
        } catch (_error) {
            return '';
        }
    }

    function getFileMetadata(file) {
        return Object.assign({}, file && file.metadata ? file.metadata : {});
    }

    function getExtensionFromFile(file) {
        const fileName = file && file.name ? String(file.name) : '';
        const extensionMatch = fileName.match(/\.([a-zA-Z0-9]+)$/);
        if (extensionMatch) return extensionMatch[1].toLowerCase();

        const metadata = getFileMetadata(file);
        if (metadata.format === 'SafeTensor') return 'safetensors';
        if (metadata.format === 'PickleTensor') return 'ckpt';
        if (metadata.format === 'Other') return 'bin';

        return 'safetensors';
    }

    function buildMetadataSuffix(file) {
        const metadata = getFileMetadata(file);
        const parts = [];

        if (metadata.fp) parts.push(metadata.fp);
        if (metadata.size) parts.push(metadata.size);
        if (metadata.format) parts.push(metadata.format);

        const type = getFileType(file);
        if (type && type !== 'Model') parts.unshift(type);

        return sanitizeFilename(parts.join('_'));
    }

    function buildOutputFilename(file, title, versionName, modelFileCount) {
        const type = getFileType(file);

        if (type && type !== 'Model') {
            return '';
        }

        const extension = getExtensionFromFile(file);
        const base = sanitizeFilename(`${title}_${versionName}`) || 'civitai_model';
        const suffix = modelFileCount > 1 ? buildMetadataSuffix(file) : '';
        const fullBase = suffix ? `${base}_${suffix}` : base;

        return `${fullBase}.${extension}`;
    }

    function fileSortKey(file) {
        const type = getFileType(file);
        const metadata = getFileMetadata(file);
        const typeRank = type === 'Model' ? 0 : type === 'Training' ? 9 : 5;
        const formatRank = metadata.format === 'SafeTensor' ? 0 : metadata.format === 'PickleTensor' ? 5 : 9;
        const fpRank = metadata.fp === 'fp16' ? 0 : metadata.fp === 'fp32' ? 5 : 9;
        const sizeRank = metadata.size === 'pruned' ? 0 : metadata.size === 'full' ? 5 : 9;
        const name = file && file.name ? String(file.name).toLowerCase() : '';
        return `${typeRank}|${formatRank}|${fpRank}|${sizeRank}|${name}`;
    }

    function getDownloadUrlFromFile(file) {
        if (file && file.downloadUrl) return file.downloadUrl;
        if (file && file.id) return `/api/download/models/${file.id}`;
        return '';
    }

    function formatWgetLines(files, title, versionName, token, currentPageUrl) {
        const usableFiles = files
            .filter(file => getDownloadUrlFromFile(file))
            .slice()
            .sort((a, b) => fileSortKey(a).localeCompare(fileSortKey(b)));

        const modelFileCount = usableFiles.filter(file => getFileType(file) === 'Model' || !getFileType(file)).length;

        return usableFiles.map(file => {
            const rawUrl = getDownloadUrlFromFile(file);
            const downloadUrl = appendTokenToDownloadUrl(rawUrl, token);
            const type = getFileType(file);
            const isTraining = type === 'Training' || /[?&]type=Training\b/i.test(rawUrl);
            const filename = buildOutputFilename(file, title, versionName, modelFileCount);
            const outputArg = filename ? ` -O "${shellQuoteDouble(filename)}"` : '';
            const wgetLine = `wget --content-disposition${outputArg} "${shellQuoteDouble(downloadUrl)}"`;
            const comment = `# ${title} # ${versionName} # ${currentPageUrl}`;

            return isTraining ? `# ${wgetLine} ${comment}` : `${wgetLine} ${comment}`;
        }).join('\n');
    }

    async function readClipboardTextSafe() {
        try {
            return await navigator.clipboard.readText();
        } catch (error) {
            console.warn('Could not read clipboard, writing extracted links only.', error);
            return '';
        }
    }

    async function formatAndCopyData() {
        const currentPageUrl = window.location.href;
        const civitaiDownloadToken = GM_getValue('civitai_download_token', null);

        if (!civitaiDownloadToken) {
            alert('Civitai download token missing, go to menu and click to add it.');
            createSplash('red', 'Civitai download token missing.');
            return;
        }

        try {
            const { title, versionName, versionId, files } = await resolveModelAndVersionData(civitaiDownloadToken);

            if (!versionId) {
                alert('Model version ID not found in URL, DOM, or API.');
                createSplash('red', 'Model version ID not found.');
                return;
            }

            if (!files.length) {
                alert('No downloadable files found for this model version.');
                createSplash('red', 'No files found.');
                return;
            }

            const finalStrings = formatWgetLines(files, title, versionName, civitaiDownloadToken, currentPageUrl);
            let clipboardContent = await readClipboardTextSafe();

            if (clipboardContent.length > 0 && !clipboardContent.endsWith('\n')) {
                clipboardContent += '\n';
            }

            GM_setClipboard(clipboardContent + finalStrings);
            createSplash('green', `Extracted ${files.length} file link(s).`);
            console.log('Links have been extracted, converted, and sorted.');
        } catch (error) {
            console.error('Error fetching download data', error);
            createSplash('red', 'Failed to fetch download data. See console.');
        }
    }

    document.addEventListener('keydown', async function(e) {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyX') {
            await formatAndCopyData();
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyZ') {
            clearClipboard();
        }
    });

    function createSplash(color, message) {
        const splash = document.createElement('div');
        splash.style.position = 'fixed';
        splash.style.top = '0';
        splash.style.left = '0';
        splash.style.width = '100%';
        splash.style.height = '100%';
        splash.style.backgroundColor = color;
        splash.style.color = 'white';
        splash.style.display = 'flex';
        splash.style.justifyContent = 'center';
        splash.style.alignItems = 'center';
        splash.style.zIndex = '999999';
        splash.style.fontSize = '24px';
        splash.style.fontWeight = '700';
        splash.textContent = message;
        document.body.appendChild(splash);
        setTimeout(function() {
            splash.remove();
        }, 450);
    }

    function clearClipboard() {
        GM_setClipboard('');
        createSplash('yellow', 'Clipboard cleared.');
        console.log('Clipboard cleared.');
    }

    function setCivitaiToken() {
        const civitaiDownloadToken = prompt('Please enter your Civitai download token:', '');
        if (civitaiDownloadToken != null) {
            GM_setValue('civitai_download_token', civitaiDownloadToken.trim());
            alert('Civitai download token saved securely.');
        }
    }

    GM_registerMenuCommand('Set Civitai download token', setCivitaiToken);
    GM_registerMenuCommand('Extract and Convert Links [CTRL+SHIFT+X]', formatAndCopyData);
    GM_registerMenuCommand('Clear Clipboard [CTRL+SHIFT+Z]', clearClipboard);
})();
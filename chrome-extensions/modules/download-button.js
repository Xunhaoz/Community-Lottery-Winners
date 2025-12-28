function processArticle(article) {
    const responseLabels = ['回應'];
    const shareLabels = ['分享'];
    const downloadCommentLabel = "Download Comments";
    const downloadCommentIconD = `M4 20h16M12 4v12l-5-5m10 0l-5 5`;

    const responseSVG = findSVGByAriaLabels(article, responseLabels);
    const shareSVG = findSVGByAriaLabels(article, shareLabels);

    if (!responseSVG || !shareSVG) {
        return;
    }

    const existingDownload = findSVGByAriaLabel(article, 'Download Comments');
    if (existingDownload) {
        return;
    }

    let shareParent = shareSVG.parentElement;
    if (!shareParent) {
        return;
    }

    const clonedButton = shareParent.cloneNode(true);

    const svg = clonedButton.querySelector('svg');
    replaceSVG(svg, downloadCommentLabel, downloadCommentIconD);
    
    // 添加點擊事件監聽器
    clonedButton.addEventListener('click', handleDownloadClick);
    
    shareParent.parentNode.appendChild(clonedButton);
}

function observeArticles() {
    const observer = new MutationObserver(function (mutations) {
        const articles = document.querySelectorAll('article');
        articles.forEach(article => {
            processArticle(article);
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function initDownloadButton() {
    const articles = document.querySelectorAll('article');
    articles.forEach(article => {
        processArticle(article);
    });

    observeArticles();
}

function watchUrlChanges() {
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            setTimeout(() => {
                const articles = document.querySelectorAll('article');
                articles.forEach(article => {
                    processArticle(article);
                });
            }, 1000);
        }
    }).observe(document, { subtree: true, childList: true });
}

/**
 * 向上查找直到找到 article 標籤
 * @param {HTMLElement} element - 起始元素
 * @returns {HTMLElement|null} 找到的 article 元素或 null
 */
function findParentArticle(element) {
    let current = element;
    while (current && current !== document.body) {
        if (current.tagName === 'ARTICLE') {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

/**
 * 在 article 中查找以 /p/ 開頭的連結並提取 shortcode
 * @param {HTMLElement} article - article 元素
 * @returns {string|null} shortcode 或 null
 */
function extractShortcode(article) {
    const links = article.querySelectorAll('a[href]');
    for (const link of links) {
        const href = link.getAttribute('href');
        if (href && href.startsWith('/p/')) {
            // 提取 shortcode，例如 /p/DSYcV7ljazH/ -> DSYcV7ljazH
            const match = href.match(/^\/p\/([^\/]+)\//);
            if (match && match[1]) {
                return match[1];
            }
        }
    }
    return null;
}

/**
 * 下載 JSON 檔案
 * @param {Object} data - 要下載的資料
 * @param {string} filename - 檔案名稱
 */
function downloadJSON(data, filename) {
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 處理下載按鈕點擊事件
 * @param {Event} event - 點擊事件
 */
async function handleDownloadClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const article = findParentArticle(event.currentTarget);
    if (!article) {
        console.error('無法找到 article 標籤');
        return;
    }

    const shortcode = extractShortcode(article);
    if (!shortcode) {
        console.error('無法提取 shortcode');
        return;
    }

    console.log(shortcode);

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'GET_REQUEST_HEADERS'
        });

        if (response && response.success && response.data) {
            const downloadData = {
                'shortcode': shortcode,
                'request_headers_store': response.data
            };

            const filename = `instagram_${shortcode}_headers.json`;
            downloadJSON(downloadData, filename);
        } else {
            console.error('無法獲取 requestHeadersStore');
        }
    } catch (error) {
        console.error('發送消息到 background script 時發生錯誤:', error);
    }
}


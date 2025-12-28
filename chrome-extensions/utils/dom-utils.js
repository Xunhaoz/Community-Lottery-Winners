/**
 * DOM 工具函數
 */

/**
 * 根據 aria-label 查找 SVG 元素
 * @param {HTMLElement} container - 容器元素
 * @param {string} label - aria-label 值
 * @returns {SVGElement|null} 找到的 SVG 元素或 null
 */
function findSVGByAriaLabel(container, label) {
    const svgs = container.querySelectorAll('svg[aria-label]');
    for (const svg of svgs) {
        if (svg.getAttribute('aria-label') === label) {
            return svg;
        }
    }
    return null;
}

/**
 * 根據多個 aria-label 查找 SVG 元素（支援多語系）
 * @param {HTMLElement} container - 容器元素
 * @param {Array<string>|string} labels - aria-label 值陣列或單一字串
 * @returns {SVGElement|null} 找到的 SVG 元素或 null
 */
function findSVGByAriaLabels(container, labels) {
    if (!Array.isArray(labels)) {
        labels = [labels]; // 如果傳入單一字串，轉為陣列
    }
    const svgs = container.querySelectorAll('svg[aria-label]');
    for (const svg of svgs) {
        const ariaLabel = svg.getAttribute('aria-label');
        if (labels.includes(ariaLabel)) {
            return svg;
        }
    }
    return null;
}

/**
 * 複製 DOM 元素
 * @param {HTMLElement} element - 要複製的元素
 * @returns {HTMLElement} 複製的元素
 */
function cloneElement(element) {
    return element.cloneNode(true);
}

/**
 * 替換 SVG 元素的內容
 * @param {SVGElement} svgElement - SVG 元素
 * @param {string} label - 新的 aria-label
 * @param {string} iconD - 新的 path d 屬性值
 */
function replaceSVG(svgElement, label, iconD) {
    const children = Array.from(svgElement.childNodes);
    children.forEach(child => {
        if (child.nodeName !== 'title' && child.nodeName !== 'path') {
            child.remove();
        }
    });

    svgElement.setAttribute('aria-label', label);

    let titleElement = svgElement.querySelector('title');
    if (titleElement) {
        titleElement.textContent = label;
    }

    let pathElement = svgElement.querySelector('path');
    if (pathElement) {
        pathElement.setAttribute('d', iconD);
    }
}


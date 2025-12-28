function init() {
    if (typeof initDownloadButton === 'function') {
        initDownloadButton();
    }

    if (typeof watchUrlChanges === 'function') {
        watchUrlChanges();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

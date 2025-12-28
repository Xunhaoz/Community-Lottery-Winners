let requestHeadersStore = null;


chrome.webRequest.onBeforeSendHeaders.addListener(
    function (details) {
        if (details.url.includes('www.instagram.com/graphql/query')) {
            // 將所有 headers 轉換為普通對象，以便可以序列化為 JSON
            requestHeadersStore = {};
            details.requestHeaders.forEach(header => {
                requestHeadersStore[header.name] = header.value;
            });
            console.log(requestHeadersStore);
        }
    },
    {
        urls: ["https://www.instagram.com/*"],
        types: ["xmlhttprequest", "main_frame", "sub_frame"]
    },
    ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_REQUEST_HEADERS') {
        sendResponse({
            success: true,
            data: requestHeadersStore
        });
        return true;
    }
});

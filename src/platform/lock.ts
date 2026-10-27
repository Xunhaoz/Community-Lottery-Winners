// Every page that writes to IndexedDB shares this lock with the capture loop.
export async function exclusive<T>(action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(
    "community-lottery-writer",
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw new Error(
          "另一個工作分頁正在處理資料。請回原分頁暫停或等待完成。",
        );
      return action();
    },
  );
}

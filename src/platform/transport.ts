export type InstagramQuery =
  { docId: string; name: string } | { queryHash: string };
// Serialized by chrome.scripting; keep this function self-contained and never return credentials.
export async function fetchInInstagram(
  query: InstagramQuery,
  variables: Record<string, unknown>,
  shortcode: string,
) {
  const onPost = () =>
    location.origin === "https://www.instagram.com" &&
    location.pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/)?.[1] ===
      shortcode;
  if (!onPost()) return { error: "source" };
  try {
    const common = {
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    } as const;
    let response: Response;
    if ("queryHash" in query) {
      // Legacy flat comment list. The CSRF cookie stays inside the source page for this one request.
      const csrf =
        document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] ?? "";
      if (!csrf) return { error: "login" };
      const params = new URLSearchParams({
        query_hash: query.queryHash,
        variables: JSON.stringify(variables),
      });
      response = await fetch(`/graphql/query/?${params}`, {
        ...common,
        method: "GET",
        headers: { Accept: "application/json", "X-CSRFToken": csrf },
      });
    } else {
      // Tokens stay inside the source page for this one request. Never return or persist them.
      const igWindow = window as unknown as {
        require?: (name: string) => { token?: string };
      };
      const token = (module: string, input: string) => {
        try {
          return (
            igWindow.require?.(module)?.token ??
            document.querySelector<HTMLInputElement>(`input[name="${input}"]`)
              ?.value ??
            ""
          );
        } catch {
          return "";
        }
      };
      const dtsg = token("DTSGInitialData", "fb_dtsg"),
        lsd = token("LSD", "lsd");
      if (!dtsg) return { error: "login" };
      const body = new URLSearchParams({
        doc_id: query.docId,
        fb_api_req_friendly_name: query.name,
        fb_api_caller_class: "RelayModern",
        variables: JSON.stringify(variables),
        server_timestamps: "true",
        fb_dtsg: dtsg,
      });
      if (lsd) body.set("lsd", lsd);
      response = await fetch("/api/graphql", {
        ...common,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-FB-Friendly-Name": query.name,
          ...(lsd ? { "X-FB-LSD": lsd } : {}),
        },
        body: body.toString(),
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!onPost()) return { error: "source" };
    if (
      !/^(?:application\/(?:[\w.+-]*\+)?json|(?:text|application)\/javascript)(?:;|$)/i.test(
        contentType,
      )
    )
      return { status: response.status, contentType, body: null };
    let data: unknown;
    try {
      // Instagram serves JSON with text/javascript. Parse data; never execute it.
      data = await response.json();
    } catch {
      return { error: "schema" };
    }
    if (!onPost()) return { error: "source" };
    return { status: response.status, contentType, body: data };
  } catch {
    return { error: "network" };
  }
}

import { ProxyAgent, setGlobalDispatcher } from "undici";

function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? "redacted" : "";
      url.password = url.password ? "redacted" : "";
    }
    return url.toString();
  } catch {
    return "<configured>";
  }
}

/**
 * Route Node's global `fetch` egress through a forward proxy (e.g. the iron.sh
 * egress firewall) when one of the standard proxy env vars is set. No-op when
 * unset.
 */
export function installProxyFromEnv(): void {
  const url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!url) return;

  setGlobalDispatcher(new ProxyAgent(url));
  console.log("[proxy] routing HTTP egress through " + redactProxyUrl(url));
}

import { ProxyAgent, setGlobalDispatcher } from "undici";

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
  console.log("[proxy] routing HTTP egress through " + url);
}

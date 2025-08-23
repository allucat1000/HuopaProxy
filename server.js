// --- Imports ---
let express, cheerio;
let fetchFn = globalThis.fetch;

try {
  // Node environment
  express = (await import("express")).default;
  fetchFn = (await import("node-fetch")).default;
  cheerio = await import("cheerio");
} catch {
  // Deno Deploy environment
  cheerio = await import("https://esm.sh/cheerio@1.1.2");
}

const SERVER_URL = "http://localhost:3000/proxy";

// --- Helpers ---
function escapeHtml(str = "") {
  return str.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function rewriteUrl(baseServerUrl, targetUrl) {
  try {
    if (!targetUrl || targetUrl.startsWith("data:") || targetUrl.startsWith("javascript:")) {
      return targetUrl;
    }
    const resolved = new URL(targetUrl, new URL(targetUrl).origin).href;
    const proxied = new URL(baseServerUrl);
    proxied.searchParams.append("url", resolved);
    return proxied.href;
  } catch (e) {
    console.error("proxify failed for", targetUrl, e.message);
    return targetUrl;
  }
}

// --- Core proxy logic ---
async function handleProxyCore(targetUrl, method, headers, body) {
  if (!targetUrl) {
    return new Response(
      `<h1>Missing ?url parameter!</h1>`,
      { status: 400, headers: { "content-type": "text/html" } }
    );
  }

  try {
    // Clean headers
    const h = new Headers(headers);
    h.delete("host");
    h.delete("sec-fetch-site");
    h.delete("sec-fetch-mode");
    h.delete("sec-fetch-dest");

    const response = await fetchFn(targetUrl, {
      method,
      headers: h,
      body: ["GET", "HEAD"].includes(method) ? undefined : body,
      redirect: "manual",
    });

    const ct = response.headers.get("content-type") || "";
    const newHeaders = { "content-type": ct };

    // HTML rewriting
    if (ct.includes("text/html")) {
      let html = await response.text();
      const $ = cheerio.load(html);
      const pageOrigin = new URL(targetUrl).origin;
      $("head").prepend(`<base href="${pageOrigin}/">\n`);

      // Rewrite src/href attributes
      const attrMap = {
        a: "href", link: "href", img: "src", script: "src",
        iframe: "src", frame: "src", embed: "src", object: "data",
        source: "src", track: "src", audio: "src", video: "src",
        form: "action", area: "href",
      };
      for (const [tag, attr] of Object.entries(attrMap)) {
        $(tag).each((_, el) => {
          let val = $(el).attr(attr);
          if (val && !val.startsWith("data:") && !val.startsWith("javascript:")) {
            $(el).attr(attr, rewriteUrl(SERVER_URL, new URL(val, targetUrl).href));
          }
        });
      }

      // Rewrite srcset
      $("img, source").each((_, el) => {
        let srcset = $(el).attr("srcset");
        if (srcset) {
          let rewritten = srcset.split(",").map(entry => {
            let [url, size] = entry.trim().split(/\s+/, 2);
            return rewriteUrl(SERVER_URL, url) + (size ? " " + size : "");
          }).join(", ");
          $(el).attr("srcset", rewritten);
        }
      });

      // Inject proxify script
      $("body").append(`<script>
        (function() {
          const server = new URL(${JSON.stringify(SERVER_URL)});
          const pageBase = new URL(${JSON.stringify(targetUrl)});
          function deproxify(u) {
            try {
              const abs = new URL(u, pageBase);
              if (abs.origin === server.origin && abs.pathname === server.pathname) {
                return abs.searchParams.get("url") || abs.href;
              }
              return abs.href;
            } catch(e) { return u; }
          }
          function proxify(u) {
            const resolved = new URL(deproxify(u), pageBase).href;
            const p = new URL(server.href);
            p.searchParams.set("url", resolved);
            return p.href;
          }
          // Patch fetch
          const origFetch = window.fetch;
          window.fetch = (input, init) => {
            if (typeof input === "string") input = proxify(input);
            return origFetch(input, init);
          };
          // Patch XHR
          const origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(m, u) {
            arguments[1] = proxify(u);
            return origOpen.apply(this, arguments);
          };
          // Patch WebSocket
          const OrigWS = window.WebSocket;
          window.WebSocket = function(u,p) { return new OrigWS(proxify(u),p); };
          window.WebSocket.prototype = OrigWS.prototype;
        })();
      </script>`);

      return new Response($.html(), { status: 200, headers: newHeaders });
    }

    // CSS url() rewriting
    if (ct.includes("text/css")) {
      let css = await response.text();
      css = css.replace(/url\((.*?)\)/g, (_, u) => {
        let clean = u.replace(/['"]/g, "").trim();
        if (clean.startsWith("data:")) return `url(${u})`;
        return `url(${rewriteUrl(SERVER_URL, new URL(clean, targetUrl).href)})`;
      });
      return new Response(css, { status: 200, headers: newHeaders });
    }

    // Other text
    if (ct.startsWith("text/")) {
      return new Response(await response.text(), { status: 200, headers: newHeaders });
    }

    // Binary
    return new Response(await response.arrayBuffer(), { status: 200, headers: newHeaders });

  } catch (err) {
    return new Response(
      `<h1>Failed to fetch url: ${escapeHtml(targetUrl)}</h1><pre>${escapeHtml(err.message)}</pre>`,
      { status: 500, headers: { "content-type": "text/html" } }
    );
  }
}

// --- Express (Node) ---
if (express) {
  const app = express();
  app.use(express.raw({ type: "*/*" }));

  app.all("/proxy", async (req, res) => {
    const resp = await handleProxyCore(req.query.url, req.method, req.headers, req.body);
    res.status(resp.status);
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    res.send(await resp.text());
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
}

// --- Deno Deploy ---
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve((req) => {
    const { searchParams } = new URL(req.url);
    return handleProxyCore(searchParams.get("url"), req.method, req.headers, req.body);
  });
}

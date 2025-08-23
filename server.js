import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const serverUrl = "https://huopaproxy.onrender.com/proxy";
const app = express();
let internalErrorHtml = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Internal Server Error!</title>
      <style type="text/css">
          body{
              font-family: sans-serif;
              text-align: center;
              overflow-wrap: anywhere;
          }
          h1{
              margin: 1em;
              margin-top: 0.5em;
              font-size: 2.5em;
          }
          h2{
              max-width: 95%;
              margin: 1em auto;
          }
          h3{
              margin: 1em;
              font-size: 1.5em;
              background-color: rgba(0, 0, 0, 0.1);
              padding: 1em;
              border-radius: 1em;
          }
      </style>
  </head>
  <body>
      <h3>Huopa Web Proxy</h3>
      <h1>Internal Server Error!1!!</h1>
  </body>
  </html>
`;


app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use((err, req, res, next) => {
    if (err) {
      console.error("Internal error:", err);
      res.status(500).send(internalErrorHtml);
      return;
  }
})

function rewriteUrl(baseServerUrl, targetUrl) {
  try {
    if (!targetUrl || targetUrl.startsWith("data:") || targetUrl.startsWith("javascript:")) {
      return targetUrl;
    }
    const baseUrl = new URL(targetUrl).origin;
    const resolved = new URL(targetUrl, baseUrl).href;
    const proxied = new URL(baseServerUrl);
    proxied.searchParams.append("url", resolved);
    return proxied.href;
  } catch (e) {
    console.error("proxify failed for", targetUrl, e.message);
    return targetUrl;
  }
}

async function handleProxy(req, res, method) {
  const targetUrl = req.query.url;

  let missingUrlHtml = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Missing Url!</title>
      <style type="text/css">
          body{
              font-family: sans-serif;
              text-align: center;
              overflow-wrap: anywhere;
          }
          h1{
              margin: 1em;
              margin-top: 0.5em;
              font-size: 2.5em;
          }
          h2{
              max-width: 95%;
              margin: 1em auto;
          }
          h3{
              margin: 1em;
              font-size: 1.5em;
              background-color: rgba(0, 0, 0, 0.1);
              padding: 1em;
              border-radius: 1em;
          }
      </style>
  </head>
  <body>
      <h3>Huopa Web Proxy</h3>
      <h1>Missing base url parameter in request!</h1>
      <h2>Request parameters: ${escapeHtml(JSON.stringify(req.query)) || "Unknown"}</h2>
  </body>
  </html>
  `
  if (!targetUrl) return res.status(400).send(missingUrlHtml);

  try {
    const targetOrigin = new URL(targetUrl).origin;

    const headers = { ...req.headers };
    delete headers.host;
    headers.origin = targetOrigin;
    delete headers['sec-fetch-site'];
    delete headers['sec-fetch-mode'];
    delete headers['sec-fetch-dest'];
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...';
    headers['referer'] = req.query.url || '';
    if (req.headers.cookie) {
      headers.cookie = req.headers.cookie;
    }
    let fetchOptions = { method, headers, redirect: "manual" };
    fetchOptions.headers["accept-encoding"] = fetchOptions.headers["accept-encoding"].replace(", br, zstd", "");
    if (method !== "GET" && method !== "HEAD") {
      fetchOptions.body = req.bodyRaw || req;
    }
    const response = await fetch(targetUrl, fetchOptions);

    const setCookies = response.headers.raw()['set-cookie'];
    if (setCookies) {
      res.setHeader('Set-Cookie', setCookies);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const resolved = new URL(location, targetUrl).href;
        res.send(`
          <!DOCTYPE html>
          <html><head><meta charset="utf-8"></head>
          <body>
            <script>
              if (window.top && window.top.loadPage) {
                window.top.loadPage(${JSON.stringify(resolved)});
              } else {
                document.write("Redirect failed: parent loader not found");
              }
            </script>
          </body></html>
        `);
        return;
      }
    }

    let contentType = response.headers.get("content-type") || "";
    res.set("content-type", contentType);
    if (contentType.includes("text/html")) {
      let body = await response.text();
      const $ = cheerio.load(body);
      const pageOrigin = new URL(targetUrl).origin;
      const baseTag = `<base href="${pageOrigin}/">`;
      $("head").prepend(baseTag + "\n");
      const attrMap = {
        a: "href",
        link: "href",
        img: "src",
        script: "src",
        iframe: "src",
        frame: "src",
        embed: "src",
        object: "data",
        source: "src",
        track: "src",
        audio: "src",
        video: "src",
        form: "action",
        area: "href",
      };

      for (const [tag, attr] of Object.entries(attrMap)) {
        $(tag).each((_, el) => {
          let val = $(el).attr(attr);
          if (val && !val.startsWith("data:") && !val.startsWith("javascript:")) {
            $(el).attr(attr, rewriteUrl(serverUrl, new URL(val, targetUrl).href));
          }
        });
      }

      $("img, source").each((_, el) => {
        let srcset = $(el).attr("srcset");
        if (srcset) {
          let rewritten = srcset
            .split(",")
            .map(entry => {
              let [url, size] = entry.trim().split(/\s+/, 2);
              return rewriteUrl(serverUrl, url) + (size ? " " + size : "");
            })
            .join(", ");
          $(el).attr("srcset", rewritten);
        }
      });

$("body").append(`
  <script>
  (function() {
    const server = new URL(${JSON.stringify(serverUrl)});
    const pageBase = new URL(${JSON.stringify(targetUrl)});

    function deproxify(u) {
      try {
        const abs = new URL(u, pageBase);
        if (abs.origin === server.origin && abs.pathname === server.pathname) {
          const inner = abs.searchParams.get("url");
          return inner || abs.href;
        }
        return abs.href;
      } catch(e) { return u; }
    }

    // Wrap URL for proxying
    function proxify(u) {
      const resolved = new URL(deproxify(u), pageBase).href;
      const p = new URL(server.href);
      p.searchParams.set("url", resolved);
      return p.href;
    }

    // Patch fetch
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      if (typeof input === "string") input = proxify(input);
      else if (input instanceof Request) {
        const newReq = new Request(proxify(input.url), {
          method: input.method,
          headers: input.headers,
          body: input.body,
          mode: input.mode,
          credentials: input.credentials,
          cache: input.cache,
          redirect: input.redirect,
          referrer: input.referrer,
          integrity: input.integrity,
        });
        input = newReq;
      }
      return origFetch(input, init);
    };

    // Patch XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      arguments[1] = proxify(url);
      return origOpen.apply(this, arguments);
    };

    // Patch WebSocket
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      return new OrigWebSocket(proxify(url), protocols);
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;

    // Safe location overrides
    try {
      Object.defineProperty(top, "location", {
        configurable: true,
        enumerable: true,
        get() { return top.location; },
        set(url) { top.location.href = proxify(url); }
      });
    } catch(e) {}

    try {
      Object.defineProperty(window, "location", {
        configurable: true,
        enumerable: true,
        get() { return window.location; },
        set(url) { window.location.assign(proxify(url)); }
      });
    } catch(e) {}

  })();
  </script>
  `);

  res.send($.html());
} else if (contentType.includes("text/css")) {
      let body = await response.text();
      body = body.replace(/url\((.*?)\)/g, (_, url) => {
        let clean = url.replace(/['"]/g, "").trim();
        if (clean.startsWith("data:")) return `url(${url})`;
        return `url(${rewriteUrl(serverUrl, new URL(clean, targetUrl).href)})`;
      });
      res.send(body);
    } else if (contentType.includes("text/")) {
      const body = await response.text();
      res.send(body);
    } else {
      // Binary (images, PDFs, etc.)
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err) {
    console.error("Error fetching " + targetUrl + ": " + err)

    let failFetchErrorHtml = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Url fetch fail!</title>
          <style type="text/css">
              body{
                  font-family: sans-serif;
                  text-align: center;
                  overflow-wrap: anywhere;
              }
              h1{
                  margin: 1em;
                  margin-top: 0.5em;
                  font-size: 2.5em;
              }
              h2{
                  max-width: 95%;
                  margin: 1em auto;
              }
              h3{
                  margin: 1em;
                  font-size: 1.5em;
                  background-color: rgba(0, 0, 0, 0.1);
                  padding: 1em;
                  border-radius: 1em;
              }
          </style>
      </head>
      <body>
          <h3>Huopa Web Proxy</h3>
          <h1>Failed to fetch url: ${escapeHtml(JSON.stringify(targetUrl))}</h1>
      </body>
      </html>
    `;
    res.status(500).send(failFetchErrorHtml);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}

app.use((req, res, next) => {
  let data = [];
  req.on("data", chunk => data.push(chunk));
  req.on("end", () => {
    req.bodyRaw = Buffer.concat(data);
    next();
  });
});

app.get("/proxy", (req, res) => handleProxy(req, res, "GET"));
app.post("/proxy", (req, res) => handleProxy(req, res, "POST"));

app.listen(3000, () => console.log("Proxy running on: " + serverUrl));

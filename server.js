import express from "npm:express";
import * as cheerio from "npm:cheerio";
import { Buffer } from "node:buffer";
import rateLimit from 'npm:express-rate-limit';
import { CookieJar } from "npm:tough-cookie";
import { init, parse } from "npm:es-module-lexer";
import fetchCookie from "npm:fetch-cookie";
import * as acorn from "npm:acorn";
import * as walk from "npm:acorn-walk";

import process from "node:process"

const disabled = Deno.env.get("disabled") || false;
const blockedIps = (Deno.env.get("blockedIps") || "").split(",");
const noRatelimitIps = (Deno.env.get("noRatelimitIps") || "").split(",");

const serverUrl = "https://allucat1000-huopaproxy-29.deno.dev/proxy";
const app = express();

const sessions = new Map();

const kv = await Deno.openKv();

await loadSessions();

async function saveSessions() {
    for (const [sid, jar] of sessions.entries()) {
        await kv.set(["cookies", sid], jar.toJSON());
    }
}

async function loadSessions() {
    for await (const entry of kv.list({ prefix: ["cookies"] })) {
        sessions.set(entry.key[1], CookieJar.fromJSON(entry.value));
    }
}

function getOrCreateSession(req) {
    // Check if cookie exists already
    const ip = req.ip;

    if (!sessions.has(ip)) {
        sessions.set(ip, new CookieJar());
    }
    return sessions.get(ip);
}

process.on("SIGINT", () => {
  console.log("\n[Saving sessions]");
  saveSessions();
  process.exit();
});

const internalErrorHtml = `
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
        <link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&amp;display=swap" rel="stylesheet">
        <style type="text/css">
            body, html {
                font-family: "Roboto Flex", sans-serif;
                text-align: left;
                overflow-wrap: anywhere;
                background-color: rgba(30, 30, 30);
                color: rgba(220, 220, 220);
                margin: 0;
                padding: 0;
            }
            h1 {
                margin: 1em;
            }
            h2{
                margin: 1em;
            }
            h3 {
                margin: 1em 1.66em;
                padding-bottom: 1em;
            }
            a {
                text-decoration: none;
                color: black;
                padding: 0.75em 1.5em;
                border-radius: 1.33em;
                border-style: none;
                background-color: #42c3ed;
                cursor: pointer;
                margin: 2.25em;
            }
        </style>
    </head>
    <body>  
        <h1>Internal Server Error!</h1>
        <h3>The proxy server has errored.</h3>
    </body>
</html>
`;


const limiter = rateLimit({
    skip: (req) => noRatelimitIps.includes(req.ip),
	windowMs: 60 * 1000,
	max: 500,
	standardHeaders: 'draft-8',
	legacyHeaders: false,
	ipv6Subnet: 64,
})

app.use(limiter)

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  } else {
    res.header("Access-Control-Allow-Origin", "*");
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  const requestedHeaders = (req.headers['access-control-request-headers'] || "")
    .split(",")
    .map(h => h.trim())
    .filter(h => h.length > 0)
    .filter(h => ![
      "host", 
      "connection", 
      "content-length", 
      "cookie", 
      "cookie2", 
      "set-cookie", 
      "set-cookie2", 
      "upgrade"
    ].includes(h.toLowerCase()));

  if (requestedHeaders.length) {
    res.header("Access-Control-Allow-Headers", requestedHeaders.join(", "));
  }

  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use((err, _req, res, _next) => {
    if (err) {
      console.error("Internal error:", err);
      res.status(500).send(internalErrorHtml);
      return;
    }
})

function rewriteUrl(baseServerUrl, targetUrl) {
  try {
    if (!targetUrl || targetUrl.startsWith("data:") || targetUrl.startsWith("javascript:") || targetUrl.startsWith("wss:") || targetUrl.startsWith("ws:")) {
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

// (JS imports)
await init;

function patchImports(code, serverUrl, targetUrl) {
    const [imports] = parse(code);
    let patched = '';
    let lastIndex = 0;

    for (const imp of imports) {
        const specifier = code.slice(imp.s, imp.e);

        let noQuotes = specifier;
        if ((specifier.startsWith('"') && specifier.endsWith('"')) ||
            (specifier.startsWith("'") && specifier.endsWith("'"))) {
            noQuotes = specifier.slice(1, -1);
        }

        if (
            noQuotes === 'import.meta.url' ||
            noQuotes === 'import.meta' ||
            noQuotes.startsWith('data:') ||
            noQuotes.startsWith('blob:') ||
            noQuotes.startsWith('javascript:')
        ) {
            patched += code.slice(lastIndex, imp.e);
            lastIndex = imp.e;
            continue;
        }

        const abs = new URL(noQuotes, targetUrl).href;
        const proxied = `${serverUrl}?url=${encodeURIComponent(abs)}`;

        const dynamic = code.slice(imp.s - 7, imp.s).trim().startsWith('import(');
        const replacement = dynamic ? JSON.stringify(proxied) : proxied;

        patched += code.slice(lastIndex, imp.s) + replacement;
        lastIndex = imp.e;
    }

    patched += code.slice(lastIndex);
    return patched;
}

// Window location stuff

function replaceLocation(code, targetUrl) {
    const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script" });
    const replacements = [];

    const targetOrigin = new URL(targetUrl).origin;

    walk.ancestor(ast, {
        MemberExpression(node, ancestors) {
            if (
                node.object?.type === "MemberExpression" &&
                node.object.object?.type === "Identifier" &&
                node.object.object.name === "window" &&
                node.object.property?.type === "Identifier" &&
                node.object.property.name === "location" &&
                node.property?.type === "Identifier"
            ) {
                const parent = ancestors[ancestors.length - 2];
                const isLHS =
                    (parent.type === "AssignmentExpression" && parent.left === node) ||
                    (parent.type === "UpdateExpression" && parent.argument === node);

                if (isLHS) return;

                if (node.property.name === "href") {
                    replacements.push({ start: node.start, end: node.end, value: JSON.stringify(targetUrl) });
                }
                if (node.property.name === "origin") {
                    replacements.push({ start: node.start, end: node.end, value: JSON.stringify(targetOrigin) });
                }
            }
        }
    });

    let patched = code;
    replacements.sort((a, b) => b.start - a.start).forEach(r => {
        patched = patched.slice(0, r.start) + r.value + patched.slice(r.end);
    });

    return patched;
}

async function handleProxy(req, res, method) {
  if (disabled) return res.status(403).send("The server is manually disabled.");
  if (blockedIps.includes(req.ip)) return res.status(403).send("Your IP address has been blocked.");
  const targetUrl = req.query.url;

  const missingUrlHtml = `
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
        <link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&amp;display=swap" rel="stylesheet">
        <style type="text/css">
            body, html {
                font-family: "Roboto Flex", sans-serif;
                text-align: left;
                overflow-wrap: anywhere;
                background-color: rgba(30, 30, 30);
                color: rgba(220, 220, 220);
                margin: 0;
                padding: 0;
            }
            h1 {
                margin: 1em;
            }
            h2{
                margin: 1em 1.33em;
            }
            h3 {
                margin: 1em 1.66em;
                padding-bottom: 1em;
            }
            a {
                text-decoration: none;
                color: black;
                padding: 0.75em 1.5em;
                border-radius: 1.33em;
                border-style: none;
                background-color: #42c3ed;
                cursor: pointer;
                margin: 2.25em;
            }
        </style>
    </head>
    <body>  
        <h1>Missing base url parameter in request!</h1>
        <h2>Request parameters: ${escapeHtml(JSON.stringify(req.query)) || "Unknown"}</h2>
    </body>
</html>
  `
    if (!targetUrl) return res.status(400).send(missingUrlHtml);

    //try {
        if (targetUrl.startsWith("file://")) return res.status(404).send("Unable to access local file!");

        const targetOrigin = new URL(targetUrl).origin;

        const headers = { ...req.headers };

        // Remove headers that cause issues
        delete headers.host;
        delete headers['sec-fetch-site'];
        delete headers['sec-fetch-mode'];
        delete headers['sec-fetch-dest'];

        headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.3';
        headers['referer'] = req.query.url || '';
        headers['sec-ch-ua-platform'] = 'Windows';
        headers['sec-ch-ua'] = '"Chromium";v="134", "Not;A=Brand";v="99"'

        if (req.headers.cookie) headers.cookie = req.headers.cookie;

        if (headers['accept-encoding']) {
            headers['accept-encoding'] = headers['accept-encoding']
                .split(',')
                .map(enc => enc.trim())
                .filter(enc => !['br', 'zstd'].includes(enc.toLowerCase()))
                .join(', ');
        }
        headers.origin = targetOrigin;

        const fetchOptions = { method, headers, redirect: 'manual' };
        if (method !== 'GET' && method !== 'HEAD') {
            fetchOptions.body = req.bodyRaw || req;
        }

        console.log(`[${method}] ${req.ip} ${targetUrl}`);
        const jar = getOrCreateSession(req);
        const cookieFetch = fetchCookie(fetch, jar);

        const response = await cookieFetch(targetUrl, fetchOptions);

        const cookies = await jar.getCookies(targetUrl);
        if (cookies.length) {
            res.setHeader(
                "Set-Cookie",
                cookies.map(c => c.cookieString({ includeHttpOnly: true }))
            );
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
                if (window.parent && window.parent.loadPage) {
                    window.parent.loadPage(${JSON.stringify(resolved)});
                } else {
                    document.write("Redirect failed: parent loader not found");
                }
                </script>
            </body></html>
            `);
            return;
        }
        }

        const contentType = response.headers.get("content-type") || "";
        res.set("content-type", contentType);
        if (contentType.includes("text/html")) {
            const body = await response.text();
            const $ = cheerio.load(body);
            const pageBase = new URL(targetUrl)
            const baseTag = `<base href="${pageBase.href.endsWith("/") ? pageBase.href.slice(0, -1) : pageBase.href}/">`;
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
                const val = $(el).attr(attr);
                if (val && !val.startsWith("data:") && !val.startsWith("javascript:")) {
                    $(el).attr(attr, rewriteUrl(serverUrl, new URL(val, targetUrl).href));
                }
                });
            }
            $("style").each((_, el) => {
                let css = $(el).html();
                if (css) {
                    css = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, _quote, url) => {
                    const clean = url.trim();
                        if (clean.startsWith("data:")) return `url(${url})`;
                        return `url(${rewriteUrl(serverUrl, new URL(clean, targetUrl).href)})`;
                    });
                    $(el).html(css);
                }
            });

            // JS imports and location in script tags

            $("[style]").each((_, el) => {
                let css = $(el).attr("style");
                if (css) {
                    css = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, _quote, url) => {
                        const clean = url.trim();
                        if (clean.startsWith("data:")) return `url(${url})`;
                        return `url(${rewriteUrl(serverUrl, new URL(clean, targetUrl).href)})`;
                    });
                    $(el).attr("style", css);
                }
            });


            $("img, source").each((_, el) => {
                const srcset = $(el).attr("srcset");
                if (srcset) {
                const rewritten = srcset
                    .split(",")
                    .map(entry => {
                    const [url, size] = entry.trim().split(/\s+/, 2);
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

				function proxify(u) {
					const resolved = new URL(deproxify(u), pageBase).href;
					const p = new URL(server.href);
					p.searchParams.set("url", resolved);
					return p.href;
				}

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
        } else if (/\b(javascript|ecmascript|module)\b/i.test(contentType)) {
            const body = await response.text();
            
            // Imports
            let code = patchImports(body, serverUrl, targetUrl)
			code = replaceLocation(code, targetUrl);
            res.send(code);

        } else if (contentType.includes("text/css")) {
            let body = await response.text();
            body = body.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, _quote, url) => {
                const clean = url.trim();
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
    /*} catch (err) {
        console.error("Error fetching " + targetUrl + ": " + err)

        const failFetchErrorHtml = `
<html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
        <link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&amp;display=swap" rel="stylesheet">
        <style type="text/css">
            body, html {
                font-family: "Roboto Flex", sans-serif;
                text-align: left;
                overflow-wrap: anywhere;
                background-color: rgba(30, 30, 30);
                color: rgba(220, 220, 220);
                margin: 0;
                padding: 0;
            }
            h1 {
                margin: 1em;
            }
            h2{
                margin: 1em;
            }
            h3 {
                margin: 1em 1.66em;
                padding-bottom: 1em;
            }
            a {
                text-decoration: none;
                color: black;
                padding: 0.75em 1.5em;
                border-radius: 1.33em;
                border-style: none;
                background-color: #42c3ed;
                cursor: pointer;
                margin: 2.25em;
            }
        </style>
    </head>
    <body>  
        <h1>Unable to load the requested site!</h1>
        <h3>The proxy encountered an error fetching the requested URL.</h3>
        <a href=${JSON.stringify(targetUrl)}>Reload</a>
    </body>
</html>
        `;
        res.status(500).send(failFetchErrorHtml);
    }*/
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}

app.use((req, _res, next) => {
  const data = [];
  req.on("data", chunk => data.push(chunk));
  req.on("end", () => {
    req.bodyRaw = Buffer.concat(data);
    next();
  });
});

app.get("/proxy", (req, res) => handleProxy(req, res, "GET"));
app.post("/proxy", (req, res) => handleProxy(req, res, "POST"));

app.listen(3000, () => console.log("Proxy running on " + serverUrl));

setInterval(saveSessions, 30000);

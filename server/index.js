import express from "express";
import MarkdownIt from "markdown-it";
import sanitize from "sanitize-html";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp(root = path.join(base, "demo-vault")) {
  const app = express();
  let notes = [];
  const md = new MarkdownIt({ html: false });
  // Parse wiki links as inline tokens, leaving fenced and inline code intact.
  md.inline.ruler.before("link", "wiki", (state, silent) => {
    const start = state.pos;
    if (
      state.src.slice(start, start + 2) !== "[[" ||
      state.src[start - 1] === "!"
    )
      return false;
    const end = state.src.indexOf("]]", start + 2);
    if (end < 0) return false;
    if (!silent) {
      const [destination, alias] = state.src.slice(start + 2, end).split("|");
      const token = state.push("link_open", "a", 1);
      token.attrSet("href", destination);
      state.push("text", "", 0).content = alias || destination;
      state.push("link_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });
  md.core.ruler.after("inline", "tasks", (state) => {
    for (let i = 2; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (
        token.type !== "inline" ||
        state.tokens[i - 2].type !== "list_item_open"
      )
        continue;
      const first = token.children?.[0];
      if (first?.type === "text")
        first.content = first.content.replace(/^\[([ xX])\]/, (_, check) =>
          check === " " ? "☐" : "☑",
        );
    }
  });
  async function safe(name) {
    if (
      typeof name !== "string" ||
      !name ||
      name.includes("\\") ||
      name.includes("\0") ||
      path.isAbsolute(name) ||
      name.split("/").some((x) => !x || x.startsWith("."))
    )
      throw Error("无效路径");
    let current = root;
    if ((await fs.lstat(root)).isSymbolicLink()) throw Error("无效目录");
    for (const part of name.split("/")) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink())
        throw Error("不支持符号链接");
    }
    return current;
  }
  async function content(name) {
    if (!name.endsWith(".md")) throw Error("仅支持笔记");
    const f = await safe(name);
    if ((await fs.stat(f)).size > 2 * 1024 * 1024) throw Error("笔记超过 2 MB");
    return (await fs.readFile(f, "utf8")).replace(
      /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
      "",
    );
  }
  async function scan(dir = "") {
    let all = [];
    for (const e of await fs.readdir(path.join(root, dir), {
      withFileTypes: true,
    })) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const n = dir ? dir + "/" + e.name : e.name;
      if (e.isDirectory()) all.push(...(await scan(n)));
      else if (e.isFile() && n.endsWith(".md")) {
        try {
          all.push({
            path: n,
            title: e.name.slice(0, -3),
            text: await content(n),
          });
        } catch {}
      }
    }
    return all;
  }
  function resolve(target, source) {
    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      return null;
    }
    const [file] = decoded.split("#");
    const relative = path.posix.normalize(
      path.posix.join(path.posix.dirname(source), file),
    );
    const candidates = [relative, file].flatMap((x) => [x, x + ".md"]);
    let found = notes.find((n) => candidates.includes(n.path));
    if (found) return found.path;
    const matches = notes.filter((n) => n.title === file.replace(/\.md$/, ""));
    return matches.length === 1 ? matches[0].path : null;
  }
  md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
    const t = tokens[i],
      href = t.attrGet("href") || "";
    if (/^https?:\/\//i.test(href)) {
      t.attrSet("rel", "noopener noreferrer");
      t.attrSet("target", "_blank");
    } else {
      const found = resolve(href, env.source);
      t.attrSet("href", found ? "?note=" + encodeURIComponent(found) : "#");
      if (!found)
        t.attrSet("title", "笔记不存在或名称不唯一，请使用完整相对路径");
    }
    return self.renderToken(tokens, i, opts);
  };
  md.renderer.rules.image = (tokens, i, opts, env) => {
    const src = tokens[i].attrGet("src") || "";
    if (/^[a-z]+:|^\/\//i.test(src)) return "<span>外部图片未加载</span>";
    let n;
    try {
      n = path.posix.normalize(
        path.posix.join(
          path.posix.dirname(env.source),
          decodeURIComponent(src),
        ),
      );
    } catch {
      return "图片地址无效";
    }
    return (
      '<img loading="lazy" alt="笔记图片" src="/api/asset?path=' +
      encodeURIComponent(n) +
      '">'
    );
  };
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'self'",
    );
    if (!["GET", "HEAD"].includes(req.method)) return res.sendStatus(405);
    next();
  });
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch {
      res.status(404).json({ error: "内容不存在、不可访问或超出限制" });
    }
  };
  app.get("/api/vault", (q, s) =>
    s.json({ name: path.basename(root), location: "./" + path.basename(root) }),
  );
  app.get("/api/health", (q, s) =>
    s.json({ status: "ok", app: "obsidian-demo-reader" }),
  );
  app.get(
    "/api/library",
    wrap(async (q, s) => {
      notes = await scan();
      s.json(notes.map(({ text, ...n }) => n));
    }),
  );
  app.get(
    "/api/search",
    wrap(async (q, s) => {
      const query = String(q.query.q || "")
        .slice(0, 200)
        .toLowerCase();
      const result = query
        ? notes
            .filter((n) =>
              (n.title + " " + n.text).toLowerCase().includes(query),
            )
            .sort(
              (a, b) =>
                Number(b.title.toLowerCase().includes(query)) -
                Number(a.title.toLowerCase().includes(query)),
            )
            .slice(0, 100)
        : [];
      s.json(
        result.map((n) => {
          const pos = n.text.toLowerCase().indexOf(query);
          return {
            path: n.path,
            title: n.title,
            excerpt: n.text.slice(
              Math.max(0, pos - 30),
              Math.max(0, pos - 30) + 130,
            ),
          };
        }),
      );
    }),
  );
  app.get(
    "/api/note",
    wrap(async (q, s) => {
      const source = q.query.path;
      let text = await content(source);
      const html = sanitize(md.render(text, { source }), {
        allowedTags: sanitize.defaults.allowedTags.concat(["img"]),
        allowedAttributes: {
          ...sanitize.defaults.allowedAttributes,
          a: ["href", "title", "target", "rel"],
          img: ["src", "alt", "loading"],
        },
        allowedSchemes: ["http", "https"],
      });
      s.json({ path: source, title: path.basename(source, ".md"), html });
    }),
  );
  app.get(
    "/api/asset",
    wrap(async (q, s) => {
      const n = q.query.path;
      if (typeof n !== "string" || !/\.(png|jpe?g|webp)$/i.test(n))
        throw Error();
      s.sendFile(await safe(n));
    }),
  );
  app.use(
    express.static(path.join(base, "public"), {
      dotfiles: "deny",
      etag: false,
    }),
  );
  app.use((q, s) => s.status(404).json({ error: "不存在" }));
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp()
    .listen(4317, "127.0.0.1", () =>
      console.log("笔记随行：http://127.0.0.1:4317"),
    )
    .on("error", () => {
      console.error("无法启动：请检查 4317 端口是否被占用。");
      process.exit(1);
    });
}

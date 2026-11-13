import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
test("阅读、更新、搜索与隔离", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reader-"));
  const root = path.join(tmp, "vault");
  await fs.mkdir(root);
  await fs.writeFile(path.join(tmp, "secret.md"), "SECRET");
  await fs.writeFile(
    path.join(root, "中文 笔记.md"),
    "---\ntitle: hidden\n---\n# 中文\n\nneedle\n<script>alert(1)</script>\n![x](https://example.com/x.png)",
  );
  await fs.mkdir(path.join(root, ".hidden"));
  await fs.writeFile(path.join(root, ".hidden", "x.md"), "PRIVATE");
  await fs.symlink(path.join(tmp, "secret.md"), path.join(root, "link.md"));
  const server = createApp(root).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const get = (url) => fetch(base + url);
  try {
    const vault = await (await get("/api/vault")).json();
    assert.deepEqual(vault, { name: "vault", location: "./vault" });
    let r = await get("/api/library");
    assert.equal((await r.json()).length, 1);
    r = await get("/api/note?path=" + encodeURIComponent("中文 笔记.md"));
    let n = await r.json();
    assert.match(n.html, /needle/);
    assert.doesNotMatch(n.html, /<script|src="https|title: hidden/);
    for (const s of [
      "../secret.md",
      "link.md",
      ".hidden/x.md",
      "/etc/passwd",
      "%2e%2e/secret.md",
    ]) {
      r = await get("/api/note?path=" + encodeURIComponent(s));
      assert.equal(r.status, 404);
    }
    r = await get("/server/index.js");
    assert.equal(r.status, 404);
    r = await fetch(base + "/api/library", { method: "POST" });
    assert.equal(r.status, 405);
    await fs.writeFile(path.join(root, "新增.md"), "# 新增\n新关键词");
    await get("/api/library");
    r = await get("/api/search?q=" + encodeURIComponent("新关键词"));
    assert.equal((await r.json())[0].title, "新增");
    await fs.unlink(path.join(root, "新增.md"));
    await get("/api/library");
    r = await get("/api/note?path=" + encodeURIComponent("新增.md"));
    assert.equal(r.status, 404);
    assert.equal(
      await fs.readFile(path.join(tmp, "secret.md"), "utf8"),
      "SECRET",
    );
  } finally {
    server.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("真实演示仓库只读、图片、内部链接和代码展示", async () => {
  const root = new URL("../demo-vault/", import.meta.url);
  const before = await fs.readFile(new URL("AI 工具/本地服务是什么.md", root));
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const library = await (await fetch(base + "/api/library")).json();
    assert.ok(library.some((note) => note.path === "AI 工具/本地服务是什么.md"));
    for (const n of library) {
      const r = await fetch(
        base + "/api/note?path=" + encodeURIComponent(n.path),
      );
      assert.equal(r.status, 200);
      const body = await r.json();
      if (n.path === "AI 工具/本地服务是什么.md") {
        assert.match(body.html, /<h1>本地服务是什么<\/h1>/);
        assert.match(body.html, /href="\?note=/);
        assert.match(body.html, /<pre><code>/);
      }
    }
    const img = await fetch(
      base + "/api/asset?path=" + encodeURIComponent("附件/连接示意.png"),
    );
    assert.equal(img.status, 200);
    assert.match(img.headers.get("content-type"), /image\/png/);
    assert.deepEqual(
      await fs.readFile(new URL("AI 工具/本地服务是什么.md", root)),
      before,
    );
  } finally {
    server.close();
  }
});

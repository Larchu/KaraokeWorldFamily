import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { getDb } from "./server/db.ts";
import { createExpressApp } from "./server/app.ts";

async function startServer() {
  const port = Number(process.env["PORT"] ?? 3000);
  const isProd = process.env["NODE_ENV"] === "production";
  const db = await getDb();
  const app = createExpressApp(db);

  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("*", async (_req, res) => {
      const html = await fs.readFile(path.join(distDir, "index.html"), "utf-8");
      res.status(200).set({ "Content-Type": "text/html; charset=utf-8" }).send(html);
    });
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`[karaoke-server] listening on http://0.0.0.0:${port} (db=${db.kind})`);
  });
}

startServer().catch((err) => {
  console.error("[karaoke-server] failed to start:", err);
  process.exit(1);
});

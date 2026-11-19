import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: webRoot,
  encoding: "utf8",
}).trim();

export default defineConfig({
  root: "apps/web",
  plugins: [
    react(),
    {
      name: "site-routes",
      transformIndexHtml(html) {
        return html.replaceAll("__GEOCHALK_REVISION__", revision);
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? "/").split("?")[0];
          if (path === "/about" || path === "/about/") {
            req.url = "/about.html" + (req.url ?? "").slice(path.length);
            return next();
          }
          if (!/^\/q[a-zA-Z0-9_]*/.test(path)) return next();
          console.log(
            JSON.stringify({ event: "qr_page_turn", path, method: req.method }),
          );
          res.writeHead(302, { location: "/", "cache-control": "no-store" });
          res.end();
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/config.json": "http://127.0.0.1:3001",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        about: fileURLToPath(new URL("about.html", import.meta.url)),
      },
    },
  },
});
